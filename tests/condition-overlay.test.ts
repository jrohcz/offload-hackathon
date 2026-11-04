import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { conditionOverlay, conditionOverlaySvg } from "@/lib/pipeline";
import type { Defect } from "@/lib/types";
const defect = (label: string, pixels: [number, number, number, number]): Defect & { pixels: [number, number, number, number] } => ({ label, pixels, bbox: [0, 0, 1000, 1000] });

describe("font-independent condition map", () => {
  it("uses vector numbers matching the 1-based list, never font/text or embedded defect content", () => {
    const defects = Array.from({ length: 12 }, (_, i) => defect(`Prasklina <text> & scratches ${i}`, [5 + i, 5, 50, 50]));
    const svg = conditionOverlaySvg(400, 300, defects);
    expect(svg).not.toMatch(/<text|font|Prasklina|scratches/);
    expect(svg.match(/data-kind="defect-box"/g)).toHaveLength(12);
    expect(svg.match(/data-kind="number-badge"/g)).toHaveLength(12);
    expect(svg).toContain('data-marker="1"');
    expect(svg).toContain('data-marker="12"');
    expect(svg.lastIndexOf('data-kind="defect-box"')).toBeLessThan(svg.indexOf('data-kind="number-badge"'));
    expect(svg.match(/<path /g)).toHaveLength(15); // 1–9 + two digits each for 10–12
  });

  it.each([[400, 300], [10, 8], [1, 1]])("keeps marker and box geometry within %sx%s for reversed/outside coordinates", (width, height) => {
    const svg = conditionOverlaySvg(width, height, [defect("outside", [-50, -30, width + 60, height + 60]), defect("reversed", [width + 100, height + 100, -20, -20])]);
    for (const rect of svg.matchAll(/<rect\b([^>]+)>/g)) {
      const attr = (name: string) => Number(rect[1].match(new RegExp(`\\b${name}="([^"]+)"`))?.[1]);
      expect(attr("x")).toBeGreaterThanOrEqual(0);
      expect(attr("y")).toBeGreaterThanOrEqual(0);
      expect(attr("width")).toBeGreaterThan(0);
      expect(attr("height")).toBeGreaterThan(0);
      expect(attr("x") + attr("width")).toBeLessThanOrEqual(width);
      expect(attr("y") + attr("height")).toBeLessThanOrEqual(height);
    }
    expect(svg).not.toMatch(/NaN|Infinity/);
  });

  it("rasterizes with visible red annotations and preserves dimensions", async () => {
    const input = await sharp({ create: { width: 240, height: 160, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const result = await conditionOverlay(input, [defect("Český popis never rendered as text", [50, 60, 170, 120])]);
    const { data, info } = await sharp(result).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 240, height: 160, channels: 3 });
    let redPixels = 0;
    for (let i = 0; i < data.length; i += 3) if (data[i] > data[i + 1] * 1.5 && data[i] > data[i + 2] * 1.3) redPixels++;
    expect(redPixels).toBeGreaterThan(300);
  });
});
