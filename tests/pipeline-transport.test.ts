import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImageInputError, normalizePipelineInput, PIPELINE_IMAGE_LIMITS, publicImageDataUrl, runSellPipeline, SegmentationError } from "@/lib/pipeline";

const state = vi.hoisted(() => ({ priceFailure: false, samFailure: false, seenInputs: [] as Buffer[] }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/meta/client")>(), logCall: vi.fn() }));
vi.mock("@/lib/meta/search", () => ({ priceGrounding: async () => {
  if (state.priceFailure) throw new Error("Price provider unavailable");
  return { range: [80, 130], quick_sale: 95, currency: "EUR", sources: [] };
} }));
vi.mock("@/lib/meta/sam", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/sam")>();
  return { ...original, segmentConcept: async (...args: Parameters<typeof original.segmentConcept>) => {
    if (state.samFailure) return { result: { records: [], rawOutput: "" }, raw: null };
    return original.segmentConcept(...args);
  } };
});
vi.mock("@/lib/meta/spark", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/spark")>();
  return { ...original, identifyListing: async (...args: Parameters<typeof original.identifyListing>) => {
    state.seenInputs.push(args[0]);
    return original.identifyListing(...args);
  } };
});

beforeEach(() => {
  process.env.OFFLOAD_MOCK = "1";
  delete process.env.MODEL_API_KEY;
  state.priceFailure = false;
  state.samFailure = false;
  state.seenInputs = [];
});
const photo = () => sharp({ create: { width: 100, height: 100, channels: 3, background: "#26332e" } }).png().toBuffer();
function decode(url: string) { return Buffer.from(url.split(",")[1], "base64"); }

describe("server image normalization and bounded display transport", () => {
  it("rejects invalid, vector, too-wide and oversized uploads before model calls", async () => {
    const invalid = [Buffer.from("not an image"), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80"/></svg>'), Buffer.alloc(PIPELINE_IMAGE_LIMITS.inputBytes + 1)];
    invalid.push(await sharp({ create: { width: 20_000, height: 1, channels: 3, background: "red" } }).png().toBuffer());
    for (const input of invalid) await expect(runSellPipeline(input)).rejects.toBeInstanceOf(ImageInputError);
    expect(state.seenInputs).toEqual([]);
  });

  it("bounds decoded dimensions before identifying the item and preserves aspect ratio", async () => {
    const input = await sharp({ create: { width: 3200, height: 2000, channels: 3, background: "#84715d" } }).png().toBuffer();
    const normalized = await normalizePipelineInput(input);
    expect(await sharp(normalized).metadata()).toMatchObject({ format: "png", width: 1600, height: 1000 });
    await runSellPipeline(input);
    expect(await sharp(state.seenInputs[0]).metadata()).toMatchObject({ width: 1600, height: 1000 });
  });

  it("applies EXIF orientation once and removes metadata without enlarging", async () => {
    const input = await sharp({ create: { width: 60, height: 30, channels: 3, background: "red" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const meta = await sharp(await normalizePipelineInput(input)).metadata();
    expect(meta).toMatchObject({ width: 30, height: 60 });
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });

  it("keeps transparent and partially-transparent cutout pixels in WebP transport", async () => {
    const rgba = Buffer.from([255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 127, 255, 255, 255, 255]);
    const input = await sharp(rgba, { raw: { width: 4, height: 1, channels: 4 } }).png().toBuffer();
    const url = await publicImageDataUrl(input);
    expect(url).toMatch(/^data:image\/webp;base64,/);
    const alpha = await sharp(decode(url)).extractChannel("alpha").raw().toBuffer();
    expect([...alpha]).toEqual([0, 255, 127, 255]);
  });

  it("returns four bounded display images for the photographic fixture", async () => {
    const input = await readFile("fixtures/real/generated-used-turntable.webp");
    const result = await runSellPipeline(input, "image/webp");
    const images = [result.originalDataUrl, result.cutoutDataUrl, result.heroDataUrl, result.condition.overlayDataUrl];
    for (const image of images) {
      expect(image).toMatch(/^data:image\/webp;base64,/);
      expect(decode(image).length).toBeLessThanOrEqual(PIPELINE_IMAGE_LIMITS.publicImageBytes);
    }
    const jsonBytes = Buffer.byteLength(JSON.stringify(result));
    expect(jsonBytes).toBeLessThan(4 * 1024 * 1024);
    console.info("Photographic mock pipeline JSON bytes:", jsonBytes, "; image bytes:", images.map((image) => decode(image).length).join(", "));
  });

  it("does not lose the listing when optional price research fails", async () => {
    state.priceFailure = true;
    const result = await runSellPipeline(await photo());
    expect(result.listing.title).toBeTruthy();
    expect(result.listing.priceSuggestion).toMatchObject({ range: null, quick_sale: null, sources: [] });
    expect(result.listing.priceSuggestion?.text).toMatch(/unavailable/i);
  });

  it("handles a concurrent price rejection immediately even if segmentation fails first", async () => {
    state.priceFailure = true;
    state.samFailure = true;
    await expect(runSellPipeline(await photo())).rejects.toBeInstanceOf(SegmentationError);
    // Vitest fails the suite on unhandled promise rejections. Allow the
    // concurrent rejection microtask to finish before completing this case.
    await new Promise((resolve) => setImmediate(resolve));
  });
});
