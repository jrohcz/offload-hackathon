import { beforeEach, describe, expect, it } from "vitest";
import { handleCounterpartMessage, runSimulation } from "@/lib/agent";
import type { ListingDraft, OwnerPolicy } from "@/lib/types";

const listing: ListingDraft = {
  title: "Turntable", category: "Electronics", condition: "Good", description: "A turntable with a visible crack.", brand: "Panasonic", model: null,
  facts_confirmed: ["A turntable is visible", "The dust cover has a crack"], facts_unknown: ["Whether playback works"], questions_for_owner: ["Does it play records correctly?"],
  priceSuggestion: { range: [80, 130], quick_sale: 95, currency: "EUR", sources: [] },
};
const policy: OwnerPolicy = { minPrice: 80, currency: "EUR", pickupOnly: true, pickupWindows: ["Saturday 10:00"], availability: "available", facts: ["Pickup only"] };

describe("Offload conversation policy", () => {
  beforeEach(() => { process.env.OFFLOAD_MOCK = "1"; delete process.env.MODEL_API_KEY; });

  it("escalates a qualified offer as one yes/no card", async () => {
    const result = await handleCounterpartMessage("I can pay €120 and pick up Saturday at 10:00", listing, policy, "serious-buyer");
    expect(result.tool).toBe("ask_owner_yes_no");
    expect(result.dealCard?.status).toBe("pending");
    expect(result.dealCard?.price).toBe(120);
  });

  it("filters lowballs and payment links without escalating", async () => {
    const lowball = await handleCounterpartMessage("I'll take it for €20", listing, policy);
    const scam = await handleCounterpartMessage("Pay here https://bad.example/link", listing, policy);
    expect(lowball.tool).toBe("flag_not_serious");
    expect(scam.tool).toBe("flag_not_serious");
    expect(lowball.dealCard).toBeNull();
    expect(scam.dealCard).toBeNull();
  });

  it("answers pickup-only delivery asks from policy", async () => {
    const result = await handleCounterpartMessage("Can you deliver it?", listing, policy);
    expect(result.tool).toBe("answer_from_listing");
    expect(result.reply.toLowerCase()).toContain("pickup only");
  });

  it("does not invent an unknown fact", async () => {
    const result = await handleCounterpartMessage("Does it play records?", listing, policy);
    expect(result.tool).toBe("ask_owner_fact");
    expect(result.reply).toContain("Does it play records correctly?");
  });

  it("runs every demo persona and leaves only the serious decision for the owner", async () => {
    const result = await runSimulation(listing, policy);
    expect(result.personas).toHaveLength(5);
    expect(result.dealCards).toHaveLength(1);
    expect(result.metrics.handledByAgent).toBe(5);
    expect(result.metrics.humanRead).toBe(1);
  });
});
