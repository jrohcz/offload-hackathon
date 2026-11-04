import { describe, expect, it } from "vitest";
import { listingDraftSchema } from "@/lib/validation";

describe("listing structured output", () => {
  it("accepts the complete honest-listing contract", () => {
    expect(listingDraftSchema.parse({
      title: "Turntable", category: "Electronics", condition: "Good", description: "Visible crack.", brand: "Panasonic", model: null,
      facts_confirmed: ["Turntable visible"], facts_unknown: ["Playback works"], questions_for_owner: ["Does it play?"]
    }).title).toBe("Turntable");
  });

  it("rejects a listing that drops the unknowns contract", () => {
    expect(() => listingDraftSchema.parse({ title: "Turntable" })).toThrow();
  });
});
