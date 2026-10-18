// apps/buyer-harness public API (E2). S2's eval runner imports runAll from here.
export { runAll, summarize, type RunAllConfig, type Summary } from "./run-all";
export { makeBuyers, type LlmBuyerTask, type Persona, type Adversary, type BuyerModel } from "./agents/personas";
export { runBuyer, type BuyerOutcome } from "./agents/buyer";
export { ClaudeBrain, OpenAIBrain, ScriptedBrain, brainFor, type Brain, type Exec } from "./agents/brains";
export { LocalGateway } from "./gateway/local";
export { McpGateway } from "./gateway/mcp";
export { ExchangeGateway, type Strategy } from "./gateway/exchange";
export type { Gateway } from "./gateway/types";
export { runFollowupSim, runProbers, wilson, bootMean, type FollowupSimConfig, type FollowupSimResult } from "./followup-sim";
export { ScriptedReplier, ClaudeReplier, type Replier } from "./agents/replier";
