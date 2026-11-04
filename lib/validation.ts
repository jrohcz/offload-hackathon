import { z } from "zod";

export const listingDraftSchema = z.object({
  title: z.string(),
  category: z.string(),
  condition: z.string(),
  description: z.string(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  facts_confirmed: z.array(z.string()),
  facts_unknown: z.array(z.string()),
  questions_for_owner: z.array(z.string()),
  sam_concept: z.string().min(1).default("object"),
});

export const groundingSchema = z.object({
  defects: z.array(z.object({ label: z.string(), bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]) })),
});
