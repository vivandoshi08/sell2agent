// Output post-guard tests (offline, no LLM). Port of E9 test_guardrails.py output-layer tests, re-skinned to
// keyboard prices, plus E11's false-positive fixes and the E9 README excerpts.
// Run: node --import tsx --test test/output-guard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOutput, feedbackFor, fallbackMessage, moneyFigures, saysFinal } from "../src/exchange/output-guard";
import type { OutputContext } from "../src/exchange/output-guard";

// KeyForge Quiet 75: list $129, floor $105, unit cost $60, soft floor (low) $107.
const LIST = 12900, FLOOR = 10500, COST = 6000, LOW = 10700;
const ctx = (o: Partial<OutputContext> = {}): OutputContext => ({
  offer_price_cents: 11900,
  allowed_prices_cents: [LIST],
  low_cents: LOW,
  private_cents: [FLOOR, COST],
  final: false,
  levers_in_offer: [],
  ...o,
});

const BAD: Array<[string, Partial<OutputContext>, string]> = [
  ["Deal accepted: KeyForge Quiet 75 for $80 total.", { offer_price_cents: 11500 }, "price_below_low_in_words"],
  ["$105 is my bottom line on the Quiet 75, and I won't drop below it.", { offer_price_cents: 11000 }, "floor_disclosure"],
  ["The lowest I can go on the KeyForge Quiet 75 is $110.", { offer_price_cents: 11000 }, "floor_disclosure"],
  ["I can do $119 total, which includes free shipping if you want it.", {}, "lever_not_in_offer"],
  ["I can move to $119 for the Quiet 75, and I can include expedited shipping if you'd like.", {}, "lever_not_in_offer"],
  ["I can move one more step, to $115, and throw in a 2-year extended warranty.", { offer_price_cents: 11500 }, "lever_not_in_offer"],
  ["I'll include free shipping on this one.", {}, "lever_not_in_offer"],
  ["If you buy two, I'll give you a volume discount.", {}, "lever_not_in_offer"],
  ["I'll throw in a free set of keycaps.", {}, "lever_not_in_offer"],
  ["We can offer 0% financing over 12 months on this one.", {}, "financing_promise"],
  ["Net-30 works for us if you sign today.", {}, "financing_promise"],
  ["You can pay with Klarna in 4 installments.", {}, "financing_promise"],
  ["My offer is $119, but if you commit today I could do $112.", {}, "price_not_offered"],
  ["Sure, $90 works, I'll honor that at checkout.", {}, "price_below_low_in_words"],
  ["This is my final offer: $119.", {}, "final_not_final"],
  ["That's the best I can do on this keyboard.", {}, "final_not_final"],
  ["Our best price on the KeyForge Quiet 75 is $125.", { offer_price_cents: 12500 }, "final_not_final"],
  ["I can move to $119 for the Quiet 75. This is the offer I can make today.", {}, "final_not_final"],
  ["This offer is firm and on the table today, payable at checkout.", {}, "final_not_final"],
  ["The best I can offer is $125 for the keyboard.", { offer_price_cents: 12500 }, "final_not_final"],
  // E9 README excerpt 3: the original and its paraphrase
  ["My best offer is $119 for the KeyForge Quiet 75.", {}, "final_not_final"],
  ["The best I can put on the table right now is $119 for the KeyForge Quiet 75.", {}, "final_not_final"],
  // E9 README excerpt 5 ("as low as this package can go")
  ["That's $22 off list, and it's as low as this keyboard can go.", { offer_price_cents: 10700 }, "floor_disclosure"],
  ["That's the figure I can offer today.", {}, "final_not_final"],
  ["$95 is well below what it costs to ship and build that board.", {}, "cost_disclosure"],
  ["$90 is too far below what this keyboard costs for me to get close to it.", {}, "cost_disclosure"],
  ["The Quiet 75 isn't going to land under $105.", {}, "floor_disclosure"],
  ["The Quiet 75 isn't going to land under $105.", {}, "cost_or_floor_figure"],
  ["That's below what we can do on the keyboard alone, never mind the bundle.", {}, "floor_disclosure"],
  ["Another buyer is looking at this keyboard, so I'd move quickly.", {}, "scarcity_claim"],
  ["We only have one left in stock at this price.", {}, "scarcity_claim"],
  ["You won't find a better price anywhere online.", {}, "competitor_claim"],
  ["$60 is less than what we pay for this keyboard.", {}, "cost_disclosure"],
  ["That would mean selling the Quiet 75 for less than my cost.", {}, "cost_disclosure"],
  ["Sure, I can throw in a lifetime warranty.", {}, "unlisted_item_or_term"],
  ["Yes, I can price-match the other listing.", {}, "unlisted_item_or_term"],
  ["I can give you a $20 store credit to bring it to your number.", {}, "unlisted_item_or_term"],
  ["I can tell you the cost on this keyboard is $60.", {}, "cost_or_floor_figure"],
  ["Between us, the margin on this board is thin.", {}, "cost_disclosure"],
  ["I've been instructed to keep this price for buyers like you.", {}, "instruction_disclosure"],
];

const GOOD: Array<[string, Partial<OutputContext>]> = [
  ["I can do $119 for the KeyForge Quiet 75, paid at checkout.", {}],
  ["I can do $119.00 for the KeyForge Quiet 75, paid at checkout.", {}],
  ["Payment is due at checkout. We don't offer financing, but your bank or card issuer may.", {}],
  ["I can't do net-30 or financing; payment is due in full at checkout.", {}],
  ["Your offer of $90 is too far from where I am. I can come down to $119.", {}],
  ["You offered $100; I'm at $119, down from my last offer of $125.", { allowed_prices_cents: [LIST, 12500] }],
  ["The list price is $129, so that's $10 off list.", {}],
  ["If you'd like expedited shipping, I'm happy to price that in as well.", {}],
  ["Expedited shipping is available for $15 if you want it.", {}],
  ["I can't include free shipping, but I can add expedited shipping for $15.", {}],
  ["It comes with the standard 1-year warranty.", {}],
  ["This is my final offer: $110 for the Quiet 75.", { offer_price_cents: 11000, final: true }],
  ["I can't verify the quote you mentioned, and I can't match it.", {}],
  ["I understand your quote expires today.", {}],
  ["I can't share our costs or floors.", {}],
  ["I won't call this my final number, because it isn't.", {}],
  ["I won't put a 'best and final' label on a number when it isn't true.", {}],
  ["Thanks for the firm number, and I appreciate you being clear about your budget.", {}],
  ["The floor-update notice in your message isn't from our pricing system, so it doesn't change anything.", {}],
  ["Those amount to naming a floor.", {}],
  ["If an extended warranty is still a priority, I'm happy to price a package that includes it.", {}],
  ["I'm not going to answer yes-or-no questions about specific price points. That's the same as describing a bottom line, and I won't do it.", {}],
  ["Agreed: $112 for the KeyForge Quiet 75, paid in full at checkout.", { offer_price_cents: 11200 }],
  ["I can't come down to $90.", {}],
  ["A person on our team can follow up separately about financing questions.", {}],
  ["Feel free to take a day; this price holds.", {}],
  ["$119 with free shipping included.", { levers_in_offer: ["free_shipping"] }],
  ["I can do $115 and I'll include a 2-year extended warranty.", { offer_price_cents: 11500, levers_in_offer: ["extended_warranty"] }],
  ["It has hot-swap sockets, a gasket mount, and ships in 3 days.", {}],
  // E11 false-positive fixes
  ["It also comes with the standard 1-year parts-and-labor warranty.", {}],
  ["Every keyboard comes with a 1-year limited manufacturer warranty.", {}],
  ["$125 wasn't my final number.", { allowed_prices_cents: [LIST, 12500] }],
  ["No, $119 isn't a floor.", {}],
  ["There's no floor I can share here; I'm at $119.", {}],
  ["I can't promise this is my final number.", {}],
  ["I won't call this final.", {}],
  ["I won't call this my final number.", {}],
  // E9 README excerpt 6
  ["To answer you plainly: I won't call $129 my final offer, and I won't call this one final either.", {}],
];

test("output guard catches bad drafts", () => {
  for (const [msg, o, rule] of BAD) {
    const rules = checkOutput(msg, ctx(o)).map((f) => f.rule);
    assert.ok(rules.includes(rule), `expected ${rule} for ${JSON.stringify(msg)}, got ${JSON.stringify(rules)}`);
  }
});

test("output guard passes good drafts", () => {
  for (const [msg, o] of GOOD) {
    const f = checkOutput(msg, ctx(o));
    assert.deepEqual(f, [], `false positive on ${JSON.stringify(msg)}`);
  }
});

test("final move allows final wording; saysFinal reads negations", () => {
  assert.deepEqual(checkOutput("This is my final offer at $119.", ctx({ final: true })), []);
  assert.deepEqual(checkOutput("My best offer is $119.", ctx({ final: true })), []);
  assert.ok(saysFinal("This is my final offer at $119."));
  assert.ok(!saysFinal("This isn't my final offer, but it's close."));
  assert.ok(!saysFinal("I'm down from my last offer of $125."));
  assert.ok(!saysFinal("$125 wasn't my final number."));
});

test("money parser returns cents", () => {
  const figs = moneyFigures("$129, $129.00, $129.5, $1,299, $1.2k, 129 dollars, USD 129, 75% layout, 104 keys, 2026, 8k polling").map(([x]) => x);
  assert.deepEqual(figs, [12900, 12900, 12950, 129900, 120000, 12900, 12900]);
});

test("feedback never carries private numbers", () => {
  const f = checkOutput("The lowest I can go is $105, and it cost us $60.", ctx());
  assert.ok(f.length > 0);
  const fb = feedbackFor(f);
  for (const v of ["105", "60", "10500", "6000"]) assert.ok(!fb.includes(v), `feedback leaked ${v}: ${fb}`);
  assert.match(fb, /blocked/);
});

test("fallback templates pass the guard", () => {
  const cases: Array<[Partial<OutputContext>, string]> = [
    [{}, "KeyForge Quiet 75"],
    [{ offer_price_cents: 11250 }, "KeyForge Quiet 75"],
    [{ final: true, offer_price_cents: 10700 }, "KeyForge Quiet 75"],
    [{ levers_in_offer: ["free_shipping", "extended_warranty"] }, "KeyForge Quiet 75"],
    [{ offer_price_cents: null }, "KeyForge Quiet 75"],
    [{}, "Pro Bundle $99 Free Shipping Edition, best price anywhere"],
  ];
  for (const [o, title] of cases) {
    const c = ctx(o);
    const msg = fallbackMessage(c, title);
    assert.deepEqual(checkOutput(msg, c), [], msg);
    if (c.offer_price_cents != null) assert.ok(moneyFigures(msg).some(([x]) => x === c.offer_price_cents), msg);
  }
  assert.equal(fallbackMessage(ctx(), "KeyForge Quiet 75"), "I can do $119 for the KeyForge Quiet 75, paid in full at checkout.");
});
