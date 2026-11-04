import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runSellPipeline, SegmentationError, ImageInputError } from "@/lib/pipeline";
import { transcribeVoice } from "@/lib/meta/voice";
import { extractOwnerPolicy } from "@/lib/meta/spark";
import { reconcileOwnerFacts } from "@/lib/owner-facts";
import { apiError, requireSession, json, HttpError, paidOperation, limitedJson } from "@/lib/session";
import { getWorkspace, mutateWorkspace, emptyInbox, type SavedSell } from "@/lib/workspace";
import { listingInput, policyInput } from "@/lib/api-schema";
import type { OwnerPolicy } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  try { return json({ sell: (await getWorkspace(requireSession(request))).sell }); } catch (error) { return apiError(error); }
}
export async function PATCH(request: NextRequest) {
  try {
    const sid = requireSession(request, true);
    const input = z.object({ listing: listingInput, ownerPolicy: policyInput, approved: z.boolean() }).parse(await limitedJson(request));
    const result = await paidOperation(request, sid, async () => mutateWorkspace(sid, state => {
      if (!state.sell) throw new HttpError(404, "Build a listing first");
      if (state.inbox.cards.some(c => c.status === "accepted")) throw new HttpError(409, "This listing is already reserved.");
      state.sell.listing = input.listing; state.sell.ownerPolicy = input.ownerPolicy; state.sell.approved = input.approved;
      state.inbox = emptyInbox(); return state.sell;
    }), false);
    return json({ sell: result.result });
  } catch (error) { return apiError(error); }
}
export async function POST(request: NextRequest) {
  try {
    const sid = requireSession(request, true);
    if (Number(request.headers.get("content-length")) > 4_400_000) throw new HttpError(413, "Please use a smaller photo/voice recording (under 4 MB combined).");
    const form = await request.formData(); const file = form.get("photo"); const voice = form.get("voice");
    if (file instanceof File && file.size > 3_500_000) throw new HttpError(413, "Please use a photo under 3.5 MB.");
    if (voice instanceof File && (voice.size > 1_500_000 || voice.size === 0)) throw new HttpError(413, "Please use a short WAV recording under 1.5 MB.");
    const voiceBytes = voice instanceof File ? Buffer.from(await voice.arrayBuffer()) : null;
    if (voiceBytes && (voiceBytes.toString("ascii", 0, 4) !== "RIFF" || voiceBytes.toString("ascii", 8, 12) !== "WAVE")) throw new HttpError(400, "Upload a WAV recording or use Record 10s note.");
    const samplePhoto = !(file instanceof File);
    const bytes = file instanceof File ? Buffer.from(await file.arrayBuffer()) : await readFile(path.join(process.cwd(), "fixtures/real/generated-used-turntable.webp"));
    const sell = await paidOperation(request, sid, async () => {
      const result = await runSellPipeline(bytes, file instanceof File ? file.type : "image/webp");
      let transcript: string | undefined;
      let policy: OwnerPolicy = { minPrice: null, currency: "EUR", pickupOnly: true, pickupWindows: [], availability: "available", facts: [] };
      if (voiceBytes && voice instanceof File) { const v = await transcribeVoice(voiceBytes, voice.name); transcript = String(v.result.transcript ?? ""); policy = (await extractOwnerPolicy(transcript)).policy; }
      const { raw, ...publicResult } = result;
      const saved: SavedSell = { ...publicResult, listing: reconcileOwnerFacts(publicResult.listing, policy), id: randomUUID(), ownerPolicy: policy, voice: transcript ? { transcript } : null, approved: false, samplePhoto };
      await mutateWorkspace(sid, state => { state.sell = saved; state.inbox = emptyInbox(); }); return saved;
    });
    return json(sell);
  } catch (error) {
    if (error instanceof SegmentationError) return json({ error: error.message, segmentation: "failed" }, 422);
    if (error instanceof ImageInputError) return json({ error: error.message }, 400);
    return apiError(error);
  }
}
