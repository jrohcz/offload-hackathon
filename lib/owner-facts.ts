import { workingEvidence } from "@/lib/evidence";
import type { ListingDraft, OwnerPolicy } from "@/lib/types";

const ownerPrefix = /^Owner (?:voice|statement): /;
const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Labels provenance without promoting a person's testimony to photo evidence. */
function ownerStatements(policy: OwnerPolicy): { label: string; statements: string[] } {
  const transcript = policy.sourceTranscript?.trim();
  if (!transcript) return { label: "Owner statement", statements: [...new Set(policy.facts.map((fact) => fact.trim()).filter(Boolean))] };
  const lower = transcript.toLowerCase();
  const anchored = policy.facts.flatMap((fact) => {
    const candidate = fact.trim();
    if (!candidate) return [];
    const index = lower.indexOf(candidate.toLowerCase());
    // Return the source's actual characters, not the model's paraphrase/case.
    return index < 0 ? [] : [transcript.slice(index, index + candidate.length)];
  });
  return { label: "Owner voice", statements: [...new Set(anchored.length ? anchored : [transcript])] };
}

function functionalityClauses(statements: string[]) {
  return statements.flatMap((statement) => statement.split(/[.;\n]+|\bbut\b/i)).map((clause) => clause.trim()).filter((clause) => {
    // Working accessories or a broken cover say nothing definitive about the
    // whole item's operation. Scheduling idioms are rejected by workingEvidence.
    if (/\b(?:i think|i believe|probably|apparently|seems|looks like)\b/i.test(clause)) return false;
    if (/\b(?:bluetooth|battery|stylus|speaker|lid|cover|warranty|charger|charging|screen|button|motor)\b/i.test(clause)) return false;
    return /\b(?:works?|working|functional|functions?|plays?)\b/i.test(clause);
  });
}

/** Only remove a general functionality question, never a component/mixed one. */
function generalFunctionality(value: string): boolean {
  const text = normalized(value).replace(/[?.!]+$/, "");
  if (/\b(?:and|also|included|brand|model|bluetooth|battery|stylus|speed|motor|speaker|lid|cover|warranty|duration|charge|charger|price)\b/.test(text)) return false;
  return /^(?:(?:whether|if|unknown whether|unknown if)\s+)?(?:it|the item|playback|the turntable|the bike|the bicycle|the laptop)\s+(?:works?|functions?|plays?|is working|is functional)/.test(text)
    || /^(?:does|can|will|is)\s+(?:it|the item|the turntable|the bike|the bicycle|the laptop)\s+(?:work|function|play|working|functional)/.test(text)
    || /^(?:unknown\s+)?(?:functionality|working condition|operating condition|playback functionality|playback condition)(?:\s+(?:unknown|untested|unconfirmed))?$/.test(text);
}

/**
 * Pure reconciliation for the Sell response after voice extraction.
 * Keeps photo claims unchanged, labels verbatim owner testimony, and resolves
 * only the narrow general-functionality unknowns actually answered by it.
 */
export function reconcileOwnerFacts(listing: ListingDraft, policy: OwnerPolicy): ListingDraft {
  const { label, statements } = ownerStatements(policy);
  const additions = statements.map((statement) => `${label}: ${statement}`);
  const existing = new Set(listing.facts_confirmed.map(normalized));
  const facts = [...listing.facts_confirmed, ...additions.filter((fact) => !existing.has(normalized(fact)))];
  const owner = workingEvidence(...functionalityClauses(statements));
  const photo = workingEvidence(...functionalityClauses(listing.facts_confirmed.filter((fact) => !ownerPrefix.test(fact))));
  const conflict = owner.status === "conflict" || photo.status === "conflict"
    || owner.status === "yes" && photo.status === "no" || owner.status === "no" && photo.status === "yes";
  const resolved = !conflict && (owner.status === "yes" || owner.status === "no");
  const questions = resolved ? listing.questions_for_owner.filter((question) => !generalFunctionality(question)) : [...listing.questions_for_owner];
  if (conflict && !questions.some((question) => /conflict.*functionality/i.test(question))) {
    questions.push("The recorded statements conflict about functionality. Does the item currently work correctly?");
  }
  return {
    ...listing,
    facts_confirmed: facts,
    facts_unknown: resolved ? listing.facts_unknown.filter((fact) => !generalFunctionality(fact)) : [...listing.facts_unknown],
    questions_for_owner: questions,
  };
}
