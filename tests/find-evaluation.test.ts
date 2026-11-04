import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateOffer, type FindEvidence } from "@/lib/find-evaluation";
import type { FindRequest, ListingDraft } from "@/lib/types";

const client = vi.hoisted(() => ({ create: vi.fn(), log: vi.fn(), mode: "mock" as "mock" | "real" }));
vi.mock("@/lib/meta/client", () => ({
  getMode: () => client.mode,
  getClient: () => ({ responses: { create: client.create } }),
  logCall: client.log,
  outputText: (value: { output_text: string }) => value.output_text,
  parseJson: JSON.parse,
  sparkCost: () => 0.001,
  SPARK_MODEL: "muse-spark-1.3",
}));

const request: FindRequest = { id: "find-test", need: "Working toddler bicycle", budget: 100, currency: "EUR", mustWork: true };
const turntable: ListingDraft = {
  title: "Turntable", category: "Electronics", condition: "Untested", description: "A record player.", brand: null, model: null,
  facts_confirmed: ["A turntable is visible"], facts_unknown: ["Whether it works"], questions_for_owner: ["Does it work?"], sam_concept: "turntable record player",
};
const realEvidence = (message: string): FindEvidence => ({
  identity: { status: "match", evidence: [message] },
  condition: { status: "works", evidence: [message] },
  pickup: { status: "available", evidence: [message] },
  requirements: { status: "met", evidence: [message] },
  pickupSlot: "Saturday",
});
function respond(evidence: unknown) {
  client.create.mockResolvedValue({ output_text: JSON.stringify(evidence), usage: {} });
}
beforeEach(() => { client.mode = "mock"; client.create.mockReset(); client.log.mockReset(); });

describe("Find qualification hard constraints", () => {
  it("qualifies a matching explicitly working item and preserves the offered currency and timing", async () => {
    const result = await evaluateOffer(request, "Working toddler bike, EUR 80, pickup Saturday", null);
    expect(result).toMatchObject({ status: "qualified", price: 80, currency: "EUR", pickupSlot: "Saturday" });
  });

  it.each([
    ["Working toaster, EUR 80, pickup Saturday", "rejected"],
    ["This toddler bike is not working, EUR 80, pickup Saturday", "rejected"],
    ["Working toddler bike, EUR 80. No pickup; shipping only.", "rejected"],
    ["Works well, EUR 80, pickup Saturday", "needs-info"],
    ["Working bike, EUR 80, pickup Saturday", "needs-info"],
    ["Working toddler bike, GBP 95, pickup Saturday", "needs-info"],
    ["Working toddler bike, price 80, pickup Saturday", "needs-info"],
    ["Working toddler bike, EUR 180, pickup Saturday", "rejected"],
    ["Working toddler bike, EUR 80, pickup available", "needs-info"],
    ["Untested toddler bike, EUR 80, pickup Saturday", "needs-info"],
    ["Working toddler bike, EUR 80 or EUR 95, pickup Saturday", "needs-info"],
  ])("does not qualify unsafe or incomplete offer: %s", async (message, status) => {
    const result = await evaluateOffer(request, message, null);
    expect(result.status).toBe(status);
    expect(result.reasons.length + result.questions.length).toBeGreaterThan(0);
  });

  it("asks for the current price instead of qualifying a rejected price", async () => {
    const result = await evaluateOffer(request, "Working toddler bike. Pickup Saturday. Not €50, I want more.", null);
    expect(result.status).toBe("needs-info");
    expect(result.price).toBeNull();
  });

  it("preserves GBP rather than relabeling it EUR or rejecting against a numerically different budget", async () => {
    const result = await evaluateOffer(request, "Working toddler bike, GBP 150, pickup Saturday", null);
    expect(result).toMatchObject({ status: "needs-info", price: 150, currency: "GBP" });
    expect(result.reasons).toEqual([]);
  });

  it("uses photo identity but not photo-only mechanical condition", async () => {
    const need = { ...request, need: "Working turntable", budget: 150 };
    const positive = await evaluateOffer(need, "Works well, EUR 120, pickup Saturday in Brno", turntable);
    expect(positive.status).toBe("qualified");
    const photoOnly = await evaluateOffer(need, "EUR 120, pickup Saturday", { ...turntable, facts_confirmed: ["It works"] });
    expect(photoOnly.status).toBe("needs-info");
  });

  it("retains uncertainty when message and photograph identify different items", async () => {
    const result = await evaluateOffer(request, "Working toddler bike, EUR 80, pickup Saturday", turntable);
    expect(result.status).not.toBe("qualified");
  });

  it("handles the exact production audit counterexample", async () => {
    const result = await evaluateOffer(request, "This toaster is not working, GBP 95, no pickup; shipping only.", null);
    expect(result).toMatchObject({ status: "rejected", price: 95, currency: "GBP" });
    expect(result.reasons.join(" ")).toMatch(/not match/);
    expect(result.reasons.join(" ")).toMatch(/not to work/);
    expect(result.reasons.join(" ")).toMatch(/Pickup is unavailable/);
  });
});

describe("real semantic qualification boundary (scripted API responses, no paid calls)", () => {
  beforeEach(() => { client.mode = "real"; });

  it("uses typed semantic evaluation across languages and logs usage", async () => {
    const message = "Dětské kolo je plně funkční. EUR 80. Osobní odběr v sobotu.";
    respond({ ...realEvidence(message), pickupSlot: "v sobotu" });
    const result = await evaluateOffer(request, message, null);
    expect(result.status).toBe("qualified");
    expect(result.pickupSlot).toBe("v sobotu");
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      model: "muse-spark-1.3", text: expect.objectContaining({ format: expect.objectContaining({ strict: true, type: "json_schema" }) }),
    }));
    expect(client.log).toHaveBeenCalledTimes(1);
  });

  it("does not turn model failure or malformed structured output into a lexical fallback approval", async () => {
    const message = "Working toddler bike, EUR 80, pickup Saturday";
    client.create.mockRejectedValueOnce(new Error("offline"));
    expect((await evaluateOffer(request, message, null)).status).toBe("needs-info");
    respond({ status: "qualified" });
    expect((await evaluateOffer(request, message, null)).status).toBe("needs-info");
    expect(client.log).toHaveBeenCalledTimes(1);
  });

  it("rejects fabricated evidence and evidence copied from the request instead of the offer", async () => {
    const message = "Works well, EUR 80, pickup Saturday";
    respond({ ...realEvidence(message), identity: { status: "match", evidence: ["Working toddler bicycle"] } });
    const result = await evaluateOffer(request, message, null);
    expect(result.status).toBe("needs-info");
    expect(result.evidence.identity.status).toBe("unknown");
  });

  it("cannot claim working condition from the image or a fabricated pickup time", async () => {
    const message = "Turntable, EUR 80, pickup Saturday";
    respond({ ...realEvidence(message), condition: { status: "works", evidence: ["It works"] }, pickupSlot: "Sunday at noon" });
    const result = await evaluateOffer({ ...request, need: "Turntable" }, message, { ...turntable, facts_confirmed: ["It works"] });
    expect(result.status).toBe("needs-info");
    expect(result.evidence.condition.status).toBe("unknown");
    expect(result.pickupSlot).toBeNull();
  });

  it.each([
    "This toddler bike is not working, EUR 80, pickup Saturday",
    "Working toddler bike, EUR 80, no pickup Saturday; shipping only",
  ])("vetoes semantic approval when explicit deterministic constraints fail: %s", async (message) => {
    respond(realEvidence(message));
    expect((await evaluateOffer(request, message, null)).status).toBe("rejected");
  });

  it("requires confirmation of requested attributes even if category matches", async () => {
    const message = "Working bicycle, EUR 80, pickup Saturday";
    respond({ ...realEvidence(message), requirements: { status: "unknown", evidence: [] } });
    const result = await evaluateOffer(request, message, null);
    expect(result.status).toBe("needs-info");
  });
});
