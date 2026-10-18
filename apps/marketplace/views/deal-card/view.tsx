/**
 * S2-owned. mcp-use 2.10.1 view bound to the `review_deal` tool (Esha registers it with view: { name: "deal-card" }).
 * Reads the DealCard from the tool result and calls `pay_deal` on Approve & Pay.
 * The look lives in DealCardView.tsx; this file only wires it to the host.
 */
import { useState } from "react";
import { useDynamicTool, useToolContext, useViewTheme, type ViewConfig } from "mcp-use/react";
import type { DealCard, PayResult } from "../../src/deal/types";
import { DealCardView, type PayState } from "./DealCardView";

export const viewConfig = { displayModes: ["inline"] } satisfies ViewConfig;

export function toPayState(r: PayResult): PayState {
  switch (r.status) {
    case "succeeded": return { kind: "succeeded", card: r.card, payment_intent_id: r.payment_intent_id };
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
  const payDeal = useDynamicTool<{ deal_id: string }, PayResult>("pay_deal");
  const [pay, setPay] = useState<PayState>({ kind: "idle" });

  if (ctx.status === "pending") return <p style={{ font: "14px system-ui", opacity: 0.7 }}>Loading the deal…</p>;
  if (ctx.status === "error") return <p style={{ font: "14px system-ui" }}>Couldn't load this deal: {ctx.error.message}</p>;

  const card = ctx.toolOutput as DealCard;
  const approve = async () => {
    setPay({ kind: "paying" });
    try {
      const res = await payDeal.callTool({ deal_id: card.deal_id });
      const r = (res.structuredContent ?? null) as PayResult | null;
      setPay(r ? toPayState(r) : { kind: "error", message: "No payment result came back." });
    } catch (e) {
      setPay({ kind: "error", message: (e as Error).message });
    }
  };

  return <DealCardView card={card} pay={pay} theme={theme} onApprove={approve} />;
}
