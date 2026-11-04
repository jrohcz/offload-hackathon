import samFixture from "@/fixtures/sam-image-stream.json";
import { buildObjectPrompt, decodeMaskToRaster, parseImageStream, recordsOfKind } from "@meta-sam/parser";
import { getClient, getMode, logCall, SAM_MODEL, toFile } from "@/lib/meta/client";
import type { SegmentationMaskRecord } from "@meta-sam/parser";

type SamEvent = { type: string; [key: string]: unknown };

async function parseSamEvents(events: SamEvent[]) {
  async function* source() { for (const event of events) yield event; }
  return parseImageStream(source()).finalResult;
}

export async function segmentConcept(image: Buffer, mime = "image/png", concept = "foreground object") {
  const mode = getMode();
  if (mode === "mock") {
    const result = await parseSamEvents(samFixture as SamEvent[]);
    logCall({ capability: "sam-concept-cutout", model: SAM_MODEL, mode, raw: samFixture, units: 1 });
    return { result, raw: samFixture };
  }
  const client = getClient();
  // SAM's image backend is more reliable with a short-lived Files API
  // reference than with an inline data URL (Spark accepts both).  Keep the
  // upload ephemeral and remove it after the streamed response is consumed.
  const uploaded = await client.files.create({
    file: await toFile(image, "offload-input", { type: mime }),
    purpose: "user_data",
    expires_after: { anchor: "created_at", seconds: 3600 },
  } as any);
  try {
    const stream = await client.responses.create({
      model: SAM_MODEL,
      input: [{ type: "message", role: "user", content: [
        // SAM's concept route expects a short noun phrase. A vague phrase such
        // as "the main item" can yield a valid empty response on real photos.
        { type: "input_text", text: concept },
        { type: "input_image", file_id: uploaded.id },
      ] }],
      stream: true,
    } as any);
    const events: SamEvent[] = [];
    for await (const event of stream as any) events.push(event);
    const result = await parseSamEvents(events);
    const completed = events.find((event) => event.type === "response.completed");
    logCall({ capability: "sam-concept-cutout", model: SAM_MODEL, mode, raw: events, units: 1, estimatedUsd: 0.0025 });
    return { result, raw: completed ?? events };
  } finally {
    await client.files.delete(uploaded.id).catch(() => undefined);
  }
}

export async function segmentBoxes(image: Buffer, mime: string, size: { width: number; height: number }, boxes: Array<{ id: number; left: number; top: number; right: number; bottom: number }>) {
  const mode = getMode();
  if (mode === "mock") {
    const result = await parseSamEvents(samFixture as SamEvent[]);
    logCall({ capability: "sam-box-defects", model: SAM_MODEL, mode, raw: samFixture, units: 1 });
    return { result, raw: samFixture };
  }
  const client = getClient();
  const text = buildObjectPrompt({ size, objects: boxes.map((box) => ({ id: box.id, prompts: [{ box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom } }] })) });
  const uploaded = await client.files.create({
    file: await toFile(image, "offload-input", { type: mime }),
    purpose: "user_data",
    expires_after: { anchor: "created_at", seconds: 3600 },
  } as any);
  try {
    const stream = await client.responses.create({
      model: SAM_MODEL,
      input: [{ type: "message", role: "user", content: [
        { type: "input_text", text },
        { type: "input_image", file_id: uploaded.id },
      ] }], stream: true,
    } as any);
    const events: SamEvent[] = [];
    for await (const event of stream as any) events.push(event);
    const result = await parseSamEvents(events);
    logCall({ capability: "sam-box-defects", model: SAM_MODEL, mode, raw: events, units: 1, estimatedUsd: 0.0025 });
    return { result, raw: events };
  } finally {
    await client.files.delete(uploaded.id).catch(() => undefined);
  }
}

export function masksFromResult(result: Awaited<ReturnType<typeof parseSamEvents>>) {
  return recordsOfKind(result.records, "mask") as readonly SegmentationMaskRecord[];
}

export { decodeMaskToRaster };
