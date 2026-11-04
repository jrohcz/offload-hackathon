import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeOwnerPolicy } from "@/lib/meta/spark";
import { parseOfferMoney, pickupEvidence, workingEvidence } from "@/lib/evidence";
import { AGENT_TOOLS, canonicalFact, handleCounterpartMessage, ownerDecision } from "@/lib/agent";
import { parseGroundedPriceResponse } from "@/lib/meta/search";
import type { ListingDraft, OwnerPolicy } from "@/lib/types";

const mock = vi.hoisted(() => ({ mode: "mock", create: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/meta/client")>(),
  getMode: () => mock.mode,
  getClient: () => ({ responses: { create: mock.create } }),
  logCall: mock.log,
}));
const listing: ListingDraft = { title: "Turntable", category: "Electronics", condition: "Used", description: "Turntable", brand: null, model: null, facts_confirmed: ["It works.", "The dust cover has a crack."], facts_unknown: ["Bluetooth"], questions_for_owner: ["Does it have Bluetooth?"], sam_concept: "turntable", priceSuggestion: { range: [5000, 7000], quick_sale: 5500, currency: "CZK", sources: [] } };
const policy: OwnerPolicy = { minPrice: 80, currency: "EUR", pickupOnly: true, pickupWindows: ["Saturday 10:00"], availability: "available", facts: [] };
const message = "I offer EUR 120 and can pick up Saturday at 10:00.";
const askCard = { buyer: "Buyer", price: 999, currency: "USD", pickupSlot: "Sunday", reason: "Qualified", question: "Accept?" };
function response(name: string, args: unknown, id = name) { return { id, usage: { input_tokens: 100, output_tokens: 50 }, output: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }] }; }

beforeEach(() => { mock.mode = "mock"; mock.create.mockReset(); mock.log.mockReset(); });

describe("conservative money and pickup evidence", () => {
  it.each([
    ["GBP 95", 95, "GBP"], ["EUR 1,200", 1200, "EUR"], ["2 800 Kč", 2800, "CZK"], ["CZK 2.800,50", 2800.5, "CZK"], ["EUR 0", 0, "EUR"],
  ])("preserves %s", (text, amount, currency) => expect(parseOfferMoney(text as string)).toMatchObject({ status: "known", amount, currency }));
  it.each(["Was EUR 50, asking EUR 120", "EUR 80-120", "EUR 80 plus shipping", "EUR -80", "EUR 120 or USD 120", "EUR 2,34,56"])("does not invent one total from %s", (text) => expect(parseOfferMoney(text).status).toBe("ambiguous"));
  it.each([
    "Not €50, I want more",
    "It was €50 new; my price is 90",
    "I saw €120 last year, I offer 20 and can pick up Saturday at 10:00",
    "Price starts at €50",
    "I can pay EUR 120 or offer 20",
    "I offer EUR 120 or USD 120",
    "I will not pay EUR 120. Pickup Saturday at 10:00",
    "I won’t offer €120. Pickup Saturday at 10:00",
    "EUR 120 is the old price; I want more",
  ])("does not treat a historical, denied or competing price as an offer: %s", (text) => {
    expect(parseOfferMoney(text).status).toBe("ambiguous");
  });
  it.each([
    "Not working, I offer EUR 120 and pickup Saturday at 10:00",
    "I offer EUR 120 for a 20 year old bike, pickup Saturday at 10:00",
    "Price EUR 80. Pickup Saturday at 10:00",
    "It costs EUR 80. Pickup Saturday",
  ])("preserves a clear offer despite unrelated negation or numbers: %s", (text) => {
    expect(parseOfferMoney(text).status).toBe("known");
  });
  it("does not parse a bare pickup time as a price", () => expect(parseOfferMoney("Pickup Saturday 10:00").status).toBe("missing"));
  it("does not create a Sell card from a rejected price and separate bare offer", async () => {
    const result = await handleCounterpartMessage("Not €120, I offer 20 and can pick up Saturday at 10:00.", listing, policy);
    expect(result.dealCard).toBeNull();
  });
  it("keeps an affirmed time", () => expect(pickupEvidence(message)).toMatchObject({ status: "offered", slot: "Saturday at 10:00" }));
  it("does not select a negated first date", () => expect(pickupEvidence("I can pick up, but not Saturday. Sunday at 10:00 works.")).toMatchObject({ status: "offered", slot: "Sunday at 10:00" }));
  it("detects denied pickup", () => expect(pickupEvidence("Working bike, EUR 80. No pickup; shipping only.")).toMatchObject({ status: "denied", slot: null }));
  it("does not choose among alternatives", () => expect(pickupEvidence("Pickup Saturday or Sunday").status).toBe("conflict"));
  it("rejects impossible clock values", () => expect(pickupEvidence("Pickup Saturday at 29:99").status).toBe("conflict"));
  it("preserves smart-apostrophe negations", () => expect(pickupEvidence("I can’t pick it up Saturday").status).toBe("denied"));
  it("does not pick day substrings in words", () => expect(pickupEvidence("Pickup: the furniture looks sunny").slot).toBeNull());
});

describe("negative and uncertain condition", () => {
  it.each(["It does not work.", "Not working", "It is not functional", "It is broken"])("does not turn %s positive", (text) => expect(workingEvidence(text).status).toBe("no"));
  it.each(["Not sure it works", "Working condition unknown", "Does it work?", "It used to work", "Saturday works for me"])("keeps %s unknown", (text) => expect(workingEvidence(text).status).toBe("unknown"));
  it("detects contradictory evidence", () => expect(workingEvidence("It works", "The motor is broken").status).toBe("conflict"));
  it("does not manufacture functionality from a negative voice transcript", () => {
    const result = normalizeOwnerPolicy({ ...policy, availability: null, facts: ["It is broken"] }, "It does not work. The motor is broken. Pickup only Saturday in Brno.");
    expect(result.availability).toBeNull();
    expect(result.facts).toContain("It does not work");
    expect(result.facts).not.toContain("It works");
  });
  it("discards a fabricated model fact/window/minimum", () => {
    const result = normalizeOwnerPolicy({ ...policy, minPrice: 120, pickupWindows: ["Sunday 15:00"], availability: "works", facts: ["It works", "Includes Bluetooth"] }, "The motor is broken. Pickup Saturday only.");
    expect(result).toMatchObject({ minPrice: null, availability: null, pickupWindows: [] });
    expect(result.facts).not.toContain("Includes Bluetooth");
  });
  it("does not accept negated canonical facts or legacy availability=works", () => {
    expect(canonicalFact("It does not work", { listing, policy })).toBeNull();
    expect(canonicalFact("It works", { listing: { ...listing, facts_confirmed: [] }, policy: { ...policy, availability: "works" } })).toBeNull();
  });
});

describe("offer qualification and owner authority", () => {
  it("creates a card only from actual offer evidence", async () => {
    const result = await handleCounterpartMessage(message, listing, policy);
    expect(result.dealCard).toMatchObject({ price: 120, currency: "EUR", pickupSlot: "Saturday at 10:00", status: "pending" });
  });
  it.each([
    "I cannot buy it for EUR 120, and cannot pick it up.",
    "I can pay GBP 120 and pick up Saturday at 10:00",
    "I can pay EUR 120, pickup Sunday at 10:00",
    "I can pay EUR 120 for it",
    "I offer EUR 120 if it has Bluetooth and pickup Saturday at 10:00",
    "I do not want to buy it for EUR 120. Pickup Saturday at 10:00.",
    "I am not buying it for EUR 120. Pickup Saturday at 10:00.",
    "It was EUR 120. I offer EUR 40 and pickup Saturday at 10:00",
  ])("does not qualify %s", async (text) => expect((await handleCounterpartMessage(text, listing, policy)).dealCard).toBeNull());
  it("accepts a specific affirmed time inside a day-only owner window", async () => {
    expect((await handleCounterpartMessage(message, listing, { ...policy, pickupWindows: ["Saturday in Brno"] })).dealCard).not.toBeNull();
  });
  it("does not derive a floor from an unrelated-currency search estimate", async () => {
    expect((await handleCounterpartMessage(message, listing, { ...policy, minPrice: null })).dealCard).not.toBeNull();
  });
  it("does not expose owner decisions as model tools", () => expect(AGENT_TOOLS.some((tool) => (tool.name as string) === "close_deal_card")).toBe(false));
  it("ownerDecision does not mutate the supplied card or claim external delivery", async () => {
    const card = (await handleCounterpartMessage(message, listing, policy)).dealCard!;
    const reply = ownerDecision(card, "yes");
    expect(card.status).toBe("pending");
    expect(reply.text).toContain("No external message has been sent");
  });
});

describe("real-mode untrusted model tools (scripted responses, no network)", () => {
  beforeEach(() => { mock.mode = "real"; });
  it.each(["close_deal_card", "unexpected", "__proto__"])("denies %s", async (name) => {
    mock.create.mockResolvedValueOnce(response(name, { cardId: "invented", decision: "yes" }));
    const result = await handleCounterpartMessage("Is it available?", listing, policy);
    expect(result.dealCard).toBeNull(); expect(result.toolResult?.allowed).toBe(false);
    expect(result.reply).not.toContain("Deal accepted");
  });
  it("denies invalid arguments", async () => {
    mock.create.mockResolvedValueOnce(response("ask_owner_yes_no", { ...askCard, price: "999" }));
    expect((await handleCounterpartMessage(message, listing, policy)).toolResult?.allowed).toBe(false);
  });
  it("ignores fabricated rejection reply text", async () => {
    mock.create.mockResolvedValueOnce(response("flag_not_serious", { reason: "Test", reply: "The owner confirms Bluetooth and a warranty." }));
    const result = await handleCounterpartMessage("Does it work?", listing, policy);
    expect(result.reply).not.toContain("Bluetooth"); expect(result.reply).not.toContain("warranty");
  });
  it("refuses model qualification with no offer", async () => {
    mock.create.mockResolvedValueOnce(response("ask_owner_yes_no", askCard));
    const result = await handleCounterpartMessage("Is it available?", listing, policy);
    expect(result.dealCard).toBeNull(); expect(result.toolResult?.allowed).toBe(false);
  });
  it("preserves card as a terminal effect and ignores invented tool price/currency", async () => {
    mock.create.mockResolvedValueOnce(response("ask_owner_yes_no", askCard));
    mock.create.mockResolvedValueOnce(response("answer_from_listing", { fact: "It works." }));
    const result = await handleCounterpartMessage(message, listing, policy);
    expect(result.dealCard).toMatchObject({ price: 120, currency: "EUR", pickupSlot: "Saturday at 10:00" });
    expect(mock.create).toHaveBeenCalledTimes(1);
  });
  it("records every billed response in a multi-tool turn", async () => {
    mock.create.mockResolvedValueOnce(response("propose_pickup_slot", { slot: "Saturday 10:00", basis: "owner" }, "1"));
    mock.create.mockResolvedValueOnce(response("ask_owner_yes_no", askCard, "2"));
    const result = await handleCounterpartMessage(message, listing, policy);
    expect(result.dealCard).not.toBeNull(); expect(mock.create).toHaveBeenCalledTimes(2); expect(mock.log).toHaveBeenCalledTimes(2);
    expect(mock.log.mock.calls.every(([entry]) => entry.estimatedUsd > 0)).toBe(true);
  });
});

describe("grounded price parsing", () => {
  const url = "https://market.example/listing";
  const raw = (text: string) => ({ output: [{ type: "web_search_call", results: [{ title: "Comparable", url }] }, { type: "message", content: [{ type: "output_text", text }] }] });
  it("uses explicit structured estimates, not a product number or first search amount", () => {
    const result = parseGroundedPriceResponse(raw(JSON.stringify({ range: { low: 80, high: 130 }, quick_sale: 95, currency: "EUR", sources: [{ title: "Comparable", url }] })));
    expect(result).toMatchObject({ range: [80, 130], quick_sale: 95, currency: "EUR" });
  });
  it("returns unknown for unlabeled first prices", () => expect(parseGroundedPriceResponse(raw("A collector model costs EUR 900. No comparable price established."))).toMatchObject({ range: null, quick_sale: null }));
  it("never turns missing price into zero", () => expect(parseGroundedPriceResponse(raw("No results."))).toMatchObject({ range: null, quick_sale: null }));
  it("supports one unambiguous labeled legacy estimate", () => expect(parseGroundedPriceResponse(raw("Comparable range: EUR 80–130\nQuick-sale price: EUR 95"))).toMatchObject({ range: [80, 130], quick_sale: 95, currency: "EUR" }));
  it("rejects a model-written URL absent from search evidence", () => expect(parseGroundedPriceResponse(raw(JSON.stringify({ range: { low: 80, high: 130 }, quick_sale: 95, currency: "EUR", sources: [{ title: "Fake", url: "https://invented.example" }] })))).toMatchObject({ range: null, quick_sale: null }));
});
