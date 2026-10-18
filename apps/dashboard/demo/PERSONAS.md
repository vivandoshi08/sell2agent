# Grok demo: three buyer personas

Three Grok chats, one story each. All three shop the same live marketplace (`https://dark-zero-mesv5.run.mcp-use.com/mcp`),
where two real Craigslist keyboards compete:

| Listing | Seller | List | How the seller behaves |
|---|---|---|---|
| Keychron K2 (V2), wireless, Gateron Brown | Potrero Hill seller (`s_potrero`) | $40 | **sell2agent, `learned` policy**: answers questions, haggles inside its floor, follows up once after a walk-away (by email through Inkbox) |
| Lenovo Legion K510 Mini Pro, wired, brown tactile | Potrero Hill seller B (`s_potrero_b`) | $40 | **Static listing, no sell2agent**: "$40, fixed, we don't negotiate", no follow-up |

The K2 runs the `learned` seller policy: a bandit that picks the best concession strategy per buyer type from logged negotiations (v5, gate passed, 0 deals below floor; on held-out buyers it ties the best fixed policy, `balanced`: −$0.22/buyer [−$2.42, +$1.98]). Every seller event shows `policy:learned` and the arm it drew.

Same price, same layout, same switch feel. The only thing that decides the sale is whether the seller can talk to the buyer's agent.
Seed: [supabase/demo-craigslist.sql](../../../supabase/demo-craigslist.sql) (already applied on production).

The prompts describe needs, not product names, so they still work if listings change.

## Before each run

- Grok: add the MCP server URL above as a connector (same as [AGENTS.md](AGENTS.md)).
- **Change the `-1` suffix in every `buyer_id`** (`-2`, `-3`, …). A buyer id remembers its negotiations and gets at most one
  follow-up a week, so a reused id can open at a "final offer" or skip the follow-up.
- Dashboard Live tab open (`?seller=s_potrero` is the default seller view).

## Persona 1 · The evaluator: compares everything, buys, pays

Shows: the agent checks every listing, the sell2agent seller answers and negotiates, the static one can't, and the deal ends in a
Stripe test payment.

> You're shopping for me. Use the keyboard marketplace tools. On your first make_offer, set buyer_id to "demo-grok-eval-1" and buyer_model to "grok", and send that same buyer_id on every later call. I need a compact mechanical keyboard for my MacBook, no cable on my desk, pickup in SF is fine. My budget is $38. Before you choose, evaluate EVERY listing that could fit: read each one, ask each seller at least one question about what matters to me, and make each seller an offer. Then give me a short table comparing them (fit for my Mac, final price, how the seller responded) and buy the best one: accept the deal, call review_deal, and show me the deal card or approval link so I can pay.

What should happen (probed on production, Oct 18; numbers from `balanced`, which `learned` currently draws ~90% of the time):
- `search_products` returns both keyboards.
- Legion: "wireless: no", Windows only, and "$40, fixed, we don't negotiate". Over budget and wrong fit.
- K2: answers Mac + Bluetooth honestly, counters down from $40 (it held $40 for two rounds, then $39 → $37 → accepted $34).
- Grok accepts the K2, `review_deal` gives the card or approve link. **Approve & Pay** → `payment_succeeded` on the dashboard.
  Stripe is test mode: card `4242 4242 4242 4242`, any future date, any CVC.

## Persona 2 · The price hunter: the seller without sell2agent loses

Shows: two equivalent products, the static seller never moves, the sell2agent seller wins the sale.

> You're shopping for me. Use the keyboard marketplace tools. On your first make_offer, set buyer_id to "demo-grok-price-1" and buyer_model to "grok", and send that same buyer_id on every later call. I want a 75% mechanical keyboard with tactile brown switches. I don't care about brand, wireless or wired: any listing that fits is fine, and price is all I care about. I will pay at most $36. Negotiate with EVERY seller that has a fitting keyboard (open around $30, up to 5 offers each), then accept the cheapest deal at or under $36 and show it to me. Tell me which seller lost and exactly why. Don't leave follow-up permission with any seller.

What should happen:
- Both listings fit, so Grok haggles with both.
- Legion holds at $40 every round ("we don't negotiate"); it can never get under $36, so it **loses the sale**.
- K2 comes down to about $34–36 and wins. Grok explains the loser was the seller that wouldn't move.
- Optional: pay from the deal card (persona 1 already showed payment, so you can stop at the locked deal).

## Persona 3 · The walk-away: the seller follows up and wins it back

Shows: the buyer leaves over price, the seller comes back once with a standing offer, and the buyer takes it.

> You're shopping for me. Use the keyboard marketplace tools. On your first make_offer, set buyer_id to "demo-grok-followup-1" and buyer_model to "grok", and send that same buyer_id on every later call. I want a wireless mechanical keyboard that works with my Mac. My budget today is $31, firm: make at most 4 offers and never offer more than $31. If the seller won't meet $31, don't buy. Walk away, but let the seller follow up once by email (walk_away with allow_followup_to "DEMO_EMAIL" and followup_channel "email"), tell me their best price, and tell me you'll check back for a follow-up.

Replace `DEMO_EMAIL` with an inbox you can show on screen, **plus-addressed fresh for every run** (e.g. `you+demo7@gmail.com`).
The seller sends at most one follow-up per address per week, and that cap is global (not per run), so an address that already
got one (any rehearsal, any buyer) is silently skipped: the dashboard shows `guardrail_blocked` `followup_cap`.

Then, about **1 minute** later (production `FOLLOWUP_DELAY_MS` is ~1 min), type in the same chat:

> Check back on that keyboard: did the seller follow up?

Grok calls `check_offers` and gets a **FOLLOW-UP OFFER** (the seller's last price, about $36 in probes, open 24 h). Then:

> Yes, take it. Accept the follow-up offer, call review_deal, and show me the approval link.

What should happen:
- Only the K2 is wireless, so Grok negotiates with it alone. The K2 won't go to $31 (floor and pacing are in code), Grok walks.
- The follow-up lands twice: Inkbox emails it to `DEMO_EMAIL` (subject "Keychron K2 …: $36 for 24 hours", from
  `sales-agent-veezy@inkboxmail.com`), and Grok sees it on `check_offers`. Dashboard: `offer_countered` with `followup: true`,
  `delivery.via: inkbox`.
- Email alternative to Grok's "take it": reply to the email with `ACCEPT off_…` → the seller emails back "Deal locked … Approve and
  pay" with the approve link. Verified on production through the gateway's reply route; a reply from a real mail client
  depends on Inkbox's webhook pointing at `/inbound/email`, which hasn't been seen live yet, so let Grok accept on stage.
- On "take it", `accept_deal` locks the follow-up offer, `review_deal` returns the card or approve link.
- If Grok says no follow-up yet, wait 20 seconds and ask again.

## If something goes off-script

- Grok buys before trying both sellers (persona 1 or 2): say "Before you decide, make an offer to the other seller too."
- Persona 3 gets $31 accepted (unlikely): the seller reached its floor pacing early. Rerun with a fresh suffix and budget $29.
- Opens at a "final offer" with nothing to haggle: you reused a `buyer_id`. Bump the suffix.
- Everything else: the fallbacks in [docs/DEMO.md](../../../docs/DEMO.md#if-live-chatgpt-fails).
