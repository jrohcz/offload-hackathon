import { NextRequest } from "next/server";
import { z } from "zod";
import { createFindRequest, decideFindCard, getFindState, qualifyOffer } from "@/lib/find";
import { identifyListing } from "@/lib/meta/spark";
import { normalizePipelineInput, ImageInputError } from "@/lib/pipeline";
import { apiError, requireSession, json, HttpError, paidOperation } from "@/lib/session";
import type { ListingDraft } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
export async function GET(request: NextRequest) { try { return json(await getFindState(requireSession(request))); } catch (e) { return apiError(e); } }
export async function POST(request: NextRequest) {
  try {
    const sid = requireSession(request, true);
    if (Number(request.headers.get("content-length")) > 4_000_000) throw new HttpError(413, "Please use a smaller photo.");
    const form = await request.formData(); const action = String(form.get("action") || "request");
    if (action === "decide") {
      const cardId = z.string().min(1).max(100).parse(form.get("cardId")); const decision = z.enum(["yes", "no"]).parse(form.get("decision"));
      const result = await paidOperation(request, sid, () => decideFindCard(sid, cardId, decision), false);
      if (!result) throw new HttpError(404, "Offer not found in this session");
      return json({ ...result, error: result.conflict ? "Offer was already decided or need fulfilled" : undefined, find: await getFindState(sid) }, result.conflict ? 409 : 200);
    }
    if (action === "request") {
      const need = z.string().trim().min(3).max(1000).parse(String(form.get("need") || ""));
      const raw = String(form.get("budget") || "").trim();
      const budget = raw ? z.number().finite().nonnegative().max(1000000).parse(Number(raw.replace(",", "."))) : null;
      const currency = z.enum(["EUR", "USD", "GBP", "CZK", "PLN"]).parse(form.get("currency") || "EUR");
      const mustWork = String(form.get("mustWork")) === "true";
      const created = await paidOperation(request, sid, () => createFindRequest(sid, { need, budget, currency, mustWork }), false);
      return json({ request: created, find: await getFindState(sid) });
    }
    if (action === "offer") {
      const target = (await getFindState(sid)).requests.find(r => r.id === String(form.get("requestId")));
      if (!target) throw new HttpError(404, "Need not found in this session");
      const message = z.string().trim().min(3).max(5000).parse(String(form.get("sellerMessage") || ""));
      const photo = form.get("photo");
      if (photo instanceof File && photo.size > 3_500_000) throw new HttpError(413, "Please use a photo under 3.5 MB.");
      const offer = await paidOperation(request, sid, async () => {
        let listing: ListingDraft | null = null;
        if (photo instanceof File && photo.size) { const image = await normalizePipelineInput(Buffer.from(await photo.arrayBuffer())); listing = (await identifyListing(image, "image/png")).listing; }
        return qualifyOffer(sid, target, message, listing);
      });
      return json({ offer, find: await getFindState(sid) });
    }
    throw new HttpError(400, "Unknown action");
  } catch (error) { if (error instanceof ImageInputError) return json({ error: error.message }, 400); return apiError(error); }
}
