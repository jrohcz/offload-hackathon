import imageFixture from "@/fixtures/image-edit.json";
import sharp from "sharp";
import { getClient, getMode, logCall, toFile, IMAGE_MODEL } from "@/lib/meta/client";

export async function createHero(cutout: Buffer) {
  const mode = getMode();
  if (mode === "mock") {
    const meta = await sharp(cutout).metadata();
    const width = meta.width ?? 1000;
    const height = meta.height ?? 1000;
    const background = await sharp({ create: { width, height, channels: 4, background: { r: 242, g: 242, b: 239, alpha: 1 } } })
      .composite([{ input: cutout, left: 0, top: 0 }]).png().toBuffer();
    logCall({ capability: "muse-image-hero", model: IMAGE_MODEL, mode, raw: { ...imageFixture, data: [{ b64_json: "mock-generated-from-cutout" }] }, units: 1 });
    return { image: background, raw: imageFixture };
  }
  const client = getClient();
  const response = await client.images.edit({
    model: IMAGE_MODEL,
    prompt: "Create a clean resale listing hero shot on a neutral light background. Preserve the item exactly: same shape, colors, branding, wear, cracks, scratches and missing parts. Do not repair, remove, invent, or hide any defect.",
    image: await toFile(cutout, "cutout.png", { type: "image/png" }),
    n: 1,
    response_format: "b64_json",
  } as any, { maxRetries: 1, timeout: 60_000 });
  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error("Muse Image returned no b64_json image");
  // Do not duplicate multi-megabyte base64 pixels in raw diagnostics or logs.
  // The pixels have their own bounded display encoding in the pipeline.
  const raw = {
    ...response,
    data: response.data?.map(({ b64_json: _pixels, ...metadata }) => metadata),
  };
  logCall({ capability: "muse-image-hero", model: IMAGE_MODEL, mode, raw, units: 1, estimatedUsd: 0.01 });
  if (b64.length > 32 * 1024 * 1024) throw new Error("Muse Image returned an oversized image");
  const source = sharp(Buffer.from(b64, "base64"), { limitInputPixels: 40_000_000, failOn: "error" });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error("Muse Image did not return a valid still image");
  // Internal PNG stays lossless. Only orientation and bounded proportional
  // sizing are applied; transport compression happens after all image work.
  const image = await source.rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  return { image, raw };
}
