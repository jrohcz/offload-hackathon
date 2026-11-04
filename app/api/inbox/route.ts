import { NextRequest } from "next/server";
import { decideCard, getInbox } from "@/lib/inbox";
import { apiError, requireSession, json, HttpError, limitedJson, paidOperation } from "@/lib/session";
import { decisionInput } from "@/lib/api-schema";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) { try { return json(await getInbox(requireSession(request))); } catch (e) { return apiError(e); } }
export async function POST(request: NextRequest) {
  try {
    const sid = requireSession(request, true); const body = decisionInput.parse(await limitedJson(request));
    const result = await paidOperation(request, sid, () => decideCard(sid, body.cardId, body.decision), false);
    if (!result) throw new HttpError(404, "Deal card not found in this session");
    return json({ ...result, error: result.conflict ? "Deal was already decided or item reserved" : undefined, inbox: await getInbox(sid) }, result.conflict ? 409 : 200);
  } catch (e) { return apiError(e); }
}
