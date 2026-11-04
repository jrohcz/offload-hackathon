import OpenAI, { toFile } from "openai";
import { recordCall } from "@/lib/db";
import type { Mode } from "@/lib/types";

export const META_BASE_URL = "https://api.meta.ai/v1";
export const SPARK_MODEL = "muse-spark-1.3";
export const SAM_MODEL = "sam-3.1";
export const IMAGE_MODEL = "muse-image-1.0";
export const VOICE_MODEL = "muse-voice-transcribe-1.0";

export function getMode(): Mode {
  if (process.env.OFFLOAD_MOCK === "1") return "mock";
  if (!process.env.MODEL_API_KEY) throw new Error("Live Meta service is not configured. Explicit mock mode is required for fixtures.");
  return "real";
}

export function getClient() {
  const key = process.env.MODEL_API_KEY;
  if (!key) throw new Error("MODEL_API_KEY is not set; use mock mode for local development");
  return new OpenAI({ baseURL: META_BASE_URL, apiKey: key, maxRetries: 0, timeout: 90_000 });
}

export function imageDataUrl(bytes: Buffer, mime = "image/png") {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

export function fileDataUrl(bytes: Buffer, mime = "image/png") {
  return imageDataUrl(bytes, mime);
}

export function outputText(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;
  return (response?.output ?? [])
    .filter((item: any) => item.type === "message")
    .flatMap((item: any) => item.content ?? [])
    .filter((part: any) => part.type === "output_text")
    .map((part: any) => part.text ?? "")
    .join("\n");
}

export function parseJson<T>(text: string): T {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/, "").trim();
  return JSON.parse(trimmed) as T;
}

export function logCall(args: {
  capability: string;
  model: string;
  mode: Mode;
  raw: unknown;
  units?: number;
  estimatedUsd?: number;
}) {
  recordCall({
    capability: args.capability,
    model: args.model,
    mode: args.mode,
    units: args.units ?? 1,
    estimatedUsd: args.estimatedUsd ?? 0,
    rawOutput: args.raw,
  });
}

export function sparkCost(response: any) {
  const usage = response?.usage ?? {};
  const input = Number(usage.input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  const cached = Number(usage.input_tokens_details?.cached_tokens ?? 0);
  return (Math.max(0, input - cached) * 1.25 + output * 4.25 + cached * 0.15) / 1_000_000;
}

export { toFile };
