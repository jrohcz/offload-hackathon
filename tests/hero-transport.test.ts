import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createHero } from "@/lib/meta/image";

const client = vi.hoisted(() => ({ edit: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/meta/client", () => ({
  getMode: () => "real",
  getClient: () => ({ images: { edit: client.edit } }),
  logCall: client.log,
  toFile: async (bytes: Buffer) => bytes,
  IMAGE_MODEL: "muse-image-1.0",
}));

describe("hero output boundaries", () => {
  it("caps generated image dimensions and excludes duplicate image bytes from logs and raw response", async () => {
    const source = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#a09080" } }).webp().toBuffer();
    const b64 = source.toString("base64");
    client.edit.mockResolvedValue({ created: 123, data: [{ b64_json: b64, revised_prompt: "Neutral background" }] });
    const result = await createHero(await sharp({ create: { width: 100, height: 100, channels: 4, background: "transparent" } }).png().toBuffer());
    expect(await sharp(result.image).metadata()).toMatchObject({ format: "png", width: 1600, height: 800 });
    expect(result.raw.data?.[0]).not.toHaveProperty("b64_json");
    expect(result.raw.data?.[0]).toMatchObject({ revised_prompt: "Neutral background" });
    expect(JSON.stringify(client.log.mock.calls)).not.toContain(b64);
  });
});
