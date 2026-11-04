export type Mode = "mock" | "real";

export type ListingDraft = {
  title: string;
  category: string;
  condition: string;
  description: string;
  brand: string | null;
  model: string | null;
  facts_confirmed: string[];
  facts_unknown: string[];
  questions_for_owner: string[];
  /** Short concrete noun phrase for SAM, e.g. "wooden chair". */
  sam_concept: string;
  priceSuggestion?: PriceSuggestion;
};

export type PriceSource = { title: string; url: string; snippet?: string };

export type PriceSuggestion = {
  range: [number, number] | null;
  quick_sale: number | null;
  currency: string;
  sources: PriceSource[];
  text?: string;
};

export type OwnerPolicy = {
  minPrice: number | null;
  currency: string;
  pickupOnly: boolean;
  pickupWindows: string[];
  availability: string | null;
  facts: string[];
  sourceTranscript?: string;
};

export type DealCard = {
  id: string;
  buyer: string;
  price: number | null;
  currency: string;
  pickupSlot: string | null;
  summary: string;
  question: string;
  status: "pending" | "accepted" | "declined" | "closed";
  persona?: string;
};

export type AgentMessage = {
  id: string;
  sender: "counterpart" | "agent" | "owner" | "system";
  text: string;
  handledByAgent: boolean;
  createdAt: string;
};

export type AgentTurnResult = {
  reply: string;
  tool: string | null;
  toolResult: Record<string, unknown> | null;
  dealCard: DealCard | null;
  message: AgentMessage;
  mode: Mode;
};

export type SimulationPersona = {
  id: string;
  label: string;
  description: string;
  messages: string[];
};

export type SimulationResult = {
  mode: Mode;
  messages: AgentMessage[];
  dealCards: DealCard[];
  metrics: { handledByAgent: number; humanRead: number };
  personas: Array<{ id: string; label: string; messages: AgentMessage[] }>;
};

export type Defect = {
  label: string;
  bbox: [number, number, number, number];
};

export type Grounding = { defects: Defect[] };

export type FindRequest = {
  id: string;
  need: string;
  budget: number | null;
  currency: string;
  mustWork: boolean;
};

export type FindOffer = {
  id: string;
  requestId: string;
  sellerMessage: string;
  itemTitle: string | null;
  price: number | null;
  currency: string;
  status: "qualified" | "needs-info" | "rejected";
  reasons: string[];
  questions: string[];
  card: DealCard | null;
  createdAt: string;
};

export type ConditionMap = {
  defects: Array<Defect & { pixels: [number, number, number, number] }>;
  overlayDataUrl: string;
};

export type SellPipelineResult = {
  mode: Mode;
  segmentation: { status: "ok"; maskCount: number };
  originalDataUrl: string;
  cutoutDataUrl: string;
  heroDataUrl: string;
  condition: ConditionMap;
  listing: ListingDraft;
  raw: Record<string, unknown>;
};
