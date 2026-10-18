/**
 * E1 · Inbound reply parser (the messaging door: email / SMS / A2A replies to a follow-up).
 * Deterministic. Every reply becomes exactly one structured intent or a clarifying question. Never a guess:
 * an accept needs the exact offer_id, a counter needs exactly one price, anything mixed or unclear asks.
 */
import { inspectInput } from "./input-guard";

export type InboundIntent =
  | { kind: "accept"; offer_id: string }
  | { kind: "counter"; price_cents: number; levers: string[] }
  | { kind: "walk" }
  | { kind: "unsubscribe" }
  | { kind: "clarify"; question: string; reason: string };

export interface InboundContext {
  standing_offer_id?: string; // the live offer in the follow-up, if any
  allowed_levers: string[];
}

const OFFER_ID = /\boff_[0-9a-f-]{8,}\b/gi;
const MONEY = /(?:\$|usd\s?)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\s?%)/gi;
/**
 * A decline in words. A decline that names a price ("I'm not accepting $110", "I can't accept $115, too much") is
 * mixed (walk + price), so it gets a question; read as a counter it could lock a deal on a "no".
 */
const DECLINE = /\b(no thanks|not interested|pass|i'?ll pass|i'?m passing|passing on|declin(?:e|ed|ing)|no deal|not accept(?:ing)?|can'?t accept|cannot accept|won'?t (?:buy|accept|pay|proceed|take)|not (?:going to|gonna) (?:buy|accept|pay|take)|not buying|don'?t want (?:it|this|to buy))\b/i;
const NEGATED_ACCEPT = /\b(not|don'?t|won'?t|can'?t|cannot|never)\s+(?:be\s+)?(?:accept|take)/i;
const LEVER_WORDS: Record<string, RegExp> = {
  free_shipping: /\bfree (?:shipping|delivery)\b/i,
  extended_warranty: /\b(?:extended|longer|2[- ]year) warranty\b/i,
  bundle_discount: /\bbundle\b/i,
  volume_discount: /\bvolume discount\b/i,
};

/** The new part of an email reply: quoted history ("> ..." lines, "On ... wrote:", "Original Message") dropped. */
export function stripQuoted(t: string): string {
  return t.split(/\n(?:On .{0,200}wrote:|-{2,}\s*Original Message)/i)[0].split("\n").filter((l) => !l.trim().startsWith(">")).join("\n").trim();
}

export function parseInbound(raw: string, ctx: InboundContext): InboundIntent {
  const { sanitized, flagged } = inspectInput(raw ?? "");
  // drop quoted history from email replies ("> ..." lines, "On ... wrote:")
  const text = stripQuoted(sanitized);
  const take = `ACCEPT ${ctx.standing_offer_id ?? "<offer_id>"}`; // name the live offer, so the agent can act on the reply

  if (!text) return clarify(flagged ? "message contained only removed instructions" : "empty reply",
    `I didn't get a reply I can act on. Reply ${take} to take the offer, COUNTER $<price> to make an offer, or STOP to unsubscribe.`);

  if (/^\s*(stop|unsubscribe|opt[- ]?out|remove me)\b/i.test(text)) return { kind: "unsubscribe" };

  const ids = [...new Set([...text.matchAll(OFFER_ID)].map((m) => m[0].toLowerCase()))];
  const prices = [...new Set([...text.matchAll(MONEY)].map((m) => Number(m[1].replace(/,/g, "")) * 100 + Number((m[2] ?? "0").padEnd(2, "0"))))];
  const wantsWalk = DECLINE.test(text);
  const wantsAccept = /\b(accept|deal|i'?ll take it|sounds good|yes)\b/i.test(text) && !NEGATED_ACCEPT.test(text);
  const wantsCounter = prices.length > 0 || /\b(counter|offer|can you do|how about)\b/i.test(text);
  const levers = Object.entries(LEVER_WORDS).filter(([, re]) => re.test(text)).map(([l]) => l);

  const intents = [wantsAccept && "accept", wantsWalk && "walk", prices.length > 0 && "counter"].filter(Boolean);
  if (intents.length > 1)
    return clarify("mixed intents: " + intents.join(" + "),
      `Your reply reads as more than one thing. Reply ${take} to take the offer, or COUNTER $<price> with one price.`);

  if (wantsAccept) {
    if (ids.length === 1) {
      if (ctx.standing_offer_id && ids[0] !== ctx.standing_offer_id.toLowerCase())
        return clarify("offer_id isn't the live offer", `That offer isn't the live one. To accept the current offer, reply ACCEPT ${ctx.standing_offer_id}.`);
      return { kind: "accept", offer_id: ids[0] };
    }
    return clarify(ids.length ? "several offer ids" : "accept without offer_id",
      ctx.standing_offer_id ? `To confirm, reply ACCEPT ${ctx.standing_offer_id}.` : "There's no live offer to accept. Reply COUNTER $<price> to make an offer.");
  }
  if (wantsWalk) return { kind: "walk" };
  if (prices.length === 1) {
    const bad = levers.filter((l) => !ctx.allowed_levers.includes(l));
    if (bad.length) return clarify("lever not offered", `${bad.join(", ")} isn't available on this item. Reply COUNTER $<price> without it, or ask about what's included.`);
    return { kind: "counter", price_cents: prices[0], levers };
  }
  if (prices.length > 1) return clarify("several prices", "I saw more than one price. Reply COUNTER $<price> with the one price you're offering.");
  if (wantsCounter) return clarify("counter without a price", "What price would you like to offer? Reply COUNTER $<price>.");
  return clarify("no recognizable intent", `Reply ${take} to take the offer, COUNTER $<price> to make an offer, or STOP to unsubscribe.`);
}

function clarify(reason: string, question: string): InboundIntent {
  return { kind: "clarify", question, reason };
}
