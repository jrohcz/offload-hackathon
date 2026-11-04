import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickupEvidence } from "@/lib/evidence";
import { handleCounterpartMessage, runSimulation } from "@/lib/agent";
import type { ListingDraft, OwnerPolicy } from "@/lib/types";
const mocked = vi.hoisted(() => ({ mode: "mock", create: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/meta/client", async (original) => ({ ...await original<typeof import("@/lib/meta/client")>(), getMode: () => mocked.mode, getClient: () => ({ responses: { create: mocked.create } }), logCall: mocked.log }));
const listing: ListingDraft = { title: "Turntable", category: "Electronics", condition: "Untested", description: "Turntable, untested.", brand: null, model: null, facts_confirmed: ["A turntable is visible"], facts_unknown: ["Whether it works"], questions_for_owner: ["Does it work?"], sam_concept: "turntable" };
const policy: OwnerPolicy = { minPrice: 80, currency: "EUR", pickupOnly: true, pickupWindows: ["Saturday"], availability: "available", facts: [] };
const courtesy = "Hi, I'm seriously interested in the turntable. I can offer €85 and pick it up in person this Saturday around 10am if that works for you?";
const asIs = "Hello, I'm interested in the turntable as-is for restoration. I can offer €35 and pick it up in person tomorrow Thursday at 5:30pm. Would that work for you?";
const unanswered = "Hi, is the turntable still available? I can offer €85 and pick it up this Saturday at 11am. Does it power on and work?";
function response(name: string, args: unknown) { return { id: "response", output: [{ type: "function_call", call_id: "call", name, arguments: JSON.stringify(args) }] }; }
beforeEach(() => { mocked.mode = "mock"; mocked.create.mockReset(); mocked.log.mockReset(); });
describe("qualified offer finalization versus genuine missing facts", () => {
  it("preserves around-time and treats only the closing courtesy as owner approval", async () => {
    expect(pickupEvidence(courtesy)).toMatchObject({ status: "offered", slot: "this Saturday around 10am" });
    expect((await handleCounterpartMessage(courtesy, listing, policy)).dealCard).toMatchObject({ price: 85, pickupSlot: "this Saturday around 10am" });
  });
  it.each(["if it works", "if it has been tested", "if that works for you and it has Bluetooth", "subject to testing"])("does not erase material condition: %s", async (condition) => {
    expect((await handleCounterpartMessage(`I offer EUR 85 and pickup Saturday at 10am ${condition}.`, listing, policy)).dealCard).toBeNull();
  });
  it("does not hide an unanswered actual functionality question behind a card", async () => {
    const result = await handleCounterpartMessage(unanswered, listing, policy);
    expect(result.dealCard).toBeNull(); expect(result.tool).toBe("ask_owner_fact");
    expect(result.reply).toContain("Does it power on and work?");
  });
  it("allows the same offer when the owner's actual fact answers the functionality question", async () => {
    expect((await handleCounterpartMessage(unanswered, listing, { ...policy, facts: ["It works."] })).dealCard).not.toBeNull();
  });
  it("discloses a negative owner answer and asks counterpart confirmation, not a deal card", async () => {
    const result = await handleCounterpartMessage(unanswered, listing, { ...policy, facts: ["It does not work."] });
    expect(result.dealCard).toBeNull();
    expect(result.reply).toContain("Owner says: It does not work.");
    expect(result.reply).toContain("Please confirm");
  });
  it("responds with the actual positive owner fact before the decision card", async () => {
    const result = await handleCounterpartMessage(unanswered, listing, { ...policy, facts: ["It works."] });
    expect(result.dealCard).not.toBeNull(); expect(result.reply).toContain("Owner says: It works.");
  });
  it("does not let known availability swallow an unrelated question in the same sentence", async () => {
    const result = await handleCounterpartMessage("I offer EUR 85 and pickup Saturday at 11am. Is it still available and does it have Bluetooth?", listing, policy);
    expect(result.dealCard).toBeNull(); expect(result.reply).toMatch(/does it have Bluetooth/i);
  });
  it("does not let known functionality answer a different Bluetooth question", async () => {
    const result = await handleCounterpartMessage(unanswered.replace("Does it power on and work?", "Does it have Bluetooth?"), listing, { ...policy, facts: ["It works."] });
    expect(result.tool).toBe("ask_owner_fact"); expect(result.dealCard).toBeNull();
  });
  it.each([{ questions: [] }, { questions: ["Please confirm any remaining offer details"] }])("finalizes eligible offers instead of an empty model clarification: %j", async ({ questions }) => {
    mocked.mode = "real"; mocked.create.mockResolvedValueOnce(response("request_counterpart_info", { questions }));
    const result = await handleCounterpartMessage(asIs, listing, { ...policy, minPrice: null, pickupWindows: [] });
    expect(result.tool).toBe("ask_owner_yes_no");
    expect(result.dealCard).toMatchObject({ price: 35, currency: "EUR", pickupSlot: "tomorrow Thursday at 5:30pm" });
    expect(result.reply).not.toContain("remaining offer details");
  });
  it("real routing preserves an unresolved source fact even if model would create a card", async () => {
    mocked.mode = "real";
    mocked.create.mockResolvedValueOnce(response("request_counterpart_info", { questions: [] }));
    const result = await handleCounterpartMessage(unanswered, listing, policy);
    expect(result.tool).toBe("ask_owner_fact"); expect(result.dealCard).toBeNull();
    expect(mocked.create).not.toHaveBeenCalled();
  });
  it("uses a policy-derived unconditional positive control only for the simulated serious buyer", async () => {
    mocked.mode = "real";
    mocked.create.mockImplementation(async (args) => String(args.input).startsWith("Play marketplace counterpart persona")
      ? { id: "sim", output_text: String(args.input).includes("Serious buyer") ? "I offer EUR 5 if it works. Can you deliver?" : "Just browsing." }
      : response("request_counterpart_info", { questions: [] }));
    const result = await runSimulation(listing, policy);
    expect(result.dealCards).toHaveLength(1);
    expect(result.dealCards[0]).toMatchObject({ price: 85, currency: "EUR", pickupSlot: "Saturday at 10:00" });
    expect(result.personas[0].messages[0].text).toContain("as-is");
    expect(result.personas[0].messages[0].text).not.toContain("?");
    expect(mocked.log.mock.calls.some(([entry]) => entry.raw?.simulationControl?.usedDeterministicFallback === true)).toBe(true);
  });
  it("does not force that simulated control past a sold listing", async () => {
    mocked.mode = "real";
    mocked.create.mockResolvedValue({ id: "sim", output_text: "I offer EUR 85 and pickup Saturday at 10:00." });
    const result = await runSimulation(listing, { ...policy, availability: "sold" });
    expect(result.dealCards).toHaveLength(0);
  });
});


describe("bare payment-link hard guard", () => {
  it.each([
    "I'll take it for €80 and can pick up Saturday — just confirm here to reserve it for me: bit.ly/secure-pay-turntable80",
    "I offer EUR 85 and pickup Saturday at 10am. Confirm payment at www.payment.example/verify",
    "I offer EUR 85 and pickup Saturday at 10am. Use secure-checkout.example/claim to receive payment.",
  ])("rejects before any model can promote a link-bearing offer: %s", async (text) => {
    mocked.mode = "real";
    mocked.create.mockResolvedValueOnce(response("request_counterpart_info", { questions: [] }));
    const result = await handleCounterpartMessage(text, listing, policy);
    expect(result.tool).toBe("flag_not_serious"); expect(result.dealCard).toBeNull();
    expect(result.reply).toContain("Payment links are not accepted");
    expect(mocked.create).not.toHaveBeenCalled();
  });
});
