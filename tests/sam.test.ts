import { describe, expect, it } from "vitest";
import fixture from "../fixtures/sam-image-stream.json";
import { decodeMaskToRaster, parseImageStream, recordsOfKind } from "@meta-sam/parser";

describe("SAM 3.1 grammar and mask decoding", () => {
  it("parses a streamed image record and decodes base85 one-bit data", async () => {
    async function* events() { for (const event of fixture) yield event; }
    const result = await parseImageStream(events()).finalResult;
    const boxes = recordsOfKind(result.records, "box");
    const masks = recordsOfKind(result.records, "mask");
    expect(result.outcome.status).toBe("completed");
    expect(boxes[0]).toMatchObject({ left: 80, top: 60, right: 921, bottom: 901 });
    expect(masks).toHaveLength(1);
    expect(Array.from(decodeMaskToRaster(masks[0].mask))).toEqual([0, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0]);
  });
});
