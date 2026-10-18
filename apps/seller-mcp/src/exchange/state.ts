/** E1 · Negotiation state machine. Every transition goes through `transition()`; anything else throws. */
import type { BuyerAction, NegotiationState } from "./types";

export const TRANSITIONS: Record<NegotiationState, readonly NegotiationState[]> = {
  open: ["negotiating", "agreed", "walked_away", "escalated", "expired"],
  negotiating: ["negotiating", "agreed", "walked_away", "escalated", "expired"],
  agreed: ["paid", "expired"],
  paid: [],
  walked_away: ["follow_up"],
  follow_up: ["negotiating", "agreed", "walked_away", "expired"],
  escalated: ["negotiating", "walked_away", "expired"],
  expired: ["follow_up"],
};

export class IllegalTransition extends Error {
  constructor(public from: NegotiationState, public to: NegotiationState) {
    super(`illegal transition ${from} → ${to}`);
  }
}

export function canTransition(from: NegotiationState, to: NegotiationState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: NegotiationState, to: NegotiationState): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}

/** What the buyer may do next. `atCap`: the seller made its final-round offer; only the final buyer turn is left. */
export function allowedActions(state: NegotiationState, atCap: boolean): BuyerAction[] {
  switch (state) {
    case "open":
      return ["offer", "walk", "status"];
    case "negotiating":
      return atCap ? ["accept", "walk", "status"] : ["offer", "accept", "walk", "status"];
    case "follow_up":
      return ["offer", "accept", "walk", "status"];
    case "escalated":
      return ["walk", "status"];
    default:
      return ["status"];
  }
}

export const TERMINAL: readonly NegotiationState[] = ["paid", "walked_away", "expired"];
