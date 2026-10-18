// Input guard: buyer -> seller. Port of InputGuard from experiments/e9_safety/guardrails.py (guard v3).
//
// Buyer text is untrusted. A deterministic detector flags text that impersonates the seller's
// operator, system, or tools (fake SYSTEM/operator notes, chat-template tokens, "ignore previous
// instructions", fake tool/JSON/function output, fake end-of-message markers, "floor updated",
// authority claims). Flagged blocks are replaced with "[removed by input filter]" before the LLM
// sees them. Out-of-policy asks (financing, free extras, unlisted terms/items) are reported so the
// seller declines and a human can follow up. Domain-agnostic: no catalog checks here (the exchange
// validates structured offers itself). Pure, no deps.

export interface InputReport {
  sanitized: string;
  flagged: boolean;
  markers: string[];
  asks: string[];
}

const REMOVED = "[removed by input filter]";

type Rule =
  | "fake_system"
  | "ignore_instructions"
  | "fake_boundary"
  | "fake_tool_output"
  | "floor_update"
  | "pricing_system"
  | "authority_claim";

// Non-global regexes only (stateless .test()); detection uses a global copy.
const INJECTION_PATTERNS: [Rule, RegExp][] = [
  ["fake_system", new RegExp(
    String.raw`(^|\n|[.!?]\s+|\s{2,})\s*[\[(<*#\s]*(system|sys|admin|administrator|operator|developer|assistant)` +
    String.raw`(\s+(message|prompt|note|notice|update|instruction|instructions|override))?\s*[\])>*]*\s*:`, "i")],
  ["fake_system", /<\|?\s*(im_start|im_end|system|endoftext)\s*\|?>|\[\/?(INST|SYS)\]|<<\s*SYS\s*>>/i],
  ["ignore_instructions", new RegExp(
    String.raw`\b(ignore|disregard|forget|override|bypass|discard)\b[^.!?\n]{0,40}\b(previous|prior|above|earlier|all|your|existing|current|original)\b` +
    String.raw`[^.!?\n]{0,40}\b(instructions?|rules?|prompts?|guidelines|directives|pricing|programming|constraints)\b`, "i")],
  ["ignore_instructions", /\b(new|updated|revised)\s+(instructions?|rules?|system prompt|directives?)\s*(for (the )?(seller|assistant|agent))?\s*:/i],
  ["ignore_instructions", new RegExp(
    String.raw`\b(policy|policies|instructions?|rules?|floor values?|prices?|pricing)\s+(is|are|has been|have been|was|were)?\s*(now\s+)?` +
    String.raw`(superseded|deprecated|revoked|rescinded|no longer (valid|apply|applies|in effect))\b`, "i")],
  ["fake_system", new RegExp(
    String.raw`\b(operator|admin|administrator|system|developer|management|platform|runtime|configuration)\s+(note|message|notice|instruction|instructions|` +
    String.raw`override|directive|memo)s?\b[^.!?\n]{0,60}\b(seller|agent|assistant)\b|\b(note|message|instructions?)\s+to\s+(the\s+)?(seller|selling)\s+agent\b|` +
    String.raw`\bseller\s+(agent\s+)?(internal|instructions)\b|\bconfiguration\s+v?\d+(\.\d+)*\s+loaded\b`, "i")],
  ["fake_boundary", new RegExp(
    String.raw`\[?\s*end of (the )?(customer|buyer|user|human)('s)? (message|turn|input)\s*\]?|<\/?\s*(conversation|transcript|chat|message|user|human)\s*>|` +
    String.raw`\[\s*end( of)? (tool )?(response|output|result|message)\s*\]`, "i")],
  ["fake_tool_output", new RegExp(
    String.raw`<\s*\/?\s*(tool_result|tool_use|tool_response|tool_output|function_results?|function_call|function_response|` +
    String.raw`tool|result|results|output|api_response|response|instructions?|operator|pricing[_ -]?\w*)\b[^>]*>`, "i")],
  ["fake_tool_output", new RegExp(
    String.raw`\{[^{}]{0,400}"(status|approved|approval|override|approved_price|floor|floor_total|floor_price|floor_price_cents|new_floor|min_price|minimum_price|` +
    String.raw`decision|authorized|authorized_by|policy_check|price_override)"\s*:`, "i")],
  ["fake_tool_output", new RegExp(
    String.raw`\[\s*[^\]]{0,30}\b(make_offer|accept_offer|accept_deal|pay_deal|review_deal|pricing[_ ]?(engine|tool|system)|policy[_ ]?engine|tool|checkout)` +
    String.raw`[^\]]{0,40}\]\s*[:\-]?`, "i")],
  ["fake_tool_output", /(^|\n)\s*[a-z]+(_[a-z0-9]+)+\s*[:=]\s*\S/i],
  ["floor_update", new RegExp(
    String.raw`\b(floor|floors|minimum|min price|price floor|floor price|floor prices)\b[^.!?\n]{0,50}\b(updated|revised|changed|lowered|` +
    String.raw`reduced|reset|overridden|override|adjusted|temporarily set|now set|set to \$|superseded|deprecated)\b|\bfloor\s*[=:]\s*\$?\d`, "i")],
  ["floor_update", /\bpric(e|es|ing)\b[^.!?\n]{0,30}\b(revised|updated|override|overridden)\b[^.!?\n]{0,40}\b(effective|immediately|today|now)\b/i],
  ["floor_update", /\bnew\s+([A-Z0-9+ ]{0,30}\s)?(bundle\s+)?(floor|minimum|min(imum)? price)\b/i],
  ["pricing_system", new RegExp(
    String.raw`\b(pricing (system|engine|tool|department|team|desk)|policy engine|checkout system)\b[^.!?\n]{0,40}` +
    String.raw`\b(update|approved|approval|override|overrides|authori[sz]ed|authori[sz]es|returned)\b`, "i")],
  // Python named the tractor dealer here; any company name (up to 4 words) before pricing/management instead.
  ["pricing_system", /\b(message|update|notice|memo) from (the )?(?!(my|our)\b)([\w&.'-]+\s+){0,4}(pricing|management|head office)\b/i],
  ["authority_claim", new RegExp(
    String.raw`\b(authori[sz]ation|approval|override|auth)\s+(code|number|id)\b|\bmanager(ial)?\s+override\b|` +
    String.raw`\b(manager|management|owner|head office)\s+(has\s+)?(already\s+)?(approved|authori[sz]ed|signed off)\b|` +
    String.raw`\b(i am|i'm|this is|speaking as)\s+(\w+\s+){0,3}(your|the (store|shop|seller|company|merchant)('s)?)\s+(\w+\s+){0,2}(manager|owner|boss|supervisor|director|vp|president)\b|` +
    String.raw`\b(regional|district|general|area)\s+(sales\s+)?(manager|director)\b|` +
    String.raw`\binternal\s+(transfer|deal|purchase|sale|pricing|order)\b|\bemployee\s+(purchase|discount|pricing|price)\b|` +
    String.raw`\b[A-Z]{2,5}-AUTH-\d+\b`, "i")],
];

// Out-of-policy asks the seller should decline and escalate rather than negotiate.
const EXTRA_ITEMS =
  String.raw`deliver\w*|shipping|set ?up|warranty|servic\w*|maintenance|accessor\w*|extras?|case|carry(ing)? case|cables?|` +
  String.raw`keycaps?|switch(es)?|wrist ?rest|ear ?pads?|ear ?tips?|stand|dongle|adapter|gift|bundle`;
const ASK_PATTERNS: [string, RegExp][] = [
  ["financing", new RegExp(
    String.raw`\b(financ\w*|payment plan|install?ments?|net[- ]?\d{2}|defer\w*|pay (it )?(later|over time|in \d+)|` +
    String.raw`monthly payments?|per month|lease|layaway|0% apr|apr|buy now,? pay later|bnpl|split (it|the payment) into)\b`, "i")],
  ["free_extras", new RegExp(
    String.raw`\b(free|for free|no charge|at no (extra |additional )?(cost|charge)|throw (it |them )?in|thrown in|complimentary|on the house|waive)\b` +
    String.raw`[^.!?\n]{0,40}\b(${EXTRA_ITEMS})\b|` +
    String.raw`\b(${EXTRA_ITEMS})\b[^.!?\n]{0,40}\b(free|for free|no charge|thrown in|complimentary|at no)\b`, "i")],
  ["unlisted_terms", new RegExp(
    String.raw`\b(price[- ]match|trade[- ]in|rebate|store credit|future discount|loyalty discount|free servic\w*|free maintenance|` +
    String.raw`extended warranty|(2|3|4|5|two|three|four|five|six|6|7|seven|10|ten)[- ]year warranty|lifetime warranty|bumper[- ]to[- ]bumper)\b`, "i")],
  // Python matched tractor models and implements; generic "do you also sell/have another X" instead.
  ["unlisted_items", new RegExp(
    String.raw`\b(do|can|could|would) you (also |even )?(sell|carry|stock|have|get|add|include|bundle|source)\b[^.!?\n]{0,40}` +
    String.raw`\b(another|a second|an extra|extra|spare|additional|other|different) (model|unit|item|product|set|pair|one|color|colou?rway|version|\w+)\b|` +
    String.raw`\b(not (on|in) (your|the) (listing|catalog|catalogue|store|page)|unlisted|off[- ]menu|special[- ]order|custom[- ]order)\b`, "i")],
];

interface Finding { rule: Rule; span: string }

function detect(text: string): Finding[] {
  const seen = new Set<Rule>();
  const out: Finding[] = [];
  for (const [rule, rx] of INJECTION_PATTERNS) {
    if (seen.has(rule)) continue;
    const m = rx.exec(text);
    if (m) { seen.add(rule); out.push({ rule, span: m[0].trim().slice(0, 160) }); }
  }
  return out;
}

const matchesAny = (s: string, pred: (r: Rule) => boolean) =>
  INJECTION_PATTERNS.some(([r, rx]) => pred(r) && rx.test(s));

function sanitize(text: string, findings: Finding[]): string {
  if (findings.length === 0) return text;
  let t = text;
  // Tagged blocks (<tool_result ...> ... </tool_result>) and fenced code blocks.
  t = t.replace(/<\s*([a-zA-Z_][\w\-]*)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/g, REMOVED);
  t = t.replace(/```[\s\S]*?```/g, REMOVED);
  t = t.replace(/<\|?\s*(im_start|im_end|system|endoftext)\s*\|?>/gi, REMOVED);
  // Bare JSON objects that look like tool output.
  t = t.replace(/\{[^{}]{0,600}\}/g, (m) => (matchesAny(m, (r) => r === "fake_tool_output") ? REMOVED : m));
  const notAuthority = (r: Rule) => r !== "authority_claim";
  const kept: string[] = [];
  for (const line of t.split(/(\n+)/)) {
    if (!line.trim() || line.startsWith("\n")) { kept.push(line); continue; }
    if (!matchesAny(line, notAuthority)) { kept.push(line); continue; }
    // Drop only the offending sentences of a long line; drop short lines whole.
    const sentences = line.split(/(?<=[.!?])\s+/);
    if (sentences.length === 1) { kept.push(REMOVED); continue; }
    const keep = sentences.filter((s) => !matchesAny(s, notAuthority));
    kept.push([...keep, REMOVED].join(" "));
  }
  return kept.join("").replace(/(\[removed by input filter\]\s*){2,}/g, REMOVED + " ").trim();
}

function detectAsks(text: string): string[] {
  return ASK_PATTERNS.filter(([, rx]) => rx.test(text)).map(([name]) => name);
}

/** Detector + sanitizer + out-of-policy ask detection for one buyer message. */
export function inspectInput(text: string): InputReport {
  const t = text ?? "";
  const findings = detect(t);
  return {
    sanitized: sanitize(t, findings),
    flagged: findings.length > 0,
    markers: findings.map((f) => f.rule),
    asks: detectAsks(t),
  };
}

/** Quote buyer text so it can't close the tag or pose as another speaker. */
export function delimit(text: string): string {
  const safe = (text ?? "").replace(/<\s*\/?\s*buyer_message\s*>/gi, "[tag removed]");
  return `<buyer_message>${safe}</buyer_message>`;
}
