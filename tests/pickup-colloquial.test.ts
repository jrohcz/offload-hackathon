import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickupEvidence } from "@/lib/evidence";
import { handleCounterpartMessage } from "@/lib/agent";
import type { ListingDraft, OwnerPolicy } from "@/lib/types";
vi.mock("@/lib/meta/client", async (original) => ({ ...await original<typeof import("@/lib/meta/client")>(), getMode: () => "mock", logCall: vi.fn() }));
const listing: ListingDraft = { title: "Turntable", category: "Electronics", condition: "Untested", description: "Turntable, untested.", brand: null, model: null, facts_confirmed: ["A turntable is visible"], facts_unknown: ["Whether it works"], questions_for_owner: ["Does it work?"], sam_concept: "turntable" };
const policy: OwnerPolicy = { minPrice: null, currency: "EUR", pickupOnly: true, pickupWindows: [], availability: "available", facts: [] };
const actual1 = "Hello, I'm interested in the turntable as-is untested. I can offer €25 cash and pick it up in person tomorrow Thursday at 6pm. Would that work?";
const actual2 = "Hi, is the turntable still available? I can offer €85 and pick it up this Saturday at 11am. Does it power on and work?";
describe("deployed colloquial pickup regressions", () => {
  it("preserves adjacent relative/named day as one counterpart-proposed slot", () => {
    expect(pickupEvidence(actual1)).toMatchObject({ status: "offered", slot: "tomorrow Thursday at 6pm" });
  });
  it("qualifies the exact first deployed serious-buyer message without invented pickup", async () => {
    const result = await handleCounterpartMessage(actual1, listing, policy, "serious-buyer");
    expect(result.dealCard).toMatchObject({ price: 25, currency: "EUR", pickupSlot: "tomorrow Thursday at 6pm" });
  });
  it("matches this Saturday against an owner's Saturday window without changing the quote", async () => {
    const result = await handleCounterpartMessage(actual2, listing, { ...policy, minPrice: 80, pickupWindows: ["Saturday"], facts: ["It works."] }, "serious-buyer");
    expect(result.dealCard).toMatchObject({ price: 85, currency: "EUR", pickupSlot: "this Saturday at 11am" });
  });
  it.each(["pick it up", "pick the item up", "pick up the item", "pick that up", "pick them up", "pick this item up"])("understands %s with an affirmative date", (verb) => {
    expect(pickupEvidence(`I can ${verb} Thursday at 6pm.`)).toMatchObject({ status: "offered", slot: "Thursday at 6pm" });
  });
  it.each(["pick it up", "pick the item up", "pick up the item", "pick that up", "pick them up", "pick this item up"])("does not erase denial of %s", (verb) => {
    expect(pickupEvidence(`I can't ${verb} Thursday at 6pm.`)).toMatchObject({ status: "denied", slot: null });
  });
  it("does not confuse alternatives with adjacent names for a day", () => {
    expect(pickupEvidence("I can pick it up tomorrow or Thursday at 6pm.")).toMatchObject({ status: "conflict", slot: null });
  });
  it("does not accept a negated compound day", () => {
    expect(pickupEvidence("I cannot pick the item up tomorrow Thursday at 6pm.")).toMatchObject({ status: "denied", slot: null });
  });
  it("does not let an affirmative price make a separate pickup question affirmative", () => {
    expect(pickupEvidence("I can offer EUR 25. Can you pick it up tomorrow Thursday at 6pm?")).toMatchObject({ status: "unknown", slot: null });
  });
  it("does not extract an unrelated workday as pickup", () => {
    expect(pickupEvidence("I can pick it up. Saturday I work.")).toMatchObject({ status: "offered", slot: null });
  });
  it("does not mistake no problem for a pickup prohibition", () => {
    expect(pickupEvidence("No problem, I can pick the item up Thursday at 6pm.")).toMatchObject({ status: "offered", slot: "Thursday at 6pm" });
  });
  it("still rejects a genuinely incompatible owner's day", async () => {
    expect((await handleCounterpartMessage(actual2, listing, { ...policy, minPrice: 80, pickupWindows: ["Sunday"] })).dealCard).toBeNull();
  });
  it("does not silently equate next Saturday with an unqualified Saturday window", async () => {
    expect((await handleCounterpartMessage(actual2.replace("this Saturday", "next Saturday"), listing, { ...policy, minPrice: 80, pickupWindows: ["Saturday"] })).dealCard).toBeNull();
  });
});
