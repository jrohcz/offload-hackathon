import { z } from "zod";
import { getClient, getMode, logCall, outputText, parseJson, sparkCost, SPARK_MODEL } from "@/lib/meta/client";
import { normalizeCurrency, parseOfferMoney, pickupEvidence, workingEvidence } from "@/lib/evidence";
import simulatorFixture from "@/fixtures/simulator.json";
import type { AgentMessage, AgentTurnResult, DealCard, ListingDraft, OwnerPolicy, SimulationPersona, SimulationResult } from "@/lib/types";

type AgentContext = { listing: ListingDraft; policy: OwnerPolicy; persona?: string; sourceText?: string };
type ToolResult = { result: Record<string, unknown>; reply: string; card: DealCard | null };
type ToolTurn = ToolResult & { name: string; args: unknown; raw?: unknown };

export const AGENT_TOOLS = [
  { type: "function", name: "answer_from_listing", description: "Reply with an exact verbatim confirmed listing or owner policy fact. Never invent or paraphrase facts.", parameters: { type: "object", additionalProperties: false, properties: { fact: { type: "string" } }, required: ["fact"] }, strict: true },
  { type: "function", name: "ask_owner_yes_no", description: "Request one owner decision for a concrete, policy-compliant buyer offer. The server independently validates the offer.", parameters: { type: "object", additionalProperties: false, properties: { buyer: { type: "string" }, price: { type: ["number", "null"] }, currency: { type: "string" }, pickupSlot: { type: ["string", "null"] }, reason: { type: "string" }, question: { type: "string" } }, required: ["buyer", "price", "currency", "pickupSlot", "reason", "question"] }, strict: true },
  { type: "function", name: "ask_owner_fact", description: "Ask up to three factual questions not answered by confirmed evidence. Never announce an owner decision.", parameters: { type: "object", additionalProperties: false, properties: { questions: { type: "array", items: { type: "string" } } }, required: ["questions"] }, strict: true },
  { type: "function", name: "request_counterpart_info", description: "Ask the counterpart to clarify missing or conflicting offer details.", parameters: { type: "object", additionalProperties: false, properties: { questions: { type: "array", items: { type: "string" } } }, required: ["questions"] }, strict: true },
  { type: "function", name: "propose_pickup_slot", description: "Report an affirmed counterpart pickup time or propose an exact owner window. This does not accept a deal.", parameters: { type: "object", additionalProperties: false, properties: { slot: { type: ["string", "null"] }, basis: { type: "string" } }, required: ["slot", "basis"] }, strict: true },
  { type: "function", name: "flag_not_serious", description: "Decline a suspicious or non-compliant message. The server generates the reply; free-form model reply text is never used.", parameters: { type: "object", additionalProperties: false, properties: { reason: { type: "string" }, reply: { type: "string" } }, required: ["reason", "reply"] }, strict: true },
] as const;

const boundedText = z.string().trim().min(1).max(2000);
const toolSchemas: Record<string, z.ZodType> = {
  answer_from_listing: z.object({ fact: boundedText }).strict(),
  ask_owner_yes_no: z.object({ buyer: boundedText, price: z.number().finite().nonnegative().nullable(), currency: z.string().max(12), pickupSlot: z.string().max(200).nullable(), reason: boundedText, question: boundedText }).strict(),
  ask_owner_fact: z.object({ questions: z.array(boundedText).min(1).max(3) }).strict(),
  request_counterpart_info: z.object({ questions: z.array(boundedText).max(3) }).strict(),
  propose_pickup_slot: z.object({ slot: z.string().max(200).nullable(), basis: boundedText }).strict(),
  flag_not_serious: z.object({ reason: boundedText, reply: z.string().max(2000) }).strict(),
};

export const SIMULATION_PERSONAS: SimulationPersona[] = simulatorFixture as SimulationPersona[];
let cardSequence = 0;
function nextId(prefix: string) { cardSequence += 1; return `${prefix}-${Date.now()}-${cardSequence}`; }
function nowMessage(sender: AgentMessage["sender"], text: string, handledByAgent = true): AgentMessage {
  return { id: nextId("msg"), sender, text, handledByAgent, createdAt: new Date().toISOString() };
}

/** Compatibility helper: ambiguous/multiple amounts are no longer silently reduced to the first. */
export function offerPrice(text: string): number | null {
  const money = parseOfferMoney(text);
  return money.status === "known" ? money.amount : null;
}
export function pickupSlot(text: string, _policy?: OwnerPolicy): string | null {
  const pickup = pickupEvidence(text);
  return pickup.status === "offered" ? pickup.slot : null;
}
function normalized(value: string) { return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }

function confirmedFacts(context: AgentContext): string[] {
  const availability: Record<string, string> = { available: "The listing is still available.", reserved: "The listing is reserved.", sold: "The listing is sold.", unavailable: "The listing is not available." };
  return [
    ...context.listing.facts_confirmed,
    ...context.policy.facts,
    ...(context.policy.pickupOnly ? ["Pickup only; delivery is not offered."] : []),
    ...context.policy.pickupWindows.map((window) => `Pickup window: ${window}`),
    ...(context.policy.availability && availability[context.policy.availability] ? [availability[context.policy.availability]] : []),
  ];
}
export function canonicalFact(requested: string, context: AgentContext): string | null {
  // Approximate word overlap erased negation and could answer a different fact.
  const wanted = normalized(requested);
  return wanted ? confirmedFacts(context).find((fact) => normalized(fact) === wanted) ?? null : null;
}

function buyerFactReview(context: AgentContext): { questions: string[]; answers: string[]; negativeAnswers: string[] } {
  const source = context.sourceText ?? "";
  const matches = [...source.matchAll(/(?:\b(?:does|is|can|will|has)\s+(?:it|the\s+(?:item|unit|turntable|bike|bicycle|laptop))\b|\b(?:have|did|do)\s+you\b|\b(?:what|which|how)\b)[^?]*\?/gi)];
  const questions: string[] = []; const answers: string[] = []; const negativeAnswers: string[] = [];
  const clauses = matches.flatMap((match) => match[0].split(/\s+and\s+(?=(?:does|is|can|will|has|have|did|do|what|which|how)\b)/i)).map((question) => question.trim().replace(/\??$/, "?"));
  for (const question of clauses) {
    if (/^is\s+(?:it|the item|the unit|the turntable)\s+(?:still\s+)?available\?$/i.test(question) && context.policy.availability === "available") {
      answers.push("The listing is still available."); continue;
    }
    const asksFunction = /\b(?:work|works|working|power|play|functional|function)\b/i.test(question)
      && !/\b(?:bluetooth|battery|stylus|included|include|brand|model|warranty|price|cables|accessories)\b/i.test(question);
    if (asksFunction) {
      const condition = workingEvidence(...context.policy.facts);
      const supported = context.policy.facts.filter((fact) => workingEvidence(fact).status === condition.status);
      if ((condition.status === "yes" || condition.status === "no") && supported.length) {
        const attributed = supported.map((fact) => `Owner says: ${fact}`);
        if (condition.status === "no") negativeAnswers.push(...attributed);
        else answers.push(...attributed);
        continue;
      }
    }
    questions.push(question);
  }
  return { questions: [...new Set(questions)].slice(0, 3), answers: [...new Set(answers)], negativeAnswers: [...new Set(negativeAnswers)] };
}
function buyerFactQuestions(context: AgentContext): string[] { return buyerFactReview(context).questions; }
function ownerFactTurn(questions: string[]): ToolResult {
  return { result: { queued: true, kind: "owner-fact", questions }, reply: `I need one owner answer: ${questions.join("; ")}`, card: null };
}

function matchesPickupWindow(slot: string, window: string) {
  const simplify = (value: string) => normalized(value).replace(/\b(?:at|this)\b/g, "").replace(/\s+/g, " ").trim();
  const stated = simplify(slot); const offered = simplify(window);
  if (stated === offered || offered.startsWith(`${stated} `) && /\d|morning|afternoon|evening/.test(stated)) return true;
  const ownerSlot = pickupEvidence(`Pickup ${window}`).slot;
  // A day-only owner window permits a more specific affirmed time on that day.
  // It never permits another day or overrides an owner's stated time.
  return Boolean(ownerSlot && !/\d|morning|afternoon|evening/.test(ownerSlot) && stated.startsWith(`${simplify(ownerSlot)} `));
}

type Qualification = { ok: true; price: number; currency: string; slot: string } | { ok: false; rejected: boolean; reason: string };
function qualifyBuyer(context: AgentContext): Qualification {
  const source = context.sourceText?.trim().replace(/[’‘]/g, "'") ?? "";
  const money = parseOfferMoney(source);
  const containsLink = /\b(?:https?:\/\/|www\.)[^\s]+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?:\/[^\s]*)?/i.test(source);
  if (containsLink && /\b(?:pay(?:ment)?s?|paid|link|transfer|checkout|verify|verification|confirm|reserve|secure)\b/i.test(source)) return { ok: false, rejected: true, reason: "Payment links are not accepted. Pickup and payment are handled in person." };
  if (["sold", "reserved", "unavailable"].includes(context.policy.availability ?? "")) return { ok: false, rejected: true, reason: "This listing is not available for another deal." };
  if (money.status !== "known" || money.amount === null || !money.currency) return { ok: false, rejected: false, reason: money.reason ?? "Please confirm one total offered price and currency." };
  const currency = normalizeCurrency(context.policy.currency);
  if (!currency || money.currency !== currency) return { ok: false, rejected: false, reason: `The offer is in ${money.currency}; the seller uses ${currency ?? "an unconfirmed currency"}. Please agree on one currency first.` };
  // A search estimate is not permission to set the owner's sale floor.
  const floor = context.policy.minPrice;
  if (floor !== null && (!Number.isFinite(floor) || floor < 0)) return { ok: false, rejected: false, reason: "The owner's minimum price needs confirmation." };
  if (floor !== null && money.amount < floor) return { ok: false, rejected: true, reason: "Thanks, but that offer is below the seller’s stated minimum." };
  if (/\b(?:cannot|can't|won't|do not|don't|not going to|unable to)\s+(?:(?:want|intend|plan|agree)\s+to\s+)?(?:buy|pay|take|purchase)\b|\bnot\s+(?:buying|paying|purchasing|interested)\b/i.test(source)) return { ok: false, rejected: false, reason: "Please confirm whether you are making an offer." };
  const materialTerms = source.replace(/\bif\s+that\s+works\s+for\s+you\b[?.!]*\s*$/i, "");
  if (/\b(?:if|provided that|subject to|depending on)\b/i.test(materialTerms)) return { ok: false, rejected: false, reason: "This offer has a condition. Please resolve it before asking the owner to accept a deal." };
  const factual = buyerFactReview(context);
  if (factual.negativeAnswers.length) return { ok: false, rejected: false, reason: `${factual.negativeAnswers.join(" ")} Please confirm that you still want to make this offer for the non-working item.` };
  const pickup = pickupEvidence(source);
  if (pickup.status !== "offered" || !pickup.slot) return { ok: false, rejected: false, reason: "Please confirm an available pickup day and time; no agreed pickup is established yet." };
  if (context.policy.pickupOnly && /\b(?:deliver|delivery|shipping|ship it|send it|bring it)\b/i.test(source)) return { ok: false, rejected: false, reason: "Pickup only; delivery is not offered. Please confirm pickup." };
  if (context.policy.pickupWindows.length && !context.policy.pickupWindows.some((window) => matchesPickupWindow(pickup.slot!, window))) return { ok: false, rejected: false, reason: `That pickup does not match the owner's confirmed windows: ${context.policy.pickupWindows.join("; ")}. Please confirm a matching time.` };
  return { ok: true, price: money.amount, currency: money.currency, slot: pickup.slot };
}

function createDealCard(offer: Extract<Qualification, { ok: true }>, persona?: string): DealCard {
  const priceText = `${offer.currency} ${offer.price}`;
  return {
    id: nextId("deal"), buyer: persona === "serious-buyer" ? "Serious buyer" : "Buyer", price: offer.price,
    currency: offer.currency, pickupSlot: offer.slot, summary: `Buyer, ${priceText}, pickup ${offer.slot}.`,
    question: `Accept this offer at ${priceText} with pickup ${offer.slot}?`, status: "pending", persona,
  };
}
function qualifiedTurn(offer: Extract<Qualification, { ok: true }>, context: AgentContext): ToolResult {
  const card = createDealCard(offer, context.persona);
  const answers = buyerFactReview(context).answers;
  return { result: { queued: true, card }, reply: `${answers.length ? `${answers.join(" ")} ` : ""}I found a qualified offer and put one decision card in your inbox.`, card };
}

function denied(reason = "This action is not allowed. No deal or owner decision was recorded."): ToolResult {
  return { result: { allowed: false, reason }, reply: reason, card: null };
}

function localTool(name: string, input: unknown, context: AgentContext): ToolResult {
  const schema = Object.prototype.hasOwnProperty.call(toolSchemas, name) ? toolSchemas[name] : null;
  if (!schema) return denied();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return denied("The requested action had invalid arguments. No deal or owner decision was recorded.");
  const args = parsed.data as any;
  switch (name) {
    case "answer_from_listing": {
      const fact = canonicalFact(args.fact, context);
      return fact ? { result: { allowed: true, fact }, reply: fact, card: null }
        : denied("That detail is not confirmed in the listing, so I cannot claim it.");
    }
    case "propose_pickup_slot": {
      const stated = context.sourceText ? pickupSlot(context.sourceText) : null;
      const offered = args.slot && context.policy.pickupWindows.find((window) => normalized(window) === normalized(args.slot));
      const slot = stated ?? offered ?? null;
      return { result: { slot, basis: stated ? "stated-by-counterpart" : offered ? "owner-window" : "unconfirmed" }, reply: stated ? `The counterpart proposes pickup ${stated}.` : offered ? `The owner offers pickup ${offered}.` : "The pickup time still needs to be agreed.", card: null };
    }
    case "ask_owner_yes_no": {
      const offer = qualifyBuyer(context);
      if (!offer.ok) return denied(offer.reason);
      const questions = buyerFactQuestions(context);
      if (questions.length) return ownerFactTurn(questions);
      return qualifiedTurn(offer, context);
    }
    case "ask_owner_fact": {
      const offer = qualifyBuyer(context);
      if (offer.ok && /\bas[- ]is\b/i.test(context.sourceText ?? "") && !buyerFactQuestions(context).length) {
        return qualifiedTurn(offer, context);
      }
      return ownerFactTurn(args.questions);
    }
    case "request_counterpart_info": {
      // The counterpart's source and server policy decide the clarification text.
      const offer = qualifyBuyer(context);
      if (!offer.ok) return { result: { questions: [offer.reason] }, reply: offer.reason, card: null };
      const questions = buyerFactQuestions(context);
      if (questions.length) return ownerFactTurn(questions);
      // An empty model request is not a new requirement. The source already
      // satisfies every offer gate; queue the decision rather than asking again.
      return qualifiedTurn(offer, context);
    }
    case "flag_not_serious": {
      const offer = qualifyBuyer(context);
      const reply = !offer.ok && offer.rejected ? offer.reason : "I cannot qualify this message as an offer. Please provide a concrete price, currency and pickup time.";
      return { result: { flagged: true, reason: reply }, reply, card: null };
    }
    default: return denied();
  }
}

function deterministicTurn(counterpart: string, context: AgentContext): { name: string; args: any } {
  const text = counterpart.trim();
  const lower = text.toLowerCase();
  const offer = qualifyBuyer(context);
  if (!offer.ok && offer.rejected) return { name: "flag_not_serious", args: { reason: offer.reason, reply: "" } };
  if (/\b(?:deliver|delivery|drop it off|bring it)\b/i.test(text) && context.policy.pickupOnly) return { name: "answer_from_listing", args: { fact: "Pickup only; delivery is not offered." } };
  const money = parseOfferMoney(text);
  if (money.status !== "missing") {
    if (!offer.ok) return { name: "request_counterpart_info", args: { questions: [offer.reason] } };
    const questions = buyerFactQuestions(context);
    if (questions.length) return { name: "ask_owner_fact", args: { questions } };
    return { name: "ask_owner_yes_no", args: { buyer: "Buyer", price: offer.price, currency: offer.currency, pickupSlot: offer.slot, reason: "Buyer stated a compatible price and pickup.", question: "Accept this offer?" } };
  }
  const candidates = confirmedFacts(context);
  const topic = lower.includes("available") ? /\b(?:available|reserved|sold)\b/i
    : /\bwork|\bplay/i.test(lower) ? /\b(?:work|works|working|plays|broken)\b/i
    : /\bpick|\bwhen/i.test(lower) ? /^Pickup window:/i
    : /\bcrack/i.test(lower) ? /\bcrack/i : null;
  const known = topic ? candidates.filter((fact) => topic.test(fact)) : [];
  if (known.length) return { name: "answer_from_listing", args: { fact: known[0] } };
  if (/\?|\b(?:does it|is it|what|when|where|included|stylus|condition)\b/i.test(text)) {
    const questions = context.listing.questions_for_owner.slice(0, 3);
    return { name: "ask_owner_fact", args: { questions: questions.length ? questions : [text.slice(0, 2000)] } };
  }
  return { name: "request_counterpart_info", args: { questions: ["Please send one offered price, currency and pickup time."] } };
}

const instructions = (context: AgentContext) => `You are Offload, an agent handling marketplace conversations. Use one tool for each action. Never invent facts or owner decisions. For answer_from_listing copy one exact fact from Confirmed facts. Escalate only concrete, policy-compliant offers as one yes/no card. Missing or conflicting buyer details require request_counterpart_info, not owner escalation. If a concrete offer already satisfies all policy gates, use ask_owner_yes_no and do not request unspecified additional details. A closing courtesy like "if that works for you" asks owner approval, not functionality. Genuine unanswered factual questions must be resolved before a deal card. Batch genuinely unknown factual questions. An owner decision is only possible through the human UI, never by you. Reject payment links and respect owner pickup windows, currency and explicit minimum price.\nListing: ${JSON.stringify(context.listing)}\nOwner policy: ${JSON.stringify(context.policy)}\nConfirmed facts: ${JSON.stringify(confirmedFacts(context))}`;

async function realTurn(counterpart: string, context: AgentContext): Promise<ToolTurn> {
  const guarded = deterministicTurn(counterpart, context);
  if (guarded.name === "flag_not_serious" || guarded.name === "request_counterpart_info" || guarded.name === "ask_owner_fact" && buyerFactQuestions(context).length > 0) {
    const executed = localTool(guarded.name, guarded.args, context);
    return { name: guarded.name, args: guarded.args, ...executed };
  }
  async function request(input: unknown, previousResponseId?: string) {
    const response = await getClient().responses.create({ model: SPARK_MODEL, max_output_tokens: 2048, reasoning: { effort: "low" }, input, instructions: instructions(context), tools: AGENT_TOOLS as any, parallel_tool_calls: false, ...(previousResponseId ? { previous_response_id: previousResponseId } : {}) } as any);
    // Every provider response is billed, including intermediate tool-selection turns.
    logCall({ capability: "agent-conversation", model: SPARK_MODEL, mode: "real", raw: response, units: 1, estimatedUsd: sparkCost(response) });
    return response;
  }
  let response = await request(counterpart);
  let last: ToolTurn | null = null;
  for (let turn = 0; turn < 5; turn += 1) {
    const calls = (response.output as any[] ?? []).filter((item: any) => item.type === "function_call");
    if (!calls.length) {
      if (last && last.name !== "propose_pickup_slot") return last;
      break;
    }
    if (calls.length !== 1) return { name: "invalid_tool_sequence", args: null, ...denied("Multiple simultaneous actions were rejected. No owner decision was recorded.") };
    const call = calls[0];
    let args: unknown;
    try { args = parseJson<unknown>(String(call.arguments ?? "{}")); }
    catch { return { name: "invalid_tool_arguments", args: null, ...denied("The action could not be read. No owner decision was recorded.") }; }
    let executed = localTool(String(call.name), args, context);
    if (call.name === "answer_from_listing" && executed.result.allowed === true) {
      const offer = qualifyBuyer(context);
      if (offer.ok && !buyerFactQuestions(context).length) {
        const terminal = qualifiedTurn(offer, context);
        executed = { ...terminal, reply: buyerFactReview(context).answers.length ? terminal.reply : `${executed.reply} ${terminal.reply}` };
      }
    }
    const actionName = executed.card ? "ask_owner_yes_no" : executed.result.kind === "owner-fact" ? "ask_owner_fact" : call.name;
    last = { name: actionName, args, ...executed, raw: response };
    // A qualified card is terminal: never discard it in a later tool turn.
    // Fact questions/replies and denials are likewise complete actions.
    if (executed.card || executed.result.allowed === false || call.name !== "propose_pickup_slot") return last;
    if (turn < 4) response = await request([{ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(executed.result) }], response.id);
  }
  const fallback = deterministicTurn(counterpart, context);
  return { name: fallback.name, args: fallback.args, ...localTool(fallback.name, fallback.args, context) };
}

export async function handleCounterpartMessage(counterpart: string, listing: ListingDraft, policy: OwnerPolicy, persona?: string): Promise<AgentTurnResult> {
  const mode = getMode();
  const context: AgentContext = { listing, policy, persona, sourceText: counterpart };
  const turn = mode === "real" ? await realTurn(counterpart, context) : (() => {
    const chosen = deterministicTurn(counterpart, context);
    const executed = localTool(chosen.name, chosen.args, context);
    logCall({ capability: "agent-conversation", model: SPARK_MODEL, mode, raw: { input: counterpart, tool: chosen.name, args: chosen.args, result: executed.result }, units: 1 });
    return { name: chosen.name, args: chosen.args, ...executed };
  })();
  return { reply: turn.reply, tool: turn.name, toolResult: turn.result, dealCard: turn.card, message: nowMessage("agent", turn.reply, true), mode };
}

/** Pure presentation helper. Persistence owns the atomic card/listing transition. */
export function ownerDecision(_card: DealCard, decision: "yes" | "no"): AgentMessage {
  return nowMessage("agent", decision === "yes" ? "Your acceptance has been recorded. No external message has been sent." : "Your decline has been recorded. No external message has been sent.", true);
}

function seriousBuyerControl(context: AgentContext): string {
  const currency = normalizeCurrency(context.policy.currency) ?? "EUR";
  const minimum = context.policy.minPrice;
  const grounded = context.listing.priceSuggestion;
  const price = minimum !== null && Number.isFinite(minimum) && minimum >= 0 ? Math.ceil(minimum + Math.max(5, minimum * 0.05))
    : grounded?.currency === currency && typeof grounded.quick_sale === "number" && grounded.quick_sale > 0 ? grounded.quick_sale : 25;
  let window = context.policy.pickupWindows[0] ?? "Saturday at 10:00";
  const parsed = pickupEvidence(`Pickup ${window}`).slot;
  if (parsed && !/\d|morning|afternoon|evening/.test(parsed)) window = window.replace(parsed, `${parsed} at 10:00`);
  return `I offer ${currency} ${price} for the item in its stated condition, as-is. I can pick it up ${window}.`;
}

async function personaMessage(persona: SimulationPersona, context: AgentContext): Promise<string[]> {
  if (getMode() === "mock") return persona.messages;
  const control = persona.id === "serious-buyer" ? seriousBuyerControl(context) : null;
  const response = await getClient().responses.create({
    model: SPARK_MODEL, max_output_tokens: 2048, reasoning: { effort: "low" },
    input: `Play marketplace counterpart persona “${persona.label}”. ${persona.description}\nListing: ${JSON.stringify(context.listing)}\nOwner policy: ${JSON.stringify(context.policy)}\nReturn one short message testing the seller agent. Respect the policy's currency and pickup-only constraint when mentioning price or logistics. Do not reveal you are a test.${control ? `\nThis persona is the positive control. Preserve exactly these price/currency/pickup terms: ${control} Make one unconditional offer accepting the stated condition as-is. Do NOT add any question, factual contingency, delivery request, or "if" clause.` : ""}`,
    instructions: "You are a simulated counterpart in a marketplace demo. Be concise and stay in character.",
  } as any);
  const generated = outputText(response).trim();
  const generatedContext = { ...context, sourceText: generated };
  const validControl = !control || generated && !/[?]|\bif\b/i.test(generated) && qualifyBuyer(generatedContext).ok && !buyerFactQuestions(generatedContext).length;
  logCall({ capability: "simulator-counterpart", model: SPARK_MODEL, mode: "real", raw: control ? { response, simulationControl: { usedDeterministicFallback: !validControl, proposedMessage: control } } : response, units: 1, estimatedUsd: sparkCost(response) });
  // This is a labeled simulated counterpart, never a repair of an actual user's
  // invalid offer. The selected message still passes normal qualification later.
  return [control && !validControl ? control : generated || persona.messages[0]];
}

export async function runSimulation(listing: ListingDraft, policy: OwnerPolicy): Promise<SimulationResult> {
  const mode = getMode();
  const allMessages: AgentMessage[] = []; const dealCards: DealCard[] = []; const personas: SimulationResult["personas"] = [];
  let ownerFactQuestions = 0;
  for (const persona of SIMULATION_PERSONAS) {
    const messages: AgentMessage[] = [];
    for (const input of await personaMessage(persona, { listing, policy, persona: persona.id })) {
      const incoming = nowMessage("counterpart", input, true);
      const turn = await handleCounterpartMessage(input, listing, policy, persona.id);
      messages.push(incoming, turn.message); allMessages.push(incoming, turn.message);
      if (turn.dealCard) dealCards.push(turn.dealCard);
      if (turn.tool === "ask_owner_fact") ownerFactQuestions += 1;
    }
    personas.push({ id: persona.id, label: persona.label, messages });
  }
  return { mode, messages: allMessages, dealCards, metrics: { handledByAgent: allMessages.filter((message) => message.sender === "agent").length, humanRead: dealCards.length + ownerFactQuestions }, personas };
}
