/** Conservative evidence extraction shared by Sell and Find. Unknown is not yes. */
export type MoneyEvidence = { status: "known" | "missing" | "ambiguous"; amount: number | null; currency: string | null; reason?: string };
export type WorkingEvidence = { status: "yes" | "no" | "unknown" | "conflict"; evidence: string[] };
export type PickupEvidence = { status: "offered" | "denied" | "unknown" | "conflict"; slot: string | null; evidence: string[] };
const currencyPattern = "(?:EUR|USD|GBP|CZK|PLN|€|\\$|£|Kč)";
const amountPattern = "[-+]?\\d(?:[\\d., \\u00a0\\u202f]*\\d)?";

export function normalizeCurrency(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return ({ "€": "EUR", "$": "USD", "£": "GBP", "KČ": "CZK" } as Record<string, string>)[normalized]
    ?? (/^(EUR|USD|GBP|CZK|PLN)$/.test(normalized) ? normalized : null);
}

export function parseMoneyNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (/[ \u00a0\u202f]/.test(trimmed) && !/^\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?$/.test(trimmed)) return null;
  let value = trimmed.replace(/[ \u00a0\u202f]/g, "");
  if (!/^\d[\d.,]*$/.test(value)) return null;
  if (value.includes(",") && value.includes(".")) {
    const decimal = value.lastIndexOf(",") > value.lastIndexOf(".") ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    if (!new RegExp(`^\\d{1,3}(?:\\${thousands}\\d{3})+\\${decimal}\\d{1,2}$`).test(value)) return null;
    value = value.split(thousands).join("").replace(decimal, ".");
  } else if (/[.,]/.test(value)) {
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(value)) value = value.replace(/[.,]/g, "");
    else if (/^\d+[.,]\d{1,2}$/.test(value)) value = value.replace(",", ".");
    else return null;
  }
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000_000 ? amount : null;
}

export function parseOfferMoney(text: string, defaultCurrency?: string): MoneyEvidence {
  const pattern = new RegExp(`(${currencyPattern})\\s*(${amountPattern})|(${amountPattern})\\s*(${currencyPattern})(?![a-z])`, "gi");
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) {
    const amount = defaultCurrency ? parseMoneyNumber(text) : null;
    const currency = defaultCurrency ? normalizeCurrency(defaultCurrency) : null;
    return amount !== null && currency ? { status: "known", amount, currency }
      : { status: "missing", amount: null, currency: null, reason: "State one offered price and its currency." };
  }
  const values = matches.map((match) => ({ amount: parseMoneyNumber(match[2] ?? match[3]), currency: normalizeCurrency(match[1] ?? match[4]) }));
  // A number with a currency is not necessarily the current offer: it can be
  // a rejected price, old retail price, or comparison. Do not turn it into a
  // decision merely because it is the only currency-bearing number.
  const nonOfferPrice = matches.some((match) => {
    const before = (text.slice(Math.max(0, (match.index ?? 0) - 64), match.index).split(/[.!?;\n]/).pop() ?? "").replace(/[’‘]/g, "'");
    const after = text.slice((match.index ?? 0) + match[0].length).split(/[.!?;\n]/)[0];
    return /\b(?:not|never|won't|can't|cannot|don't|wouldn't|isn't|wasn't|is not|was not)(?:\s+(?:pay|offer|take|accept|charge|for))?\s*$/i.test(before)
      || /\b(?:no more than|less than|more than|over|under|above|below|was|were|used to (?:be|cost)|originally|previously|retail(?:ed)?(?: for| at)?|paid|worth|valued at|cost|costed|starting at|starts? at|from|at least|up to)\s*$/i.test(before)
      || /^\s+(?:is|was|wasn't|isn't)\s+(?:the\s+)?(?:old|previous|original|former|retail)\s+price\b/i.test(after);
  });
  // A separately expressed bare offer/asking amount is ambiguous, not a
  // license to attach the currency of an unrelated historical/negated price.
  // Limit this to price grammar so pickup times, model numbers and ages remain
  // independent of the monetary extraction.
  const barePrice = /\b(?:offer|offering|pay|asking|ask|price(?: is|:)?|want|sell(?:ing)? for)\s*(?:is\s+|of\s+|for\s+|at\s+)?(\d+(?:[.,]\d{1,2})?)(?![\d.,:]|\s*(?:EUR|USD|GBP|CZK|PLN|€|\$|£|Kč))/gi;
  const hasBarePrice = [...text.matchAll(barePrice)].some((m) => {
    const numberIndex = (m.index ?? 0) + m[0].lastIndexOf(m[1]);
    return !matches.some((price) => numberIndex >= (price.index ?? 0) && numberIndex < (price.index ?? 0) + price[0].length);
  });
  // Ranges, fees, recurring charges and multiple amounts are not one total offer.
  const isRange = /\d[\d.,]*\s*[-–—]\s*(?:(?:EUR|USD|GBP|CZK|PLN|€|\$|£)\s*)?\d/i.test(text);
  const extraCharge = /\b(?:plus|additional|deposit|monthly|per month|per week)\b/i.test(text);
  const unique = new Set(values.map((value) => `${value.currency}:${value.amount}`));
  if (isRange || extraCharge || nonOfferPrice || hasBarePrice || unique.size !== 1 || values.some((value) => value.amount === null || value.currency === null)) {
    return { status: "ambiguous", amount: null, currency: null, reason: "Confirm one total offered amount and currency; multiple prices or charges were mentioned." };
  }
  return { status: "known", amount: values[0].amount, currency: values[0].currency };
}

function clauses(text: string): string[] {
  return text.replace(/[’‘]/g, "'").split(/[.!?;\n]+|\b(?:but|however|instead)\b/i).map((part) => part.trim()).filter(Boolean);
}

export function workingEvidence(...texts: string[]): WorkingEvidence {
  const evidence: string[] = [];
  let positive = false; let negative = false; let uncertain = false;
  for (const text of texts) {
    for (const clause of clauses(text)) {
      const concernsFunction = /\b(?:works?|working|functional|functions?|plays?|playback|broken|nefunguje|funguje|funkční|nefunkční)\b/i.test(clause);
      if (!concernsFunction) continue;
      evidence.push(clause);
      if (/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|pickup|meeting|schedule|time)\b[^.;]*\bworks?\b|\bworks?\s+for\s+(?:me|us|you)\b/i.test(clause)) { uncertain = true; continue; }
      if (/\b(?:unknown|untested|not tested|not sure|unsure|do not know|don't know|cannot confirm|can't confirm|whether|if it|might|may|used to|previously|needs? (?:testing|checking))\b/i.test(clause)
        || /^\s*(?:does|is|can|will|would|do)\b.*\?/i.test(text)) { uncertain = true; continue; }
      const isNegative = /\b(?:does\s+not|do\s+not|doesn't|don't|not|never|non[- ]?|no longer|isn't|is not)\s+(?:fully\s+|properly\s+)?(?:work(?:ing|s)?|functional|function(?:ing|s)?|play(?:ing|s)?)\b|\b(?:broken|nefunguje|nefunkční)\b/i.test(clause);
      if (isNegative) negative = true;
      else if (/\b(?:works|working|functional|functions|plays|funguje|funkční)\b/i.test(clause)) positive = true;
    }
  }
  return { status: positive && negative ? "conflict" : negative ? "no" : positive && !uncertain ? "yes" : "unknown", evidence };
}

const weekdayPattern = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)";
// Adjacent relative + named day is one quoted proposal, not two alternatives.
// We preserve both words rather than silently inventing a calendar date.
const dayPattern = String.raw`(?:(?:today|tomorrow)(?:\s+${weekdayPattern})?|(?:this\s+|next\s+)?${weekdayPattern})`;
const slotPattern = new RegExp(String.raw`\b${dayPattern}\b(?:\s+(?:(?:at|around)\s+)?(?:\d{1,2}:\d{2}(?:\s*(?:am|pm))?|\d{1,2}\s*(?:am|pm)|(?:morning|afternoon|evening)|\d{1,2})(?!\d))?`, "gi");
const pickupVerb = String.raw`(?:pick(?:\s+(?:it|this|that|them|the item|this item|that item))?\s*up|pickup|collect(?:ion)?|meet(?:up)?)`;
const pickupWords = new RegExp(String.raw`\b${pickupVerb}\b`, "i");
const pickupDenial = new RegExp(String.raw`\b(?:no|not|cannot|can't|won't|do not|don't|unable to)\b[^.;]*\b${pickupVerb}\b|\b(?:pickup|collection)\s+(?:is\s+)?(?:not available|unavailable|impossible)|\bshipping only\b`, "i");

export function pickupEvidence(text: string): PickupEvidence {
  if (!pickupWords.test(text)) return { status: "unknown", slot: null, evidence: [] };
  const evidence: string[] = [];
  const slots: string[] = [];
  let offered = false; let denied = false;
  // Retain each question's punctuation: a later "Would that work?" must not
  // erase an earlier affirmative commitment or make a different question true.
  const parts = text.replace(/[’‘]/g, "'").split(/(?<=[.!?;])\s+|\n+|\b(?:but|however|instead)\b/i).flatMap((part) => part.split(/,\s*/));
  for (const raw of parts) {
    const clause = raw.trim();
    if (!clause) continue;
    const localPickup = pickupWords.test(clause);
    const polarity = clause.replace(/\bno problem\b/gi, "");
    if (pickupDenial.test(polarity)) { denied = true; evidence.push(clause); continue; }
    const found = [...clause.matchAll(slotPattern)];
    const negatedSlot = /\b(?:not|cannot|can't|won't|unavailable|except|excluding|no)\b/i.test(polarity);
    if (negatedSlot && found.length) { evidence.push(clause); continue; }
    const question = /\?/.test(clause);
    const firstPersonCommitment = /\b(?:i can|i will|i'll|we can|we will|we'll)\b/i.test(clause);
    if (/\b(?:maybe|might|possibly|not sure|unsure)\b/i.test(clause)
      || question && (!firstPersonCommitment || /^(?:can|could|would|will|do|does|is|are)\b/i.test(clause))) continue;
    // A bare day after pickup can complete the proposal. An unrelated sentence
    // like "Saturday I work" cannot establish collection availability.
    const timingContext = found.length > 0 && (
      /\b(?:works|available|i can|i will|i'll|we can|we will|we'll)\b/i.test(clause)
      || found.length === 1 && clause.replace(found[0][0], "").replace(/[.!?;\s]/g, "") === ""
    );
    if (localPickup || timingContext) {
      offered = true; evidence.push(clause);
      for (const match of found) {
        const time = match[0].match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
        if (time && (Number(time[1]) > (time[3] ? 12 : 23) || Number(time[2] ?? 0) > 59 || time[3] && Number(time[1]) < 1)) return { status: "conflict", slot: null, evidence };
        slots.push(match[0].trim());
      }
    }
  }
  const uniqueSlots = [...new Set(slots.map((slot) => slot.toLowerCase()))];
  if (denied && offered) return { status: "conflict", slot: null, evidence };
  if (denied) return { status: "denied", slot: null, evidence };
  if (uniqueSlots.length > 1) return { status: "conflict", slot: null, evidence };
  return { status: offered ? "offered" : "unknown", slot: uniqueSlots.length === 1 ? slots[0] : null, evidence };
}
