import { z } from "zod";
const text = z.string().max(5000);
const facts = z.array(text).max(50);
export const listingInput = z.object({
  title: text, category: text, condition: text, description: text,
  brand: text.nullable(), model: text.nullable(), facts_confirmed: facts,
  facts_unknown: facts, questions_for_owner: facts, sam_concept: z.string().min(1).max(200),
  priceSuggestion: z.object({ range: z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()]).nullable(), quick_sale: z.number().finite().nonnegative().nullable(), currency: z.string().max(5), sources: z.array(z.object({ title: text, url: z.url().refine(v => /^https?:\/\//.test(v)), snippet: text.optional() })).max(8), text: z.string().max(20000).optional() }).optional(),
});
export const policyInput = z.object({ minPrice: z.number().finite().nonnegative().nullable(), currency: z.enum(["EUR", "USD", "GBP", "CZK", "PLN"]), pickupOnly: z.boolean(), pickupWindows: z.array(z.string().max(500)).max(10), availability: z.enum(["available", "reserved", "sold", "unavailable"]).nullable(), facts, sourceTranscript: text.optional() });
export const decisionInput = z.object({ action: z.literal("decide"), cardId: z.string().min(1).max(100), decision: z.enum(["yes", "no"]) });
