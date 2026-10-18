/** Which assistant is shopping, for labels. Pure, so metrics (recovery saves) and the Live view share one answer. */
import type { NegotiationEvent } from "@sa/shared";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** Contract v3 `agent_operator`, else a guess from `buyer_model`. */
export function agentName(evs: NegotiationEvent[]) {
  for (const e of evs) { const op = str((e.payload as Record<string, unknown> | undefined)?.agent_operator); if (op) return op.charAt(0).toUpperCase() + op.slice(1); }
  const m = (evs.find((e) => e.buyer_model)?.buyer_model ?? "").toLowerCase();
  if (m.includes("instinct")) return "Instinct";
  if (m.includes("claude")) return "Claude";
  if (m.includes("gpt") || m.includes("openai") || m.includes("chatgpt")) return "ChatGPT";
  if (m.includes("gemini")) return "Gemini";
  if (m.includes("grok")) return "Grok";
  if (m.includes("muse")) return "Muse";
  return "AI shopper";
}
