// Bridge 3: a buyer agent should find follow-ups from the tool text alone (no special prompting).
import { test } from "node:test";
import assert from "node:assert/strict";
import { followupHint, render } from "../src/negotiate.js";

const offer = { offer_id: "off_12345678-aaaa", negotiation_id: "neg_1", buyer_id: "b1", price_cents: 13900, quantity: 1, levers: ["extended_warranty"], final: false,
  expires_at: "2026-10-19T12:00:00.000Z", status: "live", round: 3 } as any;

test("check_offers on a follow-up says it's a follow-up, what to tell the person, and how to accept", () => {
  const out = render({ ok: true, negotiation_id: "neg_1", state: "follow_up", allowed_actions: ["accept", "offer", "walk"], message: "status", standing_offer: offer } as any, "b1");
  const t = out.content[0].text;
  assert.match(t, /FOLLOW-UP OFFER/);
  assert.match(t, /\$139 incl\. extended_warranty/);
  assert.match(t, /accept_deal with offer_id off_12345678-aaaa/);
});

test("a final offer while negotiating points at walk_away with a follow-up", () => {
  const out = render({ ok: true, negotiation_id: "neg_1", state: "negotiating", allowed_actions: ["accept", "walk"], message: "final", standing_offer: { ...offer, final: true } } as any, "b1");
  assert.match(out.content[0].text, /walk_away; set allow_followup_to/);
});

test("after a consented walk-away: when, where, and that check_offers picks it up", () => {
  const email = followupHint({ reply_to: "me@example.test", channel: "email" }, "neg_1", "b1");
  assert.match(email, /by email to me@example\.test/);
  assert.match(email, /check_offers \(negotiation_id neg_1, buyer_id b1\)/);
  const a2a = followupHint({ reply_to: "b1", channel: "a2a" }, "neg_1", "b1");
  assert.doesNotMatch(a2a, / by a2a/);
  assert.match(a2a, /check_offers/);
});
