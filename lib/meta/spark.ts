import listingFixture from "@/fixtures/spark-listing.json";
import groundingFixture from "@/fixtures/spark-grounding.json";
import { getClient, getMode, fileDataUrl, logCall, outputText, parseJson, sparkCost, SPARK_MODEL } from "@/lib/meta/client";
import type { Grounding, ListingDraft, OwnerPolicy } from "@/lib/types";
import { groundingSchema as groundingValidator, listingDraftSchema } from "@/lib/validation";
import { parseOfferMoney } from "@/lib/evidence";

const listingSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" }, category: { type: "string" }, condition: { type: "string" },
    description: { type: "string" }, brand: { type: ["string", "null"] }, model: { type: ["string", "null"] },
    facts_confirmed: { type: "array", items: { type: "string" } },
    facts_unknown: { type: "array", items: { type: "string" } },
    questions_for_owner: { type: "array", items: { type: "string" } },
    sam_concept: { type: "string" },
  },
  required: ["title", "category", "condition", "description", "brand", "model", "facts_confirmed", "facts_unknown", "questions_for_owner", "sam_concept"],
} as const;

const groundingSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    defects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { label: { type: "string" }, bbox: { type: "array", items: { type: "integer" }, minItems: 4, maxItems: 4 } },
        required: ["label", "bbox"],
      },
    },
  },
  required: ["defects"],
} as const;

const ownerPolicySchema = {
  type: "object", additionalProperties: false,
  properties: {
    minPrice: { type: ["number", "null"] }, currency: { type: "string" }, pickupOnly: { type: "boolean" },
    pickupWindows: { type: "array", items: { type: "string" } }, availability: { type: ["string", "null"], enum: ["available", "reserved", "sold", "unavailable", null] },
    facts: { type: "array", items: { type: "string" } },
  },
  required: ["minPrice", "currency", "pickupOnly", "pickupWindows", "availability", "facts"],
} as const;

export function normalizeOwnerPolicy(policy: OwnerPolicy, transcript: string): OwnerPolicy {
  const money = parseOfferMoney(transcript);
  const availability = /\b(?:already sold|it is sold|it's sold|item is sold)\b/i.test(transcript) ? "sold"
    : /\b(?:reserved|on hold)\b/i.test(transcript) && !/\b(?:not|isn't)\s+(?:reserved|on hold)\b/i.test(transcript) ? "reserved"
    : /\b(?:not available|unavailable|no longer available)\b/i.test(transcript) ? "unavailable"
    : /\b(?:still available|it is available|it's available|item is available)\b/i.test(transcript) ? "available" : null;
  // Only the owner's actual words become confirmed facts. Model paraphrases
  // cannot introduce positive working claims or lose a negation.
  const facts = transcript.split(/[.;\n]+|,\s*(?:and\s+)?/i).map((fact) => fact.trim().replace(/^and\s+/i, "")).filter(Boolean);
  const pickupOnly = /\bpick\s*up\b[^.\n;]*\bonly\b|\bonly\b[^.\n;]*\bpick\s*up\b|\bno delivery\b/i.test(transcript)
    && !/\b(?:not|no)\s+pick\s*up\b/i.test(transcript);
  const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const source = normalized(transcript);
  const windows = Array.isArray(policy.pickupWindows) ? policy.pickupWindows.filter((window) => typeof window === "string" && window.trim().length > 0 && source.includes(normalized(window))) : [];
  const explicitMinimum = !/\bno (?:minimum|min price)\b/i.test(transcript) && /\b(?:minimum|min price|at least|no less than|won't take less than|will not take less than)\b/i.test(transcript);
  return {
    minPrice: explicitMinimum && money.status === "known" ? money.amount : null,
    currency: money.status === "known" && money.currency ? money.currency : "EUR",
    pickupOnly,
    pickupWindows: windows,
    availability,
    facts,
  };
}

export async function extractOwnerPolicy(transcript: string): Promise<{ policy: OwnerPolicy; raw: unknown }> {
  const mode = getMode();
  if (mode === "mock") {
    const pickupText = transcript.match(/\bpick\s*up(?:\s+is)?\s+([^.;\n]+)/i)?.[1]?.replace(/\s+only\s*$/i, "").trim();
    const normalized = normalizeOwnerPolicy({ minPrice: null, currency: "EUR", pickupOnly: false, pickupWindows: pickupText ? [pickupText] : [], availability: null, facts: [] }, transcript);
    const policy: OwnerPolicy = { ...normalized, sourceTranscript: transcript };
    logCall({ capability: "voice-policy-extract", model: SPARK_MODEL, mode, raw: policy, units: 1 });
    return { policy, raw: policy };
  }
  const response = await getClient().responses.create({
    model: SPARK_MODEL, max_output_tokens: 2048, reasoning: { effort: "low" },
    input: `Extract only facts and owner policy explicitly stated in this voice transcript. Never infer a price, location, availability, or delivery option. Transcript:\n${transcript}`,
    text: { format: { type: "json_schema", name: "owner_policy", strict: true, schema: ownerPolicySchema } },
  } as any);
  logCall({ capability: "voice-policy-extract", model: SPARK_MODEL, mode, raw: response, units: 1, estimatedUsd: sparkCost(response) });
  const policy = normalizeOwnerPolicy(parseJson<OwnerPolicy>(outputText(response)), transcript);
  const withTranscript = { ...policy, sourceTranscript: transcript };
  return { policy: withTranscript, raw: response };
}

export async function identifyListing(image: Buffer, mime = "image/png") {
  const mode = getMode();
  if (mode === "mock") {
    const listing = listingDraftSchema.parse(parseJson<ListingDraft>(outputText(listingFixture)));
    logCall({ capability: "identify-and-list", model: SPARK_MODEL, mode, raw: listingFixture, units: 1 });
    return { listing, raw: listingFixture };
  }
  const client = getClient();
  const response = await client.responses.create({
    model: SPARK_MODEL, max_output_tokens: 4096, reasoning: { effort: "low" },
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "Identify the item for an honest resale listing. Only claim facts visible in the photo. Return title, category, condition, description, brand/model when legible, facts_confirmed, facts_unknown, questions_for_owner, and sam_concept. sam_concept is a short concrete noun phrase (2-5 words, no marketing adjectives) naming the main item, e.g. 'turntable record player', 'wooden chair', 'road bicycle'. Never guess unknown facts." },
      { type: "input_image", image_url: fileDataUrl(image, mime) },
    ] }],
    text: { format: { type: "json_schema", name: "listing_draft", strict: true, schema: listingSchema } },
  } as any);
  logCall({ capability: "identify-and-list", model: SPARK_MODEL, mode, raw: response, units: 1, estimatedUsd: sparkCost(response) });
  const listing = listingDraftSchema.parse(parseJson<ListingDraft>(outputText(response)));
  return { listing, raw: response };
}

export async function groundDefects(image: Buffer, mime = "image/png") {
  const mode = getMode();
  if (mode === "mock") {
    const grounding = groundingValidator.parse(parseJson<Grounding>(outputText(groundingFixture)));
    logCall({ capability: "perception-grounding", model: SPARK_MODEL, mode, raw: groundingFixture, units: 1 });
    return { grounding, raw: groundingFixture };
  }
  const client = getClient();
  const response = await client.responses.create({
    model: SPARK_MODEL, max_output_tokens: 4096, reasoning: { effort: "low" },
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "You are an object grounding expert. Locate every visible defect such as scratches, chips, stains, cracks, or missing parts. Return JSON with defects, each containing label and bbox [x_min,y_min,x_max,y_max] on a normalized 0-1000 grid. Omit defects you cannot see." },
      { type: "input_image", image_url: fileDataUrl(image, mime) },
    ] }],
    text: { format: { type: "json_schema", name: "condition_map", strict: true, schema: groundingSchema } },
  } as any);
  logCall({ capability: "perception-grounding", model: SPARK_MODEL, mode, raw: response, units: 1, estimatedUsd: sparkCost(response) });
  const grounding = groundingValidator.parse(parseJson<Grounding>(outputText(response)));
  return { grounding, raw: response };
}
