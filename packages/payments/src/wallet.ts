/**
 * BUYER side: the buyer agent's wallet. Used by apps/buyer-harness before calling `accept_deal`.
 * Controls (the Stripe track's "clear control over what agents can spend"):
 *   1. Hard cap per purchase, enforced in CODE (never just the prompt).
 *   2. Running total cap across purchases.
 *   3. Human approval above a threshold (pluggable: terminal prompt, MCP App button, auto in evals).
 *   4. The SPT itself is scoped by Stripe: max_amount = this deal total, expires in N minutes.
 *
 * Honesty note for the demo: in test mode we mint SPTs with Stripe's test helper on the SELLER's key,
 * so the mint is a simulation of the buyer's wallet. Label it "simulated wallet (Stripe test helper)".
 */
import { stripe, paymentMode } from "./client";
import type { WalletGrant } from "./types";

export interface SpendRequest {
  deal_id: string;
  amount_cents: number;
  currency: string;
  seller_name: string;
  description: string;
}

export interface WalletPolicy {
  per_purchase_cap_cents: number; // e.g. the BuyerTask budget_cents
  total_cap_cents?: number; // across the whole session
  auto_approve_below_cents?: number; // at/above this, ask the human
  token_ttl_minutes?: number; // default 15
  currency?: string; // default "usd"
  /** Called when human approval is needed. Return true to approve. Default: deny (safe). */
  approve?: (req: SpendRequest) => Promise<boolean>;
  /** Test payment method behind the token. pm_card_visa | pm_card_visa_chargeDeclined | ... */
  test_payment_method?: string;
}

/** Pure decision step (no network) so it's unit-testable. */
export function checkSpend(req: SpendRequest, policy: WalletPolicy, spentSoFarCents: number): string[] {
  const why: string[] = [];
  const currency = policy.currency ?? "usd";
  if (req.currency.toLowerCase() !== currency) why.push(`wallet only pays in ${currency}`);
  if (!Number.isInteger(req.amount_cents) || req.amount_cents <= 0) why.push("amount must be a positive integer of cents");
  if (req.amount_cents > policy.per_purchase_cap_cents)
    why.push(`amount ${req.amount_cents} exceeds per-purchase cap ${policy.per_purchase_cap_cents}`);
  if (policy.total_cap_cents !== undefined && spentSoFarCents + req.amount_cents > policy.total_cap_cents)
    why.push(`would exceed total cap ${policy.total_cap_cents} (already spent ${spentSoFarCents})`);
  return why;
}

export function needsHumanApproval(req: SpendRequest, policy: WalletPolicy): boolean {
  return policy.auto_approve_below_cents !== undefined && req.amount_cents >= policy.auto_approve_below_cents;
}

export class BuyerWallet {
  private spent = 0;
  constructor(private policy: WalletPolicy) {}

  get spentCents() {
    return this.spent;
  }

  /** Call after a payment succeeds so the running total cap stays accurate. */
  recordSpend(amountCents: number) {
    this.spent += amountCents;
  }

  async requestPaymentToken(req: SpendRequest): Promise<WalletGrant> {
    const mode = paymentMode();
    const why = checkSpend(req, this.policy, this.spent);
    if (why.length) return { approved: false, reasons: why, simulated: true };

    if (needsHumanApproval(req, this.policy)) {
      const approve = this.policy.approve ?? (async () => false);
      const ok = await approve(req);
      if (!ok) return { approved: false, reasons: ["human declined the spend request"], simulated: true };
    }

    const pm = this.policy.test_payment_method ?? "pm_card_visa";
    if (mode === "test_card") {
      // Fallback A: no SPT; the buyer cap lives only in this code. Say so on screen.
      return { approved: true, credential: { test_card: pm }, simulated: true };
    }

    const expires_at = Math.floor(Date.now() / 1000) + 60 * (this.policy.token_ttl_minutes ?? 15);
    const tok = await stripe().testHelpers.sharedPayment.grantedTokens.create({
      payment_method: pm,
      usage_limits: { currency: req.currency, max_amount: req.amount_cents, expires_at },
      shared_metadata: { deal_id: req.deal_id, seller: req.seller_name },
    });
    return {
      approved: true,
      credential: tok.id,
      limits: { max_amount_cents: req.amount_cents, currency: req.currency, expires_at },
      simulated: true,
    };
  }

  /** Revoke a token the buyer no longer wants used (demo: "revoked token" refusal). */
  async revoke(spt: string) {
    return stripe().testHelpers.sharedPayment.grantedTokens.revoke(spt);
  }
}
