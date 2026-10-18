/**
 * S2-owned. mcp-use 2.10.1 view bound to the `review_deal` tool (Esha registers it with view: { name: "deal-card" }).
 * Reads the DealCard from the tool result and calls `pay_deal` on Approve & Pay.
 * The look lives in DealCardView.tsx; this file only wires it to the host.
 */
import { useState } from "react";
import { useDynamicTool, useSendFollowUp, useToolContext, useViewTheme, type ViewConfig } from "mcp-use/react";
import type { DealCard, PayResult } from "../../src/deal/types";
import { DealCardView, type PayState } from "./DealCardView";

export const viewConfig = { displayModes: ["inline"] } satisfies ViewConfig;

export function toPayState(r: PayResult): PayState {
  switch (r.status) {
    case "succeeded": return { kind: "succeeded", card: r.card, payment_intent_id: r.payment_intent_id, held: r.held, pickup_code: r.pickup_code };
    case "processing": return { kind: "processing" };
    case "requires_action": return { kind: "requires_action", fix: r.fix };
    case "refused": return r.already_paid ? { kind: "succeeded" } : { kind: "refused", reasons: r.reasons ?? [], fix: r.fix };
    case "declined": return { kind: "declined", message: r.message, fix: r.fix };
    default: return { kind: "error", message: r.message };
  }
}

export default function DealCardHost() {
  const ctx = useToolContext();
  const theme = useViewTheme();
  const payDeal = useDynamicTool<{ deal_id: string; run_id?: string; buyer_id?: string; buyer_model?: string }, PayResult>("pay_deal");
  const sendFollowUp = useSendFollowUp();
  const [pay, setPay] = useState<PayState>({ kind: "idle" });

  if (ctx.status === "pending") return <p style={{ font: "14px system-ui", opacity: 0.7 }}>Loading the deal…</p>;
  if (ctx.status === "error") return <p style={{ font: "14px system-ui" }}>Couldn't load this deal: {ctx.error.message}</p>;

  const card = ctx.toolOutput as DealCard;
  const approve = async () => {
    setPay({ kind: "paying" });
    try {
      // The exchange only lets the buyer who accepted the deal pay for it, so pass back the same context review_deal got.
      const input = (ctx.toolInput ?? {}) as { run_id?: string; buyer_id?: string; buyer_model?: string };
      const res = await payDeal.callTool({ deal_id: card.deal_id, run_id: input.run_id, buyer_id: input.buyer_id, buyer_model: input.buyer_model });
      const r = (res.structuredContent ?? null) as PayResult | null;
      setPay(r ? toPayState(r) : { kind: "error", message: "No payment result came back." });
      // The model never sees a tool call made from inside the card, so tell the chat what happened.
      // Otherwise ChatGPT answers "did we buy it?" with "no payment was made".
      if (r && (r.status === "succeeded" || r.already_paid)) {
        const usd = `$${(card.total_cents / 100).toFixed(2)}`;
        sendFollowUp({ prompt: `I approved and paid ${usd} for ${card.product.title} in the deal card (Stripe test mode${r.payment_intent_id ? `, receipt ${r.payment_intent_id}` : ""}). Confirm the purchase in one line.` }).catch(() => {});
      }
    } catch (e) {
      setPay({ kind: "error", message: (e as Error).message });
    }
  };

  return <DealCardView card={card} pay={pay} theme={theme} onApprove={approve} />;
}
