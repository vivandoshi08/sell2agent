/**
 * E2 · Seller module public API (the "Seller decision" seam).
 *
 * E1's exchange calls, per seller turn:
 *   const move = decide(state, policy);            // code: price + action + true reason
 *   // E1: guardrails check `move` here
 *   const { message } = await voice(move, ctx, llm); // LLM words it; checked; template fallback
 * and for ask_question:
 *   const a = await answerQuestion(publicProduct, question, llm);
 */
export * from "./types";
export { decide, askPrice, concessionFraction, softFloor, TACTICS, DEFAULT_SOFT_FLOOR_BUFFER, usd } from "./decide";
export { decideLever, pickLever, DEFAULT_LEVER_THRESHOLD } from "./levers";
export { Bandit, ARMS, DEFAULT_ARM, contextOf, chooseArm } from "./bandit";
export type { Arm, ArmStats, LearnedPolicy } from "./bandit";
export { voice, checkMessage, templateMessage, dollarsInText } from "./voice";
export type { VoiceContext, VoiceResult } from "./voice";
export { answerQuestion, lookupAnswer } from "./answers";
export type { Answer, PublicProduct } from "./answers";
export { defaultLlm, SELLER_VOICE_MODEL } from "./llm";
export type { Llm } from "./llm";
