import { ownerDecision } from "@/lib/agent";
import { getWorkspace, mutateWorkspace } from "@/lib/workspace";
import { HttpError } from "@/lib/session";
import type { ListingDraft, OwnerPolicy, SimulationResult } from "@/lib/types";
export type { InboxState } from "@/lib/workspace";
export async function getInbox(sessionId: string) { return (await getWorkspace(sessionId)).inbox; }
export async function saveSimulation(sessionId: string, simulation: SimulationResult, listing: ListingDraft, policy: OwnerPolicy, sellId: string) {
  return (await mutateWorkspace(sessionId, state => {
    if (state.sell?.id !== sellId || !state.sell.approved) throw new HttpError(409, "The listing changed. Review it before rerunning the market.");
    if (state.inbox.cards.some(c => c.status === "accepted")) throw new HttpError(409, "This item is already reserved.");
    state.inbox = { cards: simulation.dealCards, messages: simulation.messages, listing, policy, simulation };
    return state.inbox;
  })).result;
}
export async function decideCard(sessionId: string, cardId: string, decision: "yes" | "no") {
  return (await mutateWorkspace(sessionId, state => {
    const current = state.inbox; const card = current.cards.find(c => c.id === cardId);
    if (!card) return null;
    if (card.status !== "pending" || (decision === "yes" && current.cards.some(c => c.status === "accepted"))) return { conflict: true as const, card };
    card.status = decision === "yes" ? "accepted" : "declined";
    if (decision === "yes") {
      for (const other of current.cards) if (other.id !== card.id && other.status === "pending") other.status = "closed";
      if (state.sell) state.sell.ownerPolicy.availability = "reserved";
    }
    const message = ownerDecision(card, decision); current.messages.push(message);
    // JSON persistence does not preserve shared object references.
    if (current.simulation) { current.simulation.dealCards = current.cards; current.simulation.messages = current.messages; }
    return { conflict: false as const, card, message };
  })).result;
}
