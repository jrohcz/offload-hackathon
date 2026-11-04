import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mutateWorkspace, type SavedSell } from "@/lib/workspace";
import { canonicalFact, handleCounterpartMessage } from "@/lib/agent";
import { createFindRequest, decideFindCard, qualifyOffer } from "@/lib/find";
import { decideCard, getInbox, saveSimulation } from "@/lib/inbox";
import { makeCutout, SegmentationError } from "@/lib/pipeline";
import { runSimulation } from "@/lib/agent";
import type { ListingDraft, OwnerPolicy } from "@/lib/types";

const databasePath = path.join(mkdtempSync(path.join(tmpdir(), "offload-find-unit-")), "test.db");
let sid: string;
beforeEach(() => {
  delete process.env.DATABASE_URL; delete process.env.VERCEL;
  process.env.OFFLOAD_DB_PATH = databasePath; process.env.OFFLOAD_MOCK = "1";
  delete process.env.MODEL_API_KEY; sid = randomUUID();
});

const listing: ListingDraft = {
  title: "Turntable", category: "Electronics", condition: "Good", description: "A turntable with a visible crack.", brand: "Panasonic", model: null,
  facts_confirmed: ["A turntable is visible", "The dust cover has a crack"], facts_unknown: ["Whether playback works"], questions_for_owner: ["Does it play records correctly?"],
  sam_concept: "turntable record player",
  priceSuggestion: { range: [80, 130], quick_sale: 95, currency: "EUR", sources: [] },
};
const policy: OwnerPolicy = { minPrice: 80, currency: "EUR", pickupOnly: true, pickupWindows: ["Saturday 10:00"], availability: "available", facts: ["Pickup only"] };

describe("honesty regressions (30 Oct review)", () => {
  beforeEach(() => { process.env.OFFLOAD_MOCK = "1"; delete process.env.MODEL_API_KEY; });

  it("fails closed when SAM returns no mask instead of faking a cutout", async () => {
    const photo = Buffer.from("not-a-real-photo");
    await expect(makeCutout(photo, { records: [] } as never)).rejects.toBeInstanceOf(SegmentationError);
  });

  it("does not put the owner's pickup window on a card the buyer never proposed", async () => {
    const result = await handleCounterpartMessage("I can pay €120 for it", listing, policy, "serious-buyer");
    expect(result.tool).toBe("request_counterpart_info");
    expect(result.dealCard).toBeNull();
    expect(result.reply).toContain("pickup");
  });

  it("only answers with canonical confirmed facts", () => {
    const context = { listing, policy };
    expect(canonicalFact("The dust cover has a crack", context)).toBe("The dust cover has a crack");
    expect(canonicalFact("It has a brand new gold stylus and Bluetooth", context)).toBeNull();
  });

  it("does not allow an already-decided card to be decided again", async () => {
    const simulation = await runSimulation(listing, policy);
    const sell: SavedSell = {
      id: "test-sell", mode: "mock", approved: true, samplePhoto: true, voice: null,
      ownerPolicy: policy, listing, segmentation: { status: "ok", maskCount: 1 },
      originalDataUrl: "sample", cutoutDataUrl: "sample", heroDataUrl: "sample",
      condition: { defects: [], overlayDataUrl: "sample" },
    };
    await mutateWorkspace(sid, state => { state.sell = sell; });
    await saveSimulation(sid, simulation, listing, policy, sell.id);
    const card = simulation.dealCards[0];
    const first = await decideCard(sid, card.id, "yes");
    expect(first && !first.conflict).toBe(true);
    const second = await decideCard(sid, card.id, "no");
    expect(second?.conflict).toBe(true);
    expect((await getInbox(sid)).cards.find(saved => saved.id === card.id)?.status).toBe("accepted");
  });
});

describe("Find qualification", () => {
  beforeEach(() => { process.env.OFFLOAD_MOCK = "1"; delete process.env.MODEL_API_KEY; });

  it("qualifies, rejects over-budget, and asks instead of assuming", async () => {
    const request = await createFindRequest(sid, { need: "Working turntable", budget: 150, currency: "EUR", mustWork: true });

    const qualified = await qualifyOffer(sid, request, "Works well, EUR 120, pickup Saturday in Brno", listing);
    expect(qualified.status).toBe("qualified");
    expect(qualified.card?.price).toBe(120);

    const overBudget = await qualifyOffer(sid, request, "Works well, EUR 220, pickup Saturday", listing);
    expect(overBudget.status).toBe("rejected");

    const noPrice = await qualifyOffer(sid, request, "I have one in good shape", listing);
    expect(noPrice.status).toBe("needs-info");
    expect(noPrice.questions.join(" ")).toContain("price");

    const undecided = qualified.card!;
    expect((await decideFindCard(sid, undecided.id, "yes"))?.conflict).toBe(false);
    expect((await decideFindCard(sid, undecided.id, "no"))?.conflict).toBe(true);
  });
});
