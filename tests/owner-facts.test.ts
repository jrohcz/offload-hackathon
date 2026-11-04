import { describe, expect, it } from "vitest";
import { reconcileOwnerFacts } from "@/lib/owner-facts";
import type { ListingDraft, OwnerPolicy } from "@/lib/types";
const listing: ListingDraft = { title: "Turntable", category: "Electronics", condition: "Used", description: "Visible crack in cover.", brand: null, model: null, facts_confirmed: ["The dust cover has a crack."], facts_unknown: ["Whether playback works", "Working condition", "Age", "Battery condition"], questions_for_owner: ["Does it play records correctly?", "Does Bluetooth work?", "Does it work and include a stylus?", "How old is it?"], sam_concept: "turntable" };
const policy = (transcript: string, facts: string[]): OwnerPolicy => ({ minPrice: null, currency: "EUR", pickupOnly: true, pickupWindows: [], availability: null, sourceTranscript: transcript, facts });
describe("voice-to-listing provenance reconciliation", () => {
  it("records a verbatim negative owner claim and resolves only general functionality unknowns", () => {
    const result = reconcileOwnerFacts(listing, policy("It does not work. The motor is broken.", ["It does not work", "The motor is broken"]));
    expect(result.facts_confirmed).toContain("The dust cover has a crack.");
    expect(result.facts_confirmed).toContain("Owner voice: It does not work");
    expect(result.facts_confirmed).not.toContain("It works");
    expect(result.facts_unknown).toEqual(["Age", "Battery condition"]);
    expect(result.questions_for_owner).toEqual(["Does Bluetooth work?", "Does it work and include a stylus?", "How old is it?"]);
    expect(result.description).toBe(listing.description);
  });
  it("labels positive testimony rather than claiming it came from the photo", () => {
    const result = reconcileOwnerFacts(listing, policy("It works.", ["It works"]));
    expect(result.facts_confirmed).toContain("Owner voice: It works");
    expect(result.facts_confirmed).not.toContain("It works");
    expect(result.questions_for_owner).not.toContain("Does it play records correctly?");
  });
  it.each(["Not sure it works", "It used to work", "Saturday works for me", "The motor is broken", "The lid is broken", "The stylus works", "Is it working?", "I think it works", "It probably works"])("does not over-resolve from %s", (statement) => {
    const result = reconcileOwnerFacts(listing, policy(statement, [statement]));
    expect(result.facts_unknown).toEqual(listing.facts_unknown);
    expect(result.questions_for_owner).toEqual(listing.questions_for_owner);
  });
  it("retains conflicts explicitly instead of silently choosing a convenient statement", () => {
    const result = reconcileOwnerFacts({ ...listing, facts_confirmed: [...listing.facts_confirmed, "It works."] }, policy("It does not work.", ["It does not work"]));
    expect(result.facts_confirmed).toContain("It works.");
    expect(result.facts_confirmed).toContain("Owner voice: It does not work");
    expect(result.facts_unknown).toEqual(listing.facts_unknown);
    expect(result.questions_for_owner.some((question) => question.includes("conflict"))).toBe(true);
  });
  it("does not include a model-invented positive fact absent from the transcript", () => {
    const result = reconcileOwnerFacts(listing, policy("It does not work.", ["It works"]));
    expect(result.facts_confirmed).toContain("Owner voice: It does not work.");
    expect(result.facts_confirmed).not.toContain("Owner voice: It works");
  });
  it("is idempotent and does not mutate either input", () => {
    const owner = policy("It does not work.", ["It does not work"]);
    const before = JSON.stringify({ listing, owner });
    const once = reconcileOwnerFacts(listing, owner);
    expect(reconcileOwnerFacts(once, owner)).toEqual(once);
    expect(JSON.stringify({ listing, owner })).toBe(before);
  });
  it("does not claim voice provenance when no voice transcript exists", () => {
    const { sourceTranscript: _, ...owner } = policy("It works.", ["It works"]);
    expect(reconcileOwnerFacts(listing, owner).facts_confirmed).toContain("Owner statement: It works");
  });
});
