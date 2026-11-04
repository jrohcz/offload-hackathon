import { NextRequest } from "next/server";
import { runSimulation } from "@/lib/agent";
import { saveSimulation } from "@/lib/inbox";
import { getWorkspace } from "@/lib/workspace";
import { apiError, requireSession, json, HttpError, paidOperation, limitedJson } from "@/lib/session";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: NextRequest) {
  try {
    const sid = requireSession(request, true); await limitedJson(request);
    return json(await paidOperation(request, sid, async () => {
      const state = await getWorkspace(sid); const sell = state.sell;
      if (!sell?.approved) throw new HttpError(409, "Review and approve your saved listing first.");
      if (state.inbox.cards.some(c => c.status === "accepted")) throw new HttpError(409, "This item is already reserved.");
      const result = await runSimulation(sell.listing, sell.ownerPolicy);
      await saveSimulation(sid, result, sell.listing, sell.ownerPolicy, sell.id); return result;
    }));
  } catch (error) { return apiError(error); }
}
