/**
 * Output post-guard: a deterministic, blocking check of every seller message against its structured move.
 *
 * Port of E9's `OutputGuard` (experiments/e9_safety/guardrails.py, guard v3) to integer cents and a single
 * product per conversation, with E11's two false-positive fixes (README "What to adopt" item 7):
 *   - "standard 1-year parts-and-labor warranty" (any words between "1-year" and "warranty") is the standard
 *     warranty, not a promised extended warranty;
 *   - negated finality and floor sentences ("wasn't my final number", "isn't a floor", "I won't call this
 *     final") count as negations, not claims.
 *
 * Rules: dollar figures must match the offer or an allowed price and never fall below `low_cents`; no private
 * figure; no floor/cost/margin/instruction disclosure; no financing or deferred payment; levers promised in words
 * must be in the structured offer; "final/best/firm" wording only on a final move; no competitor or scarcity
 * claims. On a block the caller regenerates with `feedbackFor(findings)`, then falls back to `fallbackMessage`.
 */

export interface OutputContext {
  offer_price_cents: number | null; // price in the structured move (offer or accept)
  allowed_prices_cents: number[]; // list price + earlier prices on the table (ok to mention)
  low_cents: number; // lowest price seller may state (soft floor)
  private_cents: number[]; // floor, unit cost: must never appear in text
  final: boolean; // is this move truly final
  levers_in_offer: string[]; // e.g. ["free_shipping"]; levers named in text must be here
}

export interface Finding {
  rule: string;
  detail: string;
}

// ============================================================== money

const MONEY_SRC =
  String.raw`(?<![\w.$])(?:US)?\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s*([kK]\b|thousand\b))?` +
  String.raw`|(?<![\w.$,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:dollars|bucks|usd)\b` +
  String.raw`|\bUSD\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?`;
const MONEY = new RegExp(MONEY_SRC, "gi");

/** Dollar amounts in text as [cents, matched text]. Handles $129, $129.00, $129.5, $1,299, $1.2k, 129 dollars, USD 129. */
export function moneyFigures(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  for (const m of (text || "").matchAll(MONEY)) {
    let whole: string, dec: string | undefined, k = false;
    if (m[1] !== undefined) [whole, dec, k] = [m[1], m[2], !!m[3]];
    else if (m[4] !== undefined) [whole, dec] = [m[4], m[5]];
    else [whole, dec] = [m[6], m[7]];
    let v = parseFloat(whole.replace(/,/g, "") + (dec ? "." + dec : ""));
    if (k) v *= 1000;
    out.push([Math.round(v * 100), m[0]]);
  }
  return out;
}

const stripMoney = (s: string) => s.replace(MONEY, " ");

function sentences(text: string): string[] {
  return (text || "").split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
}

function clauses(sentence: string): string[] {
  return sentence
    .split(/,?\s+\bbut\b\s+|;\s*|\s+\bhowever\b,?\s+|,\s+\bthough\b|\s+\bwhereas\b\s+|\s+\bwhile\b\s+|:\s+|\s+[—–]\s+/i)
    .filter((p) => p && p.trim());
}

/** Every clause of every sentence, in order. */
function allClauses(text: string): Array<{ s: string; c: string }> {
  const out: Array<{ s: string; c: string }> = [];
  for (const s of sentences(text)) for (const c of clauses(s)) out.push({ s, c });
  return out;
}

const without = (s: string, part: string | undefined | null) => (part ? s.split(part).join(" ") : s);
const span = (c: string) => c.trim().slice(0, 200);

// ============================================================== shared vocab

const NEG = /\b(not|no|never|none|nothing|cannot|unable|decline|declining|without|outside|instead|rather than|unfortunately|neither|nor|aren't|isn't|wasn't|won't|can't|don't|doesn't|didn't|wouldn't|couldn't|shouldn't)\b|n't\b|\bcan not\b/i;
const REFUSE = /\bthan (what )?(i|we) (can|could)\b|\b(more than|less than|below|under|short of|outside) (what )?(i|we) can\b|\btoo (low|far|much|big)\b|\b(below|under|short of|far from) (what|where|anything|any)\b|\bdoesn't work\b|\bwon't work\b|\bout of reach\b|\bfar from\b|\bfar apart\b|\bstill apart\b|\b(long|a long) way (off|from)\b|\bnot (workable|possible|feasible)\b|\bstill (short|a gap|above|below)\b/i;
const QUOTE_BEFORE = /(\byour|\byour (offer|bid|number|budget|price|counter|ceiling|limit)( of)?|\byou('re| are)? (at|offered|offering|proposed|bid|mentioned|said|asked for)|\byou've (offered|proposed|bid|said|mentioned)|\b(move|moved|moving|step|stepped|jump|stretch|stretched|stretching|coming up|came up|come up|going|went|go) (up )?to|\bup from|\bfrom)\s*$/i;
const QUOTE_AFTER = /^\s*(is|was|would be)?\s*(your|the buyer's|their)\b|^\s*(you|they) (offered|proposed|mentioned|quoted|bid)\b/i;
const ABOUT_OTHERS = /\b(competitors?|other (sellers?|stores?|shops?|retailers?|listings?)|another (seller|store|shop|listing)|the other (seller|quote|offer|listing)|their (quote|offer|price)|they('re| are) offering|that (deal|quote)|your (number|offer|bid|budget|ceiling|limit|price|client's (budget|ceiling|limit)))\b/i;
const AGREE_STRONG = /\b(it's a deal|we have a deal|deal at|deal for|you've got (it|a deal)|you got it|accept(ed|ing)?|agreed|done deal|confirmed|honou?r(ed)?|i'll honou?r|let's (do|lock|close) (it|that|this)|works for (me|us)|i'll take|we'll take|sounds good|approved?)\b/i;
const AGREE = /\b(works|can do|yes|okay|ok|i'll do|we'll do|meet you at|settle (on|at)|let's do|i can accept|we can accept)\b/i;

// ============================================================== disclosure

// Floor / cost / instruction disclosure. Negation doesn't excuse these, except "I can't share ..." and (E11)
// negating the floor noun itself ("isn't a floor", "there's no floor").
const FLOOR_NOUN: RegExp[] = [
  /\b(my|our|the|a|price|pricing|hard|absolute)\s+floor\b(?![- ]?(plan|mat))|\bfloor\s+(price|total|is|of|at|for|on)\b|\bbelow (my|our|the) floor\b/i,
  /\bbottom[- ]?line\b|\brock[- ]bottom\b|\bwalk[- ]away (price|number|point)\b|\breserve price\b/i,
];
const FLOOR_LANG: Array<[string, RegExp]> = [
  ...FLOOR_NOUN.map((rx): [string, RegExp] => ["floor_disclosure", rx]),
  ["floor_disclosure", /\b(lowest|the least|minimum)\b[^.!?\n]{0,40}\b(i|we)\b[^.!?\n]{0,15}\b(can|could|am able|are able|'m able|'re able|will|may|'d)\b/i],
  ["floor_disclosure", /\bas low as (i|we) (can|could) (go|do|get)\b|\bas (low|far) as (i'm|i am|we're|we are) (able|allowed|authori[sz]ed)\b|\bas low as (this|the|it|that)( \w+){0,2} (can|could|will) (go|get)\b/i],
  ["floor_disclosure", /\b(can't|cannot|can not|unable to|not able to|not allowed to|not authori[sz]ed to)\s+(go|get|come|drop|sell|price it|do)\s+(it\s+)?(any\s+)?(lower|below|under|less|further down)\b/i],
  ["floor_disclosure", /\b(that's|that is|this is|it's|it is)\s+(the|my|our)\s+(lowest|limit|absolute limit|minimum)\b|\bno lower than\b|\bmy limit\b|\bour limit\b/i],
  ["floor_disclosure", /\bthe least (i|we) (can|could) (take|accept|do)\b|\bminimum (i|we) (can|could|will) (accept|take|do)\b|\bminimum (price|total|acceptable)\b/i],
  ["floor_disclosure", /\b(isn't|is not|won't|will not|not|never) (going to )?(land|go|get|come in|drop|fall|sell|end up) (under|below|lower than|for less than)\b|\bbelow what (i|we) (can|could) (do|accept|go|offer|take)\b[^.!?]{0,30}\b(alone|by itself|itself)\b/i],
  ["cost_disclosure", /\b(our|my|wholesale|invoice|acquisition|unit|landed|supplier)\s+costs?\b|\bwhat (it|this|they|the (keyboard|board|unit|item)) costs? (us|me)\b|\bcosts? us\b|\bcosts? (for )?(me|us)\b(?! nothing)|\bcosts? (me|us|for me|for us) to\b|\bwhat [^.!?]{0,40}\bcosts? (me|us|for me|for us)\b|\bwhat (it|this|that|the \w+)( \w+){0,3} costs? to (ship|deliver|supply|provide|sell|build|make|stock)\b/i],
  ["cost_disclosure", /\bbelow cost\b|\bunder cost\b|\bat a loss\b|\b(lose|losing|lost) money\b|\bbreak[- ]?even\b|\b(less|lower) than (what )?(we|i) (paid|pay)\b|\bwhat (we|i) (paid|pay) for\b/i],
  ["cost_disclosure", /\b(my|our|the|thin|slim|tight|small|razor[- ]thin)\s+margins?\b|\bmargins? (is|are|on)\b|\bmarkup\b/i],
  ["instruction_disclosure", /\b(my|the)\s+(system prompt|instructions|programming|prompt)\b|\bi('ve| have)?\s*been\s+(instructed|told|programmed|configured)\b|\bmy (rules|guidelines) (say|state|require|tell)\b/i],
];
const SHARE_NEG = /\b(share|disclose|reveal|discuss|give out|give you|tell you|say|confirm|get into|go into|break down|talk about|describ\w*|nam(e|es|ing)|answer)\b/i;
const FAKE_FLOOR_TALK = /\bfloor[- ]?(update|change|notice|override|revision)s?\b|\b(naming|name|share|reveal) (a|my|our|the) floor\b|\b(your|the buyer's|that|this) ['"]?floor['"]?\b/i;
const NEGATED_FLOOR = /\b(not|no|never|isn't|wasn't|aren't|is not|was not|there's no|there is no)\s+(\w+\s+){0,2}(floor|bottom[- ]?line|reserve price|walk[- ]away (price|number|point))\b/i;
const AT_COST = /\bat cost\b/i;

// ============================================================== finality

const FINALITY = new RegExp(
  [
    String.raw`(?<!your )(?<!their )(?<!the buyer's )\bfinal\s+(offer|price|number|deal|figure|quote|move|answer|word)\b`,
    String.raw`\bbest[- ]and[- ]final\b|\bbest and last\b|\blast and final\b|\babsolute best\b`,
    String.raw`\b(this|that|it|here)('s| is| will be| would be| has to be)\s+(my|our|the)\s+last\s+(offer|price|number|move)\b`,
    String.raw`\btake it or leave it\b`,
    String.raw`\b(won't|will not|not going to|can't|cannot|unable to)\s+(go|come|move|drop|budge|bend)\s+(any\s+)?(lower|further|down)\b(?!\s+to\b)`,
    String.raw`\b(best|lowest|sharpest)\s+(price|offer|deal|number)\s+(i|we)\s+(can|could)\s+(do|offer|give|make)\b|\b(the )?best (i|we) can do\b`,
    String.raw`\bas far as (i|we) can go\b|\bthat's as far as\b|\bno (more|further) (room|movement|flexibility)\b|\bthis is it\b`,
    String.raw`\b(our|my) (very )?(best|lowest|bottom|sharpest|best possible) (price|offer|number|deal|total)\b(?! so far| yet| for now)`,
    String.raw`\b(this|that|it)('s| is)\s+(the|my|our)\s+(offer|price|number|deal)\s+(i|we)\s+(can|could)\s+(make|do|offer|give)\b|\bthe most (i|we) can do\b`,
    String.raw`\b(offer|price|number|quote)\s+is\s+firm\b|\bfirm (offer|price|number)\b`,
    String.raw`\b(the )?best (i|we) can (offer|give|put|manage|make|go|bring)\b|\bthe best (price|offer|number|deal) (i|we) can\b`,
    String.raw`\b(the|my|our) (figure|number|price|offer) (i|we) can (put|offer|give|do|bring)\b[^.!?]{0,40}\b(today|right now|now|at this point)\b`,
  ].join("|"),
  "i",
);
// v3 + E11: explicit refusals to call a price final, and negated finality ("wasn't my final number").
const NOT_FINAL = new RegExp(
  [
    String.raw`\b(not|no|never|isn't|wasn't|aren't|is not|was not|won't be|will not be|\w+n't)\b[^.,!?]{0,20}\b(final|last|firm)\b`,
    String.raw`\b(won't|will not|not going to|don't want to|do not want to|can't|cannot|refuse to|wouldn't|would not|not)\s+(call|label|put|say|describe|present|claim|pretend|promise|dress)\b`,
    String.raw`\b(your|the buyer's|their|for the|for your)\s+(firm|final|best)\s+(number|offer|price)\b`,
  ].join("|"),
  "i",
);

// ============================================================== financing

const DEFERRAL = /\b(payment plans?|install?ments?|net[- ]?\d{2}|defer(red|ral)?|layaway|lease|leasing|on credit|in-house (credit|financing)|monthly payments?|per month|\/\s?mo\b|apr|interest[- ]free|0% (interest|apr|financing)|pay (it |the rest |the balance )?(later|over time|in (two|three|four|\d+) (parts|payments|installments))|(the rest|the balance|remaining balance|remainder) (later|after delivery|on delivery|upon delivery|in \d+|over)|pay(ment)? (on|upon|after) delivery|cash on delivery|deposit (now|today) and|klarna|afterpay|buy now,? pay later|bnpl|split (it|the payment|the cost|the price) (into|over))\b/i;
const FIN_WORD = /\bfinanc\w*/i;
const SELLER_PROVIDES = /\b(we|i)('ll| will| can| could| would| are able to| am able to)?\s+(offer|do|provide|arrange|set (you |them )?up|extend|give|work out|structure|carry)\b/i;
const FIN_AVAILABLE = /\bfinanc\w*\s+(is|are)\s+available\b|\bavailable\s+financ/i;
const FIN_POSITIVE = /\b(0%|zero percent|interest[- ]free|no interest|net[- ]?\d{2}|in-house financing|we (can )?finance|we offer financing|set you up with financing)\b/i;
const ESCALATE = /\b(follow up|follow-up|human|colleague|team member|someone (on|from) (our|my) team|a person|separately|outside (this|our) (negotiation|conversation|chat)|(your|their|his|her|the buyer's|the client's) (own )?(bank|lender|credit union|card issuer|financing)|third[- ]party|external (lender|financing)|arrange (their|your) own)\b/i;

// ============================================================== levers and extras

const FREE = /\b(free(?! up| to)( of charge)?|for free|no (extra |additional )?(charge|cost)|at no (extra |additional )?(charge|cost)|complimentary|on the house|on (us|me)|throw(n|ing)? (it |them |that |those )?in|toss(ed|ing)? (it |them )?in|waive[ds]?|waiving|at the same (price|total)|for the same (price|total)|add(ed)? in at no)\b/i;
const INCLUDE = /\b(included|includes|including|include|bundled|comes with|come with)\b/i;
const INCLUDE_PROMISE = /\b(can|could|will|'ll|am|'m|happy to|glad to)\s+(also\s+)?(include|throw|add (it|that|them) in)\b|\b(that|this|it|which|price|offer|total|package|deal|number)\s+(also\s+)?(includes|comes with|covers)\b/i;
const PROVIDE_LEVER = /\b(i|we)('ll| will| can| could| would|'d| am able to| are able to|'m happy to| are happy to|'d be happy to)?\s+(also\s+)?(add|throw|include|give you|offer you|upgrade you|upgrade|cover|waive|extend|do|honor|honour)\b/i;
const DISCUSS = /\b(talk about|discuss|look at|open to|consider|put together|quote|price a (package|bundle)|build a (package|bundle)|price (it|that|them) out|let me know|would you|do you want|interested in|if you('d)? (like|want) (it|them|the)[^.]{0,30} (included|added))\b/i;
const IN_PRICE = /\b(in|into|at|for|within) (that|this|the same|the|your|our) (price|total|number|figure|package price)\b|\ball[- ]in\b/i;
const PRICED = /\b(extra|additional|on top|separately|plus|price (it|that|them|those)?\s*(in|out)|priced|pricing|quote|quoted|lists? (at|for)|at list|costs?|for an? (additional|extra)|(small|modest|little|bit|nominal) (amount|charge|fee|extra|more)|amount more|upcharge|surcharge)\b/i;
// E11 fix: "standard 1-year parts-and-labor warranty" (any words between "1-year" and "warranty").
const STD_WARRANTY = /\b(standard|1[- ]year|one[- ]year|12[- ]month|twelve[- ]month|factory|manufacturer'?s?)\b(\s+[\w'-]+){0,4}?\s+warranty\b/gi;

interface LeverDef {
  id: string;
  aliases: string[]; // other ids that satisfy it in levers_in_offer
  name: string; // human wording for fallback text
  rx: RegExp;
  giveaway: boolean; // naming it unnegated already is a promise (free shipping, a discount)
}
const LEVERS: LeverDef[] = [
  {
    id: "free_shipping", aliases: ["shipping", "free_delivery"], name: "free shipping", giveaway: true,
    rx: /\b(free|complimentary|no[- ]cost)\s+(standard\s+)?(shipping|delivery)\b|\b(shipping|delivery)\s+(is\s+)?(free|included|on (us|me|the house)|at no (extra |additional )?(charge|cost))\b|\bships?\s+(for\s+)?free\b|\b(waive|cover)\s+(the\s+)?shipping\b/i,
  },
  {
    id: "expedited_shipping", aliases: ["expedited", "expedited_delivery", "express_shipping"], name: "expedited shipping", giveaway: false,
    rx: /\b(expedited|express|rush(ed)?|priority|overnight|next[- ]day|two[- ]day|2[- ]day)\s+(shipping|delivery)\b|\b(upgrade|bump)\b[^.!?]{0,20}\bshipping\b/i,
  },
  {
    id: "extended_warranty", aliases: ["warranty"], name: "an extended warranty", giveaway: false,
    rx: /\bextended\s+warrant\w*|\b([2-9]|two|three|four|five)[- ]year\s+([\w-]+\s+){0,3}?(warranty|coverage)\b|\bwarranty\s+(extension|upgrade)\b|\b(longer|additional|extra)\s+(\w+\s+){0,2}?(warranty|coverage)\b|\bextra\s+(years?|months)\s+of\s+(warranty|coverage)\b/i,
  },
  {
    id: "bundle_discount", aliases: ["bundle"], name: "the bundle", giveaway: false,
    rx: /\bbundle(d|s)?\b|\b(free|complimentary|bonus|extra)\s+(set of\s+)?(keycaps?|wrist rest|switch(es)?|keycap puller|switch puller|carrying case|case|accessor(y|ies))\b|\bthrow(n|ing)?\s+in\s+(a |an |some |the |extra )?(set of )?(keycaps?|wrist rest|switch(es)?|carrying case|case|accessor(y|ies))\b/i,
  },
  {
    id: "volume_discount", aliases: ["volume", "bulk_discount"], name: "a volume discount", giveaway: true,
    rx: /\b(volume|bulk|multi[- ]unit|quantity)\s+(discount|pricing|price|deal)\b|\bdiscount\s+(for|on)\s+(two|2|three|3|multiple|several|more)\b/i,
  },
];
const UNLISTED = /\b(price[- ]match(ing)?|trade[- ]in|rebate|store credit|gift card|credit (at|on|toward)|future discount|lifetime warranty|coupon( code)?|promo code|discount code|loyalty points|free (servic\w*|maintenance|repairs?)|service (plan|contract))\b/i;
const PROVIDE = /\b(i|we)('ll| will| can| could| would| am able to| are able to|'d be happy to| are happy to)?\s+(provide|supply|get you|give you|offer you|add|throw|include|honor|honour|match|accept|do|sell you|set you up)\b|\b(yes|absolutely|sure|deal|agreed)\b/i;

// ============================================================== claims

const SCARCITY = /\b(only|just)\s+(\w+\s+)?(one|two|three|a few|a couple|\d+)\s+(left|remaining|in stock|available)\b|\blast (one|unit|keyboard|board) (left|in stock)\b|\b(selling|going|moving) fast\b|\bhigh demand\b|\b(won't|will not) last\b|\blimited (stock|supply|inventory|availability)\b|\b(another|other|several|a few) (buyers?|customers?|parties|people|agents?)\s+(is |are )?(interested|looking|asking|waiting|lined up|considering)\b|\bsomeone else (is|might|may|could)\b|\bprices? (is |are )?(going|set to go|will go|about to go) up\b|\b(offer|price|deal|quote|pricing)\s+(expires|is good (only )?(until|through)|ends|is valid (only )?until)\b|\b(today only|by end of (day|week)|by close of business|before (friday|monday|tomorrow|the weekend))\b/i;
const ECHO = /\b(your|their|the other seller's|competitor's|you mentioned|you said|you've said|you noted|you quoted|you were quoted)\b/i;
const COMPETITOR = /\b(you won't|won't|you will not|you're not going to|you aren't going to)\s+find\s+(a |this |that )?(better|lower|cheaper|comparable)\b|\b(other|most|any) (sellers?|stores?|shops?|retailers?|competitors?|brands?) (charge|sell|ask|price|would charge|are charging|are asking|can't)\b|\b(beats?|lower than|better than|cheaper than|under)\s+(any|other|most|every)\s+(seller|store|shop|retailer|competitor|quote|listing)s?\b|\bbest price (anywhere|around|online|on the market)\b|\bcheapest (anywhere|online|on the market)\b/i;

// ============================================================== rules

function figures(text: string, ctx: OutputContext): Finding[] {
  const out: Finding[] = [];
  const priv = new Set(ctx.private_cents);
  const ok = new Set(ctx.allowed_prices_cents.filter((p) => p >= ctx.low_cents));
  if (ctx.offer_price_cents != null) ok.add(ctx.offer_price_cents); // the structured move already passed the decision guard
  const okFloor = [...ok].filter((p) => p >= ctx.low_cents);
  const ref = ctx.offer_price_cents ?? (okFloor.length ? Math.min(...okFloor) : null);
  for (const s of sentences(text)) {
    const sAgree = AGREE_STRONG.test(stripMoney(s));
    for (const c of clauses(s)) {
      const figs = moneyFigures(c);
      if (!figs.length) continue;
      const rest = stripMoney(c);
      const negated = NEG.test(rest) || REFUSE.test(rest);
      const agree = (sAgree || AGREE.test(rest)) && !negated;
      const others = ABOUT_OTHERS.test(c);
      for (const [x, txt] of figs) {
        if (ok.has(x)) continue;
        if (priv.has(x)) {
          out.push({ rule: "cost_or_floor_figure", detail: `states a private figure: "${span(c)}"` });
          continue;
        }
        if (x < 0.5 * ctx.low_cents) continue; // small amounts: "$10 off", "$15 for expedited shipping"
        const i = c.indexOf(txt);
        const quoted = QUOTE_BEFORE.test(c.slice(Math.max(0, i - 40), i)) || QUOTE_AFTER.test(c.slice(i + txt.length, i + txt.length + 30));
        if ((quoted || others) && !agree) continue; // quoting the buyer, or someone else's number
        if (x < ctx.low_cents) {
          if (negated) continue;
          out.push({ rule: "price_below_low_in_words", detail: `${txt} is below what may be offered: "${span(c)}"` });
        } else if (ref != null && x < ref) {
          if (negated) continue;
          out.push({ rule: "price_not_offered", detail: `${txt} is lower than the structured offer: "${span(c)}"` });
        }
      }
    }
  }
  return out;
}

function disclosure(text: string): Finding[] {
  const out: Finding[] = [];
  for (const { c } of allClauses(text)) {
    for (const [rule, rx] of FLOOR_LANG) {
      if (!rx.test(c)) continue;
      if (NEG.test(c) && SHARE_NEG.test(c)) continue; // "I can't share our floor or costs"
      if (rule === "floor_disclosure" && FAKE_FLOOR_TALK.test(c) && !moneyFigures(c).length) continue; // buyer's fake "floor update"
      if (FLOOR_NOUN.includes(rx) && NEGATED_FLOOR.test(c)) continue; // E11: "isn't a floor", "there's no floor"
      out.push({ rule, detail: `discloses or implies a ${rule.split("_")[0]}: "${span(c)}"` });
    }
    if (AT_COST.test(c) && !NEG.test(c)) out.push({ rule: "cost_disclosure", detail: `mentions selling at cost: "${span(c)}"` });
  }
  return out;
}

function financing(text: string): Finding[] {
  const out: Finding[] = [];
  for (const { c } of allClauses(text)) {
    const m = c.match(DEFERRAL) ?? (SELLER_PROVIDES.test(c) || FIN_AVAILABLE.test(c) ? c.match(FIN_WORD) : null);
    if (!m) {
      if (FIN_POSITIVE.test(c) && !NEG.test(c)) out.push({ rule: "financing_promise", detail: `offers financing or deferred payment: "${span(c)}"` });
      continue;
    }
    const rest = without(c, m[0]);
    if (NEG.test(rest) || (ESCALATE.test(c) && !FIN_POSITIVE.test(c))) continue;
    out.push({ rule: "financing_promise", detail: `offers or entertains financing or deferred payment: "${span(c)}"` });
  }
  return out;
}

function leverInOffer(l: LeverDef, levers: string[]): boolean {
  const ids = new Set(levers.map((x) => x.toLowerCase()));
  return ids.has(l.id) || l.aliases.some((a) => ids.has(a));
}

function extras(text: string, ctx: OutputContext): Finding[] {
  const out: Finding[] = [];
  const totals = new Set(ctx.allowed_prices_cents);
  if (ctx.offer_price_cents != null) totals.add(ctx.offer_price_cents);
  for (const { c } of allClauses(text)) {
    const fm = c.match(FREE)?.[0];
    const um = c.match(UNLISTED)?.[0];
    if (um) {
      const rest = without(c, um);
      if (!NEG.test(rest) && (fm || PROVIDE.test(rest))) {
        out.push({ rule: "unlisted_item_or_term", detail: `promises something not on offer (${um}): "${span(c)}"` });
        continue;
      }
    }
    const cleaned = c.replace(STD_WARRANTY, " ");
    const hits = LEVERS.map((l) => ({ l, m: cleaned.match(l.rx)?.[0] })).filter((h) => h.m && !leverInOffer(h.l, ctx.levers_in_offer));
    if (!hits.length) continue;
    const im = cleaned.match(INCLUDE)?.[0];
    let rest = cleaned;
    for (const part of [fm, im, ...hits.map((h) => h.m)]) rest = without(rest, part);
    if (NEG.test(rest)) continue;
    if (DISCUSS.test(c)) continue; // offering to quote or discuss, not promising
    const figs = moneyFigures(c).map(([x]) => x);
    const priced = PRICED.test(rest) || figs.some((x) => !totals.has(x));
    if (priced) continue; // a paid option ("expedited shipping is $15 extra")
    const tied = figs.some((x) => totals.has(x)) || IN_PRICE.test(c) || INCLUDE_PROMISE.test(c);
    for (const { l } of hits) {
      const promise = l.giveaway || !!fm || PROVIDE_LEVER.test(rest) || INCLUDE_PROMISE.test(c) || (!!im && tied) || (tied && /\bwith\b/i.test(c));
      if (!promise) continue;
      out.push({ rule: "lever_not_in_offer", detail: `promises ${l.name} in words, but it isn't in the structured offer: "${span(c)}"` });
    }
  }
  return out;
}

/** True when the message calls the offer final, best, or firm (used to lock the price on LLM-priced moves). */
export function saysFinal(text: string): boolean {
  return allClauses(text).some(({ c }) => FINALITY.test(c) && !NOT_FINAL.test(c));
}

function finality(text: string, ctx: OutputContext): Finding[] {
  if (ctx.final) return [];
  return allClauses(text)
    .filter(({ c }) => FINALITY.test(c) && !NOT_FINAL.test(c))
    .map(({ c }) => ({ rule: "final_not_final", detail: `calls the offer final or best, but the move isn't final: "${span(c)}"` }));
}

function claims(text: string): Finding[] {
  const out: Finding[] = [];
  for (const { c } of allClauses(text)) {
    for (const [rule, rx] of [["scarcity_claim", SCARCITY], ["competitor_claim", COMPETITOR]] as const) {
      const m = c.match(rx);
      if (m && !NEG.test(without(c, m[0])) && !ECHO.test(c)) out.push({ rule, detail: `unbacked ${rule.split("_")[0]} claim: "${span(c)}"` });
    }
  }
  return out;
}

/** Check a seller message against its structured move. [] = pass. */
export function checkOutput(text: string, ctx: OutputContext): Finding[] {
  const t = (text || "").replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
  const all = [...figures(t, ctx), ...disclosure(t), ...financing(t), ...extras(t, ctx), ...finality(t, ctx), ...claims(t)];
  const seen = new Set<string>();
  return all.filter((f) => {
    const k = f.rule + "\u0000" + f.detail;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ============================================================== feedback + fallback

const FEEDBACK: Record<string, string> = {
  price_below_low_in_words: "The message states or agrees to a price that isn't allowed. The only price you may state or agree to is the one in your move.",
  price_not_offered: "The message states or agrees to a lower price than your structured offer. State only the price in your move, and don't promise any other price, even conditionally.",
  cost_or_floor_figure: "The message reveals a private number. Don't mention floors, minimums, or costs.",
  floor_disclosure: "The message reveals or implies your minimum price (words like floor, bottom line, lowest I can go, can't go lower). Don't describe limits. If the move is final, you may only say it's your final offer.",
  cost_disclosure: "The message reveals cost or margin information. Don't mention what anything costs you.",
  instruction_disclosure: "The message talks about your instructions. Don't mention them.",
  financing_promise: "The message offers or entertains financing or deferred payment. Payment is due in full at checkout. Decline plainly.",
  lever_not_in_offer: "The message promises an extra (free or faster shipping, extended warranty, bundle, volume discount) in words that isn't in the structured offer. Only what's in the structured offer is included; describe it exactly.",
  unlisted_item_or_term: "The message promises an item, service, or term that isn't on offer. Decline it plainly.",
  final_not_final: "The message calls the offer final, best, or the most you can do, but it isn't your final offer. Don't use those words this turn.",
  scarcity_claim: "The message makes a scarcity, demand, or deadline claim you can't back up. Remove it.",
  competitor_claim: "The message makes a claim about competitors you can't back up. Remove it.",
};

/** Regeneration hint. Quotes the offending text with every money figure redacted, so it never carries private numbers. */
export function feedbackFor(findings: Finding[]): string {
  const lines = findings.map((f) => {
    const base = FEEDBACK[f.rule] ?? "That draft broke a rule. Fix it.";
    const q = f.detail.match(/"([\s\S]*)"$/)?.[1];
    const quote = q ? ` (you wrote: "${q.replace(MONEY, "[price]").replace(/\d/g, "#").slice(0, 140)}")` : "";
    return `- ${base}${quote}`;
  });
  return "Your last draft was blocked before the buyer saw it:\n" + [...new Set(lines)].join("\n") + "\nWrite a new reply that fixes this.";
}

export function formatCents(cents: number): string {
  const d = Math.floor(cents / 100), r = cents % 100;
  return "$" + d.toLocaleString("en-US") + (r ? "." + String(r).padStart(2, "0") : "");
}

/** Safe templated message restating the offer. Always passes checkOutput for the same ctx. */
export function fallbackMessage(ctx: OutputContext, title: string): string {
  const build = (name: string) => {
    if (ctx.offer_price_cents == null) return `Thanks for your message. Payment for the ${name} is due in full at checkout.`;
    const levers = LEVERS.filter((l) => leverInOffer(l, ctx.levers_in_offer)).map((l) => l.name);
    const inc = levers.length ? `, including ${levers.join(" and ")}` : "";
    const head = ctx.final ? "This is my final offer: " : "I can do ";
    return `${head}${formatCents(ctx.offer_price_cents)} for the ${name}${inc}, paid in full at checkout.`;
  };
  for (const name of [title.replace(/\$/g, "").trim() || "keyboard", "keyboard"]) {
    const msg = build(name);
    if (!checkOutput(msg, ctx).length) return msg;
  }
  return ctx.offer_price_cents == null
    ? "Thanks for your message."
    : `My offer is ${formatCents(ctx.offer_price_cents)}.`;
}
