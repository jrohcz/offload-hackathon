import { getClient, getMode, logCall, outputText, sparkCost, SPARK_MODEL } from "@/lib/meta/client";
import { normalizeCurrency, parseMoneyNumber } from "@/lib/evidence";
import priceFixture from "@/fixtures/search-price.json";
import type { PriceSource, PriceSuggestion } from "@/lib/types";

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function sourcesFromResponse(response: any): PriceSource[] {
  const cited = (response?.output ?? []).flatMap((item: any) => (item?.content ?? []).flatMap((block: any) => (block?.annotations ?? [])
    .filter((annotation: any) => annotation?.type === "url_citation").map((annotation: any) => ({ title: annotation.title ?? annotation.url, url: annotation.url }))));
  const searched = (response?.output ?? []).filter((item: any) => item?.type === "web_search_call")
    .flatMap((item: any) => (item.results ?? []).map((result: any) => ({ title: result.title ?? result.url, url: result.url, ...(typeof result.snippet === "string" ? { snippet: result.snippet.slice(0, 1000) } : {}) })));
  const unique = new Map<string, PriceSource>();
  for (const source of [...cited, ...searched]) {
    const url = safeUrl(source.url);
    if (url && !unique.has(url)) unique.set(url, { ...source, title: String(source.title ?? url).slice(0, 300), url });
  }
  return [...unique.values()];
}
const structuredPriceSchema = {
  type: "object", additionalProperties: false,
  properties: {
    range: { anyOf: [{ type: "object", additionalProperties: false, properties: { low: { type: "number" }, high: { type: "number" } }, required: ["low", "high"] }, { type: "null" }] },
    quick_sale: { type: ["number", "null"] },
    currency: { type: ["string", "null"], enum: ["EUR", "USD", "GBP", "CZK", "PLN", null] },
    sources: { type: "array", items: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, url: { type: "string" } }, required: ["title", "url"] } },
  }, required: ["range", "quick_sale", "currency", "sources"],
} as const;

export async function priceGrounding(query: string): Promise<PriceSuggestion> {
  const mode = getMode();
  if (mode === "mock") {
    logCall({ capability: "web-search-price", model: SPARK_MODEL, mode, raw: priceFixture, units: 1 });
    return priceFixture as PriceSuggestion;
  }
  const response = await getClient().responses.create({
    model: SPARK_MODEL, max_output_tokens: 2048, reasoning: { effort: "low" },
    input: `Find current comparable resale prices for: ${query}. Return only the requested JSON. Use ONE currency for the suggested range and quick_sale. Do not mix asking prices with shipping, deposits or unrelated products. quick_sale is a single recommended total price, not the first number in search results. Use null for range/quick_sale/currency when evidence is missing or incompatible. Include only source URLs actually returned by web search.`,
    max_tool_calls: 3, tools: [{ type: "web_search", search_context_size: "low" }], include: ["web_search_call.results"],
    text: { format: { type: "json_schema", name: "grounded_resale_price", strict: true, schema: structuredPriceSchema } },
  } as any);
  const searchQueries = (response?.output ?? []).filter((item: any) => item?.type === "web_search_call").length;
  logCall({ capability: "web-search-price", model: SPARK_MODEL, mode, raw: response, units: searchQueries, estimatedUsd: sparkCost(response) + searchQueries * 0.0025 });
  return parseGroundedPriceResponse(response);
}

function validAmount(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000; }
function finalText(response: any) {
  const messages = (response?.output ?? []).filter((item: any) => item.type === "message");
  const final = messages.at(-1);
  return final ? outputText({ output: [final] }) : outputText(response);
}

/** Legacy text parsing accepts only explicitly labeled, unambiguous estimates. */
function legacyPrice(text: string): { range: [number, number] | null; quick_sale: number | null; currency: string } {
  const lines = text.replace(/[*`]/g, "").split("\n");
  const entries: Array<{ kind: "range" | "quick"; currency: string; low: number; high: number }> = [];
  const pattern = /\b(EUR|USD|GBP|CZK|PLN)\s*([\d.,]+)(?:\s*[-–]\s*(?:\b(?:EUR|USD|GBP|CZK|PLN)\s*)?([\d.,]+))?/gi;
  for (let index = 0; index < lines.length; index++) {
    const kind = /\bquick[- ]sale(?: price)?\b/i.test(lines[index]) ? "quick" : /\b(?:comparable|resale|suggested|price)\s+range\b/i.test(lines[index]) ? "range" : null;
    if (!kind) continue;
    const fragment = /\b(?:EUR|USD|GBP|CZK|PLN)\s*\d/i.test(lines[index]) ? lines[index] : `${lines[index]} ${lines[index + 1] ?? ""}`;
    for (const match of fragment.matchAll(pattern)) {
      const low = parseMoneyNumber(match[2]); const high = match[3] ? parseMoneyNumber(match[3]) : low;
      if (low !== null && high !== null && high >= low) entries.push({ kind, currency: match[1].toUpperCase(), low, high });
    }
  }
  const currencies = new Set(entries.map((entry) => entry.currency));
  if (currencies.size !== 1) return { range: null, quick_sale: null, currency: "" };
  const ranges = entries.filter((entry) => entry.kind === "range");
  const quick = entries.filter((entry) => entry.kind === "quick");
  return {
    range: ranges.length === 1 ? [ranges[0].low, ranges[0].high] : null,
    quick_sale: quick.length === 1 && quick[0].low === quick[0].high ? quick[0].low : null,
    currency: entries[0]?.currency ?? "",
  };
}

export function parseGroundedPriceResponse(response: any): PriceSuggestion {
  const text = finalText(response);
  const sources = sourcesFromResponse(response);
  const unknown: PriceSuggestion = { range: null, quick_sale: null, currency: "", sources: [], text };
  if (response?.status === "incomplete" || response?.error) return unknown;
  let parsed: any;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")); }
  catch {
    // Old saved outputs are supported conservatively. No labeled estimate or
    // mixed currencies means unknown, never EUR 0 or the first search amount.
    return sources.length ? { ...unknown, ...legacyPrice(text), sources: sources.slice(0, 8) } : unknown;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unknown;
  const currency = typeof parsed.currency === "string" ? normalizeCurrency(parsed.currency) : null;
  if (!currency || !sources.length) return unknown;
  const citedUrls = new Set(sources.map((source) => source.url));
  const selectedSources = Array.isArray(parsed.sources) ? parsed.sources.filter((source: any) => citedUrls.has(safeUrl(source?.url) ?? "")) : [];
  // A model-written URL alone is not web grounding.
  if (!selectedSources.length) return unknown;
  const range: [number, number] | null = parsed.range && validAmount(parsed.range.low) && validAmount(parsed.range.high) && parsed.range.low <= parsed.range.high
    ? [parsed.range.low, parsed.range.high] : null;
  const quick = validAmount(parsed.quick_sale) ? parsed.quick_sale : null;
  return { range, quick_sale: quick, currency, sources: sources.filter((source) => selectedSources.some((selected: any) => safeUrl(selected.url) === source.url)).slice(0, 8), text };
}
