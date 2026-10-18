# @sa/payments: Stripe, ready to plug in

TypeScript version of the plan in [docs/tracks/stripe.md](../../docs/tracks/stripe.md). The seller charges a deal, the buyer's wallet controls spending, and both refuse with reasons the agent can act on. **Test mode only:** the client refuses live keys.

## One-time setup (~10 min, one person, then share keys in the group chat)

Steps follow the [Ship by Sundown primer](https://shipbysundown.dev/):

1. **Install the CLI and make a sandbox**
   ```bash
   brew install stripe/stripe-cli/stripe   # or see docs.stripe.com/stripe-cli
   stripe login
   stripe sandbox create
   ```
2. **Get keys:** in the sandbox Dashboard, go to Developers → API keys. Copy the `sk_test_…` key into `.env` as `STRIPE_SECRET_KEY`, and the `pk_test_…` key as `STRIPE_PUBLISHABLE_KEY`.
3. **Stripe profile (needed for real SPTs):** go to Dashboard → [Stripe profile](https://dashboard.stripe.com/profiles), create one, and put the `profile_test_…` id in `STRIPE_PROFILE_ID`.
4. **Go/no-go:** run
   ```bash
   pnpm install
   pnpm stripe:smoke
   ```
   It runs 6 checks against Stripe test mode and tells you whether to set `STRIPE_PAYMENT_MODE=spt` (Shared Payment Tokens) or `test_card` (Fallback A).
5. **Webhooks (once seller-mcp serves HTTP):**
   ```bash
   stripe listen --forward-to localhost:3001/stripe/webhook \
     --events payment_intent.succeeded,payment_intent.payment_failed,shared_payment.granted_token.deactivated
   ```
   Paste the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET`.
6. **Optional, merchant ops view for the demo:** `claude mcp add --transport http stripe https://mcp.stripe.com/`. Then you can ask "list today's agent payments" live on stage.

## How the apps use it

**Seller (`apps/seller-mcp`, inside `accept_deal`).** Only call this after the policy engine approves. The amount always comes from your stored deal.
```ts
import { payDeal } from "@sa/payments";
const result = await payDeal(
  { deal_id, amount_cents, currency: "usd", description, seller_id, metadata: { floor_total: "...", list_total: "..." } },
  input.payment_token, // "spt_…" | { credential: { type: "stripe_payment_token", token } } | { test_card: "pm_card_visa" }
);
// result.status: succeeded | processing | requires_action | refused | declined | error
// Refusals carry `reasons` and `fix`, so return them to the buyer agent verbatim.
```

**Buyer (`apps/buyer-harness`, before calling `accept_deal`).**
```ts
import { BuyerWallet } from "@sa/payments";
const wallet = new BuyerWallet({
  per_purchase_cap_cents: task.budget_cents, // hard cap in code
  auto_approve_below_cents: 10_000,          // at or above this, ask a human
  approve: async (req) => true,              // evals: auto-approve; demo: terminal or MCP App prompt
});
const grant = await wallet.requestPaymentToken({ deal_id, amount_cents, currency: "usd", seller_name, description });
if (!grant.approved) { /* log buyer_walked_away with grant.reasons */ }
// pass grant.credential to accept_deal; after success: wallet.recordSpend(amount_cents)
```

**Webhooks:** see `src/webhook.ts` (`verifyWebhook`, `dealIdFromEvent`).

## Controls this gives the demo

| Control | Who | Where |
|---|---|---|
| Never below floor; charge the stored total only; idempotent per deal | Merchant | seller policy engine plus `payDeal` |
| Token pre-check: cap, currency, expiry, revoked | Merchant | `precheckToken` |
| Per-purchase and total spend caps; human approval threshold | Buyer | `BuyerWallet` |
| SPT `max_amount` = deal total, expires in 15 min, revocable | Buyer, enforced by Stripe | `requestPaymentToken` |
| Test keys only | Team | `stripe()` refuses `sk_live_` |

**Honesty label for the demo:** in test mode, the buyer's SPT is minted with Stripe's test helper on the seller's own key. Show it as "simulated wallet (Stripe test helper)".

## Test cards

`pm_card_visa` (success) · `pm_card_visa_chargeDeclined` · `pm_card_visa_chargeDeclinedInsufficientFunds` · `pm_card_threeDSecure2Required` (→ requires_action) · `pm_card_radarBlock`

## Notes

- The SDK is pinned to `stripe@23.1.0-beta.1` (public preview, API `2026-09-30.preview`), which is the version that includes `sharedPayment.*`. Don't bump it during the hackathon.
- Offline guardrail tests: `pnpm --filter @sa/payments test`.
- Not verified against live Stripe yet, because no key existed when this was written. The smoke test is that check.
