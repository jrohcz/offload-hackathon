import { randomUUID } from "node:crypto";
import { getWorkspace, mutateWorkspace } from "@/lib/workspace";
import { evaluateOffer } from "@/lib/find-evaluation";
import { HttpError } from "@/lib/session";
import type { FindOffer, FindRequest, ListingDraft } from "@/lib/types";
export type FindState = { requests: FindRequest[]; offers: FindOffer[] };
export async function getFindState(sessionId: string) { return (await getWorkspace(sessionId)).find; }
export async function createFindRequest(sessionId: string, input: { need: string; budget: number | null; currency: string; mustWork: boolean }): Promise<FindRequest> {
  const request = { id: randomUUID(), ...input, need: input.need.trim(), currency: input.currency.toUpperCase() };
  await mutateWorkspace(sessionId, state => { if (state.find.requests.length >= 25) throw new HttpError(429, "This demo session supports 25 needs."); state.find.requests.unshift(request); });
  return request;
}
export async function qualifyOffer(sessionId: string, request: FindRequest, sellerMessage: string, listing: ListingDraft | null): Promise<FindOffer> {
  const evaluated = await evaluateOffer(request, sellerMessage, listing);
  const offer: FindOffer = { ...evaluated, id: randomUUID(), requestId: request.id, sellerMessage, createdAt: new Date().toISOString(), card: evaluated.status === "qualified" ? { id: randomUUID(), buyer: "Seller", price: evaluated.price, currency: evaluated.currency, pickupSlot: evaluated.pickupSlot, summary: `${evaluated.itemTitle || "Matching offer"} — ${evaluated.currency} ${evaluated.price}.`, question: `Accept this offer at ${evaluated.currency} ${evaluated.price}?`, status: "pending" } : null };
  await mutateWorkspace(sessionId, state => {
    if (!state.find.requests.some(r => r.id === request.id)) throw new HttpError(404, "Need not found in this session");
    if (state.find.offers.some(o => o.requestId === request.id && o.card?.status === "accepted")) throw new HttpError(409, "This need is already fulfilled.");
    if (state.find.offers.length >= 80) throw new HttpError(429, "This demo session supports 80 offers.");
    state.find.offers.unshift(offer);
  });
  return offer;
}
export async function decideFindCard(sessionId: string, cardId: string, decision: "yes" | "no") {
  return (await mutateWorkspace(sessionId, state => {
    const offer = state.find.offers.find(o => o.card?.id === cardId); if (!offer?.card) return null;
    if (offer.card.status !== "pending" || (decision === "yes" && state.find.offers.some(o => o.requestId === offer.requestId && o.card?.status === "accepted"))) return { conflict: true as const, offer };
    offer.card.status = decision === "yes" ? "accepted" : "declined";
    if (decision === "yes") for (const other of state.find.offers) if (other.requestId === offer.requestId && other.id !== offer.id && other.card?.status === "pending") other.card.status = "closed";
    return { conflict: false as const, offer };
  })).result;
}
