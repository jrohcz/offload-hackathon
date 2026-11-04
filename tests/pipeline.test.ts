import { describe, expect, it, beforeEach } from "vitest";
import sharp from "sharp";
import { decodeMaskToRaster, parseImageStream, recordsOfKind } from "@meta-sam/parser";
import realSamFixture from "../fixtures/real/sam-concept-stream.json";
import { makeCutout, runSellPipeline } from "@/lib/pipeline";

describe("Sell pipeline", () => {
  beforeEach(() => { process.env.OFFLOAD_MOCK = "1"; delete process.env.MODEL_API_KEY; });

  it("runs photo to cutout, condition map, hero, and listing in mock mode", async () => {
    const photo = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#26332e" } }).png().toBuffer();
    const result = await runSellPipeline(photo, "image/png");
    expect(result.mode).toBe("mock");
    expect(result.originalDataUrl).toMatch(/^data:image\/webp;base64,/);
    expect(result.cutoutDataUrl).toMatch(/^data:image\/webp;base64,/);
    expect(result.heroDataUrl).toMatch(/^data:image\/webp;base64,/);
    expect(result.listing.questions_for_owner.length).toBeGreaterThan(0);
    expect(result.condition.defects[0].label).toContain("crack");
    expect(result.raw.defectSam).toBeNull();
  });

  it("scales and applies the real SAM frame mask instead of returning the original photo", async () => {
    delete process.env.OFFLOAD_MOCK;
    async function* events() { for (const event of realSamFixture) yield event; }
    const samResult = await parseImageStream(events()).finalResult;
    expect(recordsOfKind(samResult.records, "mask")).toHaveLength(1);
    const photo = await sharp("fixtures/real/sell-flow-original.png").png().toBuffer();
    const cutout = await makeCutout(photo, samResult);
    const { data, info } = await sharp(cutout).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let transparent = 0;
    let opaque = 0;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] < 16) transparent += 1;
      if (data[index] > 240) opaque += 1;
    }
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1280);
    expect(transparent / (info.width * info.height)).toBeGreaterThan(0.35);
    // This point is inside the 1024x683 SAM box after scaling to 1920x1280.
    const center = ((Math.floor(info.height * 0.48) * info.width) + Math.floor(info.width * 0.52)) * 4 + 3;
    expect(data[center]).toBeGreaterThan(240);
    expect(opaque).toBeGreaterThan(100_000);

    // Transparency counts alone miss a corrupted row stride: Sharp expands a
    // one-channel input to RGB unless the output channel is selected explicitly.
    // Compare stable interior points against the provider's actual mask shape.
    const mask = recordsOfKind(samResult.records, "mask")[0];
    const raster = decodeMaskToRaster(mask.mask);
    const left = Math.round(mask.bounds.left * info.width / 1024);
    const top = Math.round(mask.bounds.top * info.height / 683);
    const scaledWidth = Math.round((mask.bounds.right - mask.bounds.left) * info.width / 1024);
    const scaledHeight = Math.round((mask.bounds.bottom - mask.bounds.top) * info.height / 683);
    let checkedForeground = 0;
    let checkedBackground = 0;
    let mismatches = 0;
    for (let y = 2; y < mask.mask.height - 2; y += 8) {
      for (let x = 2; x < mask.mask.width - 2; x += 8) {
        const expected = raster[y * mask.mask.width + x];
        const stable = [-1, 0, 1].every((dy) => [-1, 0, 1].every((dx) =>
          raster[(y + dy) * mask.mask.width + x + dx] === expected));
        if (!stable) continue;
        const outputX = left + Math.floor((x + 0.5) * scaledWidth / mask.mask.width);
        const outputY = top + Math.floor((y + 0.5) * scaledHeight / mask.mask.height);
        const actual = data[(outputY * info.width + outputX) * 4 + 3];
        if (actual !== expected * 255) mismatches += 1;
        if (expected) checkedForeground += 1;
        else checkedBackground += 1;
      }
    }
    expect(checkedForeground).toBeGreaterThan(100);
    expect(checkedBackground).toBeGreaterThan(100);
    expect(mismatches).toBe(0);
  });
});
