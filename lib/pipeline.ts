import sharp from "sharp";
import { identifyListing, groundDefects } from "@/lib/meta/spark";
import { priceGrounding } from "@/lib/meta/search";
import { createHero } from "@/lib/meta/image";
import { masksFromResult, segmentConcept } from "@/lib/meta/sam";
import { getMode, imageDataUrl } from "@/lib/meta/client";
import type { Defect, PriceSuggestion, SellPipelineResult } from "@/lib/types";

type SamResult = Awaited<ReturnType<typeof segmentConcept>>["result"];

export const PIPELINE_IMAGE_LIMITS = {
  inputBytes: 10 * 1024 * 1024,
  inputPixels: 40_000_000,
  inputEdge: 16_384,
  normalizedEdge: 1600,
  publicImageBytes: 700 * 1024,
} as const;

export class ImageInputError extends Error {
  constructor(message: string) { super(message); this.name = "ImageInputError"; }
}

/** Decode and orient actual raster pixels before any model sees the upload. */
export async function normalizePipelineInput(input: Buffer): Promise<Buffer> {
  if (input.length === 0 || input.length > PIPELINE_IMAGE_LIMITS.inputBytes) {
    throw new ImageInputError("Please use a non-empty photo smaller than 10 MiB.");
  }
  try {
    const image = sharp(input, { limitInputPixels: PIPELINE_IMAGE_LIMITS.inputPixels, failOn: "error" });
    const meta = await image.metadata();
    if (!meta.width || !meta.height || !["jpeg", "png", "webp", "avif", "heif"].includes(meta.format ?? "")) {
      throw new ImageInputError("Please upload a JPEG, PNG, WebP or supported HEIF/AVIF photo, not a vector or document.");
    }
    if ((meta.pages ?? 1) !== 1 || meta.width > PIPELINE_IMAGE_LIMITS.inputEdge || meta.height > PIPELINE_IMAGE_LIMITS.inputEdge || meta.width * meta.height > PIPELINE_IMAGE_LIMITS.inputPixels) {
      throw new ImageInputError("Please use one still photo of at most 40 megapixels and 16,384 pixels per edge.");
    }
    // No retouching, cropping, sharpening or repair. Apply camera orientation,
    // retain aspect ratio, and remove metadata while bounding decoded dimensions.
    return await image.rotate().resize({ width: PIPELINE_IMAGE_LIMITS.normalizedEdge, height: PIPELINE_IMAGE_LIMITS.normalizedEdge, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  } catch (error) {
    if (error instanceof ImageInputError) throw error;
    throw new ImageInputError("This photo could not be decoded safely. Use a valid still photo up to 40 megapixels.");
  }
}

/** Optimized display copy only; makeCutout's lossless PNG/mask contract is unchanged. */
export async function publicImageDataUrl(input: Buffer): Promise<string> {
  // Keep a high visual quality and reduce dimensions, rather than aggressively
  // quantizing fine wear. WebP encodes alpha losslessly (alphaQuality 100).
  for (const edge of [1600, 1280, 1024, 800, 640]) {
    const output = await sharp(input, { limitInputPixels: PIPELINE_IMAGE_LIMITS.inputPixels, failOn: "error" })
      .rotate().resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90, alphaQuality: 100, effort: 4 }).toBuffer();
    if (output.length <= PIPELINE_IMAGE_LIMITS.publicImageBytes) return imageDataUrl(output, "image/webp");
  }
  throw new ImageInputError("The display image could not be reduced to a safe response size.");
}

function unavailablePrice(): PriceSuggestion {
  return { range: null, quick_sale: null, currency: "EUR", sources: [], text: "Price estimate unavailable. No price or minimum has been assumed; set your own price." };
}

function frameSizeFromResult(result: SamResult): { width: number; height: number } | null {
  // SAM's parser keeps mask bounds but intentionally drops the frame dimensions
  // from the typed box record. They are still present in rawOutput, and are
  // essential when the API resizes a 1920x1280 upload to (for example) 1024x683.
  const box = result.rawOutput.match(/<\|box;([^|]+)\|>/)?.[1];
  const width = box?.match(/(?:^|;)w=(\d+)(?:;|$)/)?.[1];
  const height = box?.match(/(?:^|;)h=(\d+)(?:;|$)/)?.[1];
  if (!width || !height) return null;
  return { width: Number(width), height: Number(height) };
}

async function maskToAlpha(input: Buffer, mask: ReturnType<typeof masksFromResult>[number], result?: SamResult) {
  const metadata = await sharp(input).metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const raster = (await import("@meta-sam/parser")).decodeMaskToRaster(mask.mask);
  const frame = frameSizeFromResult(result ?? ({ rawOutput: "" } as SamResult)) ?? { width, height };
  const frameWidth = frame.width;
  const frameHeight = frame.height;
  const left = Math.max(0, Math.round(mask.bounds.left * width / frameWidth));
  const top = Math.max(0, Math.round(mask.bounds.top * height / frameHeight));
  const targetWidth = Math.min(width - left, Math.max(1, Math.round((mask.bounds.right - mask.bounds.left) * width / frameWidth)));
  const targetHeight = Math.min(height - top, Math.max(1, Math.round((mask.bounds.bottom - mask.bounds.top) * height / frameHeight)));
  // decodeMaskToRaster returns one-bit values (0/1), while an 8-bit PNG alpha
  // channel expects 0/255. Passing 1 made every foreground pixel effectively
  // transparent and hid this bug in a generated fixture spot-check.
  const alphaRaster = Buffer.alloc(raster.length);
  for (let index = 0; index < raster.length; index += 1) alphaRaster[index] = raster[index] ? 255 : 0;
  const resized = await sharp(alphaRaster, { raw: { width: mask.mask.width, height: mask.mask.height, channels: 1 } })
    .resize(targetWidth, targetHeight, { kernel: "nearest" })
    // Sharp otherwise expands grayscale to RGB. The row copy below requires
    // exactly one byte per pixel, not an interleaved three-channel buffer.
    .extractChannel(0).raw().toBuffer();
  const alpha = Buffer.alloc(width * height);
  for (let row = 0; row < targetHeight; row += 1) {
    resized.copy(alpha, (top + row) * width + left, row * targetWidth, (row + 1) * targetWidth);
  }
  return alpha;
}

export class SegmentationError extends Error {
  constructor(message = "SAM did not return a usable mask for this item. No cutout was created.") {
    super(message);
    this.name = "SegmentationError";
  }
}

export async function makeCutout(input: Buffer, samResult: Awaited<ReturnType<typeof segmentConcept>>["result"]) {
  const masks = masksFromResult(samResult);
  // Fail closed: an empty mask must never be presented as a successful
  // cutout. The caller surfaces this as an honest segmentation failure.
  if (masks.length === 0) throw new SegmentationError();
  // Union every returned mask so multi-part items are not truncated to the
  // first region.
  let alpha = await maskToAlpha(input, masks[0], samResult);
  for (const mask of masks.slice(1)) {
    const next = await maskToAlpha(input, mask, samResult);
    for (let i = 0; i < alpha.length; i += 1) if (next[i] > alpha[i]) alpha[i] = next[i];
  }
  const metadata = await sharp(input).metadata();
  // Materialize the RGB image before joining: Sharp can optimize a chained
  // removeAlpha().joinChannel() back to RGB and silently discard the channel.
  const rgb = await sharp(input).removeAlpha().png().toBuffer();
  return sharp(rgb).joinChannel(alpha, { raw: { width: metadata.width!, height: metadata.height!, channels: 1 } }).png().toBuffer();
}

function toPixels(bbox: [number, number, number, number], width: number, height: number): [number, number, number, number] {
  return [
    Math.max(0, Math.round(bbox[0] * width / 1000)), Math.max(0, Math.round(bbox[1] * height / 1000)),
    Math.min(width, Math.round(bbox[2] * width / 1000)), Math.min(height, Math.round(bbox[3] * height / 1000)),
  ];
}

// Hand-drawn numeric paths, not a font. The same 1-based numbers label the
// descriptive defect list in the UI; the image renderer needs no fontconfig.
const markerDigits = [
  "M1 2 Q1 1 3 1 Q5 1 5 2 V8 Q5 9 3 9 Q1 9 1 8 Z",
  "M1 3 L3 1 V9 M1 9 H5",
  "M1 2 Q1 1 3 1 Q5 1 5 3 Q5 4 3 6 L1 9 H5",
  "M1 1 H5 L3 5 Q5 5 5 7 Q5 9 3 9 H1",
  "M4 9 V1 L1 6 H5",
  "M5 1 H1 V5 H3 Q5 5 5 7 Q5 9 3 9 H1",
  "M5 1 H3 Q1 1 1 5 V7 Q1 9 3 9 Q5 9 5 7 Q5 5 3 5 H1",
  "M1 1 H5 L2 9",
  "M3 5 Q1 5 1 3 Q1 1 3 1 Q5 1 5 3 Q5 5 3 5 Q1 5 1 7 Q1 9 3 9 Q5 9 5 7 Q5 5 3 5",
  "M1 9 H3 Q5 9 5 5 V3 Q5 1 3 1 Q1 1 1 3 Q1 5 3 5 H5",
];

export function conditionOverlaySvg(width: number, height: number, defects: Array<Defect & { pixels: [number, number, number, number] }>): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new ImageInputError("Invalid condition-map dimensions.");
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0));
  const occupied: Array<[number, number, number, number]> = [];
  const boxes: string[] = [];
  const shapes = defects.map((defect, index) => {
    const [ax, ay, bx, by] = defect.pixels;
    const x1 = clamp(Math.min(ax, bx), width - 1);
    const y1 = clamp(Math.min(ay, by), height - 1);
    const x2 = Math.max(x1 + 1, clamp(Math.max(ax, bx), width));
    const y2 = Math.max(y1 + 1, clamp(Math.max(ay, by), height));
    const number = String(index + 1);
    const badgeHeight = Math.min(width, height, Math.max(28, Math.round(width / 36)));
    const badgeWidth = Math.min(width, badgeHeight * (0.65 * number.length + 0.35));
    const gap = Math.min(8, badgeHeight / 5);
    const candidates = [[x1, y1 - badgeHeight - gap], [x1, y2 + gap], [x2 - badgeWidth, y1 - badgeHeight - gap], [x2 - badgeWidth, y2 + gap], [x1, y1]];
    let badgeX = 0, badgeY = 0;
    for (const [candidateX, candidateY] of candidates) {
      badgeX = clamp(candidateX, width - badgeWidth);
      badgeY = clamp(candidateY, height - badgeHeight);
      if (!occupied.some(([x, y, w, h]) => badgeX < x + w + gap && badgeX + badgeWidth + gap > x && badgeY < y + h + gap && badgeY + badgeHeight + gap > y)) break;
    }
    occupied.push([badgeX, badgeY, badgeWidth, badgeHeight]);
    const glyphWidth = number.length * 7 - 1;
    const scale = Math.min(badgeWidth * 0.72 / glyphWidth, badgeHeight * 0.72 / 10);
    const glyphX = badgeX + (badgeWidth - glyphWidth * scale) / 2;
    const glyphY = badgeY + (badgeHeight - 10 * scale) / 2;
    const digits = [...number].map((digit, position) => `<path d="${markerDigits[Number(digit)]}" transform="translate(${position * 7} 0)"/>`).join("");
    boxes.push(`<rect data-kind="defect-box" x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" fill="#f43f5e" fill-opacity="0.12" stroke="#e11d48" stroke-width="${Math.min(width, height, Math.max(2, Math.round(width / 400)))}"/>`);
    return `<rect data-kind="number-badge" data-marker="${number}" x="${badgeX}" y="${badgeY}" width="${badgeWidth}" height="${badgeHeight}" rx="${Math.min(5, badgeHeight / 6)}" fill="#fffdf8" fill-opacity="0.96" stroke="#e11d48" stroke-width="${Math.min(2, badgeHeight / 10)}"/><g transform="translate(${glyphX} ${glyphY}) scale(${scale})" fill="none" stroke="#9f1239" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">${digits}</g>`;
  }).join("");
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${boxes.join("")}${shapes}</svg>`;
}

export async function conditionOverlay(input: Buffer, defects: Array<Defect & { pixels: [number, number, number, number] }>) {
  const meta = await sharp(input).metadata();
  const svg = conditionOverlaySvg(meta.width ?? 1000, meta.height ?? 1000, defects);
  return sharp(input).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
}

async function defectsInsideItemMask(cutout: Buffer, defects: Array<Defect & { pixels: [number, number, number, number] }>) {
  const { data, info } = await sharp(cutout).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  return defects.filter((defect) => {
    const [x1, y1, x2, y2] = defect.pixels;
    const left = Math.max(0, Math.min(info.width - 1, x1));
    const top = Math.max(0, Math.min(info.height - 1, y1));
    const right = Math.max(left + 1, Math.min(info.width, x2));
    const bottom = Math.max(top + 1, Math.min(info.height, y2));
    let opaque = 0;
    let total = 0;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        total += 1;
        if (data[y * info.width + x] > 16) opaque += 1;
      }
    }
    const center = data[Math.floor((top + bottom - 1) / 2) * info.width + Math.floor((left + right - 1) / 2)] > 16;
    return center || opaque / Math.max(1, total) >= 0.35;
  });
}

export async function runSellPipeline(input: Buffer, mime = "image/png"): Promise<SellPipelineResult> {
  // Inspect real image bytes and normalize before any paid model invocation.
  input = await normalizePipelineInput(input);
  mime = "image/png";
  const originalDataUrl = await publicImageDataUrl(input);
  // Feed SAM the concrete noun phrase Spark returned for this item. A vague
  // phrase such as "foreground object" can return an empty stream, so only
  // fall back to the item category, never to a generic placeholder.
  const listing = await identifyListing(input, mime);
  const generic = /^(foreground object|object|item|thing|product)$/i;
  const concept = !generic.test(listing.listing.sam_concept.trim())
    ? listing.listing.sam_concept.trim()
    : listing.listing.category.trim() || listing.listing.title.trim();
  // Price research only needs the listing text, so it runs concurrently
  // with the image work instead of adding its full latency at the end.
  // Attach the rejection handler immediately: if SAM fails before we await
  // research, a concurrent pricing error must not become an unhandled rejection.
  const pricePromise = priceGrounding(`${listing.listing.title}, ${listing.listing.category}, ${listing.listing.condition}, used resale price`)
    .catch(() => unavailablePrice());
  const sam = await segmentConcept(input, mime, concept);
  const cutout = await makeCutout(input, sam.result);
  const segmentation = { status: "ok" as const, maskCount: masksFromResult(sam.result).length };
  const grounding = await groundDefects(input, mime);
  const meta = await sharp(input).metadata();
  const width = meta.width ?? 1000;
  const height = meta.height ?? 1000;
  const groundedDefects = grounding.grounding.defects.map((defect) => ({ ...defect, pixels: toPixels(defect.bbox, width, height) }));
  const defects = await defectsInsideItemMask(cutout, groundedDefects);
  // SAM box prompts for thin defects were diagnostic-only (they segment
  // the whole item), so they are no longer paid for or awaited on the hot
  // path. The visible map stays grounded in Spark's boxes.
  const overlay = await conditionOverlay(input, defects);
  const hero = await createHero(cutout);
  const priceSuggestion = await pricePromise;
  const pricedListing = { ...listing.listing, priceSuggestion };
  return {
    mode: getMode(),
    segmentation,
    originalDataUrl,
    cutoutDataUrl: await publicImageDataUrl(cutout),
    heroDataUrl: await publicImageDataUrl(hero.image),
    condition: { defects, overlayDataUrl: await publicImageDataUrl(overlay) },
    listing: pricedListing,
    raw: { sam: sam.raw, listing: listing.raw, grounding: grounding.raw, defectSam: null, hero: hero.raw, price: priceSuggestion },
  };
}
