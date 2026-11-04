import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { getWorkspace, mutateWorkspace, type SavedSell } from "@/lib/workspace";
import { getInbox, saveSimulation, decideCard } from "@/lib/inbox";
import { createFindRequest, decideFindCard, getFindState, qualifyOffer } from "@/lib/find";
import { csrfFor, initializeSession, requireSession, sessionFromCookie } from "@/lib/session";
import { GET as getSession } from "@/app/api/session/route";
import { GET as getSell, PATCH as patchSell } from "@/app/api/sell/route";
import { GET as getInboxRoute, POST as postInbox } from "@/app/api/inbox/route";
import { POST as postSimulation } from "@/app/api/simulation/route";
import { POST as postFind } from "@/app/api/find/route";
import type { DealCard, SimulationResult } from "@/lib/types";

const databasePath = path.join(mkdtempSync(path.join(tmpdir(), "offload-session-unit-")), "test.db");
const origin = "http://localhost:3000";
type TestSession = ReturnType<typeof initializeSession>;
let owner: TestSession;
let visitor: TestSession;

function request(route: string, session?: TestSession, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (session) {
    headers.set("cookie", `offload_session=${session.cookie}`);
    if (!headers.has("x-offload-csrf")) headers.set("x-offload-csrf", csrfFor(session.id));
  }
  return new NextRequest(`${origin}${route}`, { ...init, headers });
}
function fixture(): SavedSell {
  return {
    id: "sell-version-1", mode: "mock", approved: true, samplePhoto: true, voice: null,
    segmentation: { status: "ok", maskCount: 1 },
    originalDataUrl: "sample", cutoutDataUrl: "sample", heroDataUrl: "sample",
    condition: { defects: [], overlayDataUrl: "sample" },
    listing: {
      title: "Turntable", category: "Electronics", condition: "Used", description: "Turntable with a cracked cover.", brand: null, model: null,
      facts_confirmed: ["A turntable is visible"], facts_unknown: ["Working condition"], questions_for_owner: ["Does it work?"], sam_concept: "turntable",
      priceSuggestion: { range: null, quick_sale: null, currency: "EUR", sources: [] },
    },
    ownerPolicy: { minPrice: null, currency: "EUR", pickupOnly: true, pickupWindows: [], availability: "available", facts: [] },
  };
}
function card(id: string): DealCard {
  return { id, buyer: `Buyer ${id}`, price: 120, currency: "EUR", pickupSlot: "Saturday 10:00", summary: "EUR 120, pickup Saturday 10:00", question: "Accept?", status: "pending" };
}
async function seed(sessionId: string, cards = [card("offer-a"), card("offer-b")]) {
  const sell = fixture();
  await mutateWorkspace(sessionId, state => { state.sell = sell; });
  const simulation: SimulationResult = { mode: "mock", dealCards: cards, messages: [], metrics: { handledByAgent: 2, humanRead: cards.length }, personas: [] };
  await saveSimulation(sessionId, simulation, sell.listing, sell.ownerPolicy, sell.id);
  return sell;
}

beforeEach(() => {
  // Never connect unit tests to a developer/prod database or spend API credits.
  delete process.env.DATABASE_URL; delete process.env.VERCEL; delete process.env.MODEL_API_KEY;
  process.env.OFFLOAD_DB_PATH = databasePath; process.env.OFFLOAD_MOCK = "1";
  process.env.OFFLOAD_SESSION_SECRET = "unit-tests-only-not-a-deployment-key";
  owner = initializeSession(request("/api/session"));
  visitor = initializeSession(request("/api/session"));
});

describe("session-scoped durable workspace", () => {
  it("isolates two visitors' listings, inboxes, needs and decisions", async () => {
    const sell = await seed(owner.id);
    await createFindRequest(owner.id, { need: "Working bicycle", budget: 100, currency: "EUR", mustWork: true });
    expect((await getWorkspace(owner.id)).sell?.id).toBe(sell.id);
    expect((await getWorkspace(visitor.id)).sell).toBeNull();
    expect((await getInbox(visitor.id)).cards).toEqual([]);
    expect((await getFindState(visitor.id)).requests).toEqual([]);
    expect(await decideCard(visitor.id, "offer-a", "yes")).toBeNull();
    expect((await getInbox(owner.id)).cards.every(c => c.status === "pending")).toBe(true);
  });

  it("readback is persisted on disk, not a shared mutable process object", async () => {
    await seed(owner.id);
    const first = await getWorkspace(owner.id);
    first.sell!.listing.title = "not persisted";
    expect((await getWorkspace(owner.id)).sell!.listing.title).toBe("Turntable");
    await decideCard(owner.id, "offer-a", "yes");
    const independentConnection = new Database(databasePath, { readonly: true });
    try {
      const row = independentConnection.prepare("SELECT data FROM offload_state WHERE key = ?").get(`${owner.id}:workspace`) as { data: string };
      const stored = JSON.parse(row.data);
      expect(stored.inbox.cards.find((c: DealCard) => c.id === "offer-a").status).toBe("accepted");
      expect(stored.inbox.simulation.dealCards).toEqual(stored.inbox.cards);
      expect(stored.sell.ownerPolicy.availability).toBe("reserved");
    } finally { independentConnection.close(); }
  });

  it("CAS permits one winner when two buyers are accepted concurrently", async () => {
    await seed(owner.id);
    const results = await Promise.all([decideCard(owner.id, "offer-a", "yes"), decideCard(owner.id, "offer-b", "yes")]);
    expect(results.filter(result => result && !result.conflict)).toHaveLength(1);
    expect(results.filter(result => result?.conflict)).toHaveLength(1);
    const inbox = await getInbox(owner.id);
    expect(inbox.cards.filter(c => c.status === "accepted")).toHaveLength(1);
    expect(inbox.cards.filter(c => c.status === "closed")).toHaveLength(1);
    expect(inbox.messages).toHaveLength(1);
    const winner = inbox.cards.find(c => c.status === "accepted")!;
    expect((await decideCard(owner.id, winner.id, "no"))?.conflict).toBe(true);
    expect((await getInbox(owner.id)).cards.find(c => c.id === winner.id)?.status).toBe("accepted");
  });

  it("Find also atomically accepts only one offer per need", async () => {
    const findRequest = await createFindRequest(owner.id, { need: "Working turntable", budget: 150, currency: "EUR", mustWork: true });
    const first = await qualifyOffer(owner.id, findRequest, "Turntable works well, EUR 120, pickup Saturday 10:00", null);
    const second = await qualifyOffer(owner.id, findRequest, "Turntable works well, EUR 130, pickup Saturday 11:00", null);
    expect(first.status).toBe("qualified"); expect(second.status).toBe("qualified");
    expect(await decideFindCard(visitor.id, first.card!.id, "yes")).toBeNull();
    const decisions = await Promise.all([decideFindCard(owner.id, first.card!.id, "yes"), decideFindCard(owner.id, second.card!.id, "yes")]);
    expect(decisions.filter(decision => decision && !decision.conflict)).toHaveLength(1);
    const offers = (await getFindState(owner.id)).offers;
    expect(offers.filter(o => o.card?.status === "accepted")).toHaveLength(1);
    expect(offers.filter(o => o.card?.status === "closed")).toHaveLength(1);
  });
});

describe("session and route contract", () => {
  it("bootstraps a private HttpOnly cookie and stable CSRF token", async () => {
    const response = await getSession(request("/api/session"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.mode).toBe("mock");
    const cookie = response.cookies.get("offload_session")!;
    expect(cookie.httpOnly).toBe(true); expect(cookie.sameSite).toBe("strict");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const id = sessionFromCookie(cookie.value)!;
    expect(body.csrfToken).toBe(csrfFor(id));
    const reused = initializeSession(new NextRequest(`${origin}/api/session`, { headers: { cookie: `offload_session=${cookie.value}` } }));
    expect(reused.id).toBe(id); expect(reused.existing).toBe(true);
  });

  it("rejects a forged session, missing CSRF, other session CSRF and cross-site origin", async () => {
    const forgedCookie = owner.cookie.slice(0, -1) + (owner.cookie.endsWith("a") ? "b" : "a");
    expect(() => requireSession(request("/api/inbox", undefined, { headers: { cookie: `offload_session=${forgedCookie}` } }))).toThrow("expired");
    const missing = request("/api/inbox", owner, { method: "POST" }); missing.headers.delete("x-offload-csrf");
    expect(() => requireSession(missing, true)).toThrow("Session verification failed");
    expect(() => requireSession(request("/api/inbox", owner, { method: "POST", headers: { "x-offload-csrf": csrfFor(visitor.id) } }), true)).toThrow("Session verification failed");
    expect(() => requireSession(request("/api/inbox", owner, { method: "POST", headers: { origin: "https://unrelated.example" } }), true)).toThrow("Cross-site request rejected");
    expect(requireSession(request("/api/inbox", owner, { method: "POST", headers: { origin } }), true)).toBe(owner.id);
  });

  it("non-ASCII forged signatures and CSRF tokens fail cleanly, not with a buffer exception", async () => {
    const parts = owner.cookie.split("."); parts[2] = "é".repeat(64);
    expect(sessionFromCookie(parts.join("."))).toBeNull();
    expect(() => requireSession(request("/api/inbox", owner, { method: "POST", headers: { "x-offload-csrf": "é".repeat(64) } }), true)).toThrow("Session verification failed");
  });

  it("GET/PATCH Sell use {sell}, persist approval and do not expose raw model output", async () => {
    const sell = await seed(owner.id);
    expect((await getSell(request("/api/sell"))).status).toBe(401);
    expect(await (await getSell(request("/api/sell", visitor))).json()).toEqual({ sell: null });
    const updated = { ...sell.listing, facts_confirmed: [...sell.listing.facts_confirmed, "Owner answer — Does it work?: No"] };
    const response = await patchSell(request("/api/sell", owner, { method: "PATCH", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ listing: updated, ownerPolicy: sell.ownerPolicy, approved: false }) }));
    expect(response.status).toBe(200);
    const saved = (await response.json()).sell;
    expect(saved.approved).toBe(false); expect(saved.listing.facts_confirmed).toContain("Owner answer — Does it work?: No");
    expect(saved.raw).toBeUndefined();
    expect((await (await getSell(request("/api/sell", owner))).json()).sell).toEqual(saved);
    expect((await getInbox(owner.id)).cards).toEqual([]);
  });

  it("inbox routes expose own state and reject foreign/repeated decisions", async () => {
    await seed(owner.id);
    const foreign = await postInbox(request("/api/inbox", visitor, { method: "POST", body: JSON.stringify({ action: "decide", cardId: "offer-a", decision: "yes" }) }));
    expect(foreign.status).toBe(404);
    const accepted = await postInbox(request("/api/inbox", owner, { method: "POST", body: JSON.stringify({ action: "decide", cardId: "offer-a", decision: "yes" }) }));
    expect(accepted.status).toBe(200); expect((await accepted.json()).inbox.cards[0].status).toBe("accepted");
    const repeated = await postInbox(request("/api/inbox", owner, { method: "POST", body: JSON.stringify({ action: "decide", cardId: "offer-a", decision: "no" }) }));
    expect(repeated.status).toBe(409);
    const readback = await getInboxRoute(request("/api/inbox", owner));
    expect((await readback.json()).cards[0].status).toBe("accepted");
  });

  it("malformed simulation payload and unapproved saved listing cannot start a market", async () => {
    const invalid = await postSimulation(request("/api/simulation", owner, { method: "POST", body: "{invalid-json" }));
    expect(invalid.status).toBe(400);
    const unapproved = fixture(); unapproved.approved = false;
    await mutateWorkspace(owner.id, state => { state.sell = unapproved; });
    const denied = await postSimulation(request("/api/simulation", owner, { method: "POST", body: JSON.stringify({ listing: unapproved.listing, approved: true }) }));
    expect(denied.status).toBe(409);
    expect((await getInbox(owner.id)).cards).toEqual([]);
  });

  it("Find route returns {request,find}, scoped to the signed session", async () => {
    const form = new FormData(); form.set("action", "request"); form.set("need", "Working bicycle"); form.set("currency", "EUR"); form.set("budget", "100"); form.set("mustWork", "true");
    const response = await postFind(request("/api/find", owner, { method: "POST", body: form }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.request.need).toBe("Working bicycle"); expect(body.find.requests).toHaveLength(1);
    expect((await getFindState(visitor.id)).requests).toEqual([]);
  });
});
