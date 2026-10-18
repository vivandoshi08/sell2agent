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
export { Bandit, ARMS, BASE_ARMS, PACKAGE_ARMS, PACKAGE_EXTRAS, DEFAULT_ARM, contextOf, chooseArm, isArm, armExtra, armsFor, objectiveReward, objectiveFormula } from "./bandit";
export type { Arm, BaseArm, PackageArm, ArmStats, LearnedPolicy, LearnedGate } from "./bandit";
export { voice, checkMessage, templateMessage, dollarsInText } from "./voice";
export type { VoiceContext, VoiceResult } from "./voice";
export { answerQuestion, lookupAnswer } from "./answers";
export type { Answer, PublicProduct } from "./answers";
export { offerSummary, dealSummary, checkSummary, leverLabel, LEVER_LABELS, SUMMARY_MAX } from "./summary";
export type { OfferSummaryInput, DealSummaryInput } from "./summary";
export { defaultLlm, SELLER_VOICE_MODEL } from "./llm";
export type { Llm } from "./llm";
