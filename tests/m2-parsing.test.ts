import { beforeEach, describe, expect, it } from "vitest";
import { extractOwnerPolicy, normalizeOwnerPolicy } from "@/lib/meta/spark";
import { parseGroundedPriceResponse, priceGrounding } from "@/lib/meta/search";
import realPriceFixture from "@/fixtures/real/spark-web-search-price.json";

describe("M2 voice and price parsing", () => {
  beforeEach(() => { process.env.OFFLOAD_MOCK = "1"; delete process.env.MODEL_API_KEY; });

  it("extracts explicit owner policy from a voice transcript fixture", async () => {
    const result = await extractOwnerPolicy("It works, the lid is cracked, and pickup is Saturdays in Brno only.");
    expect(result.policy.facts).toContain("It works");
    expect(result.policy.pickupOnly).toBe(true);
    expect(result.policy.pickupWindows).toContain("Saturdays in Brno");
    expect(result.policy.minPrice).toBeNull();
  });

  it("keeps grounded price range, quick-sale price, and citations", async () => {
    const result = await priceGrounding("used turntable");
    expect(result.range).toEqual([80, 130]);
    expect(result.quick_sale).toBe(95);
    expect(result.sources[0].url).toMatch(/^https?:/);
  });

  it("keeps sources but declines ambiguous multi-currency legacy estimates", () => {
    const result = parseGroundedPriceResponse(realPriceFixture);
    expect(result.range).toBeNull();
    expect(result.quick_sale).toBeNull();
    expect(result.currency).toBe("");
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0].url).toMatch(/^https?:/);
  });

  it("does not accept a model-invented currency or drop an explicit works fact", () => {
    const result = normalizeOwnerPolicy({
      minPrice: null, currency: "USD", pickupOnly: false, pickupWindows: [], availability: null, facts: [],
    }, "It works; pickup is Saturday only.");
    expect(result.currency).toBe("EUR");
    expect(result.availability).toBeNull();
    expect(result.pickupOnly).toBe(true);
    expect(result.facts).toContain("It works");
  });
});
