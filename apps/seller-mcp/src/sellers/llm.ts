/**
 * Tiny LLM hook so voice/answers can run with Claude in production and with no model in tests.
 * An `Llm` takes a system prompt + user prompt and returns plain text.
 */
import Anthropic from "@anthropic-ai/sdk";

export type Llm = (system: string, user: string) => Promise<string>;

/** Default seller voice model. Fast matters: time-to-first-offer is a KPI (FINAL_ARCHITECTURE §2). */
export const SELLER_VOICE_MODEL = process.env.SELLER_VOICE_MODEL ?? "claude-sonnet-5-5";

/** Claude if ANTHROPIC_API_KEY is set, else null (callers fall back to templates). */
export function defaultLlm(): Llm | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  return async (system, user) => {
    const res = await client.messages.create({
      model: SELLER_VOICE_MODEL,
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: user }],
    });
    return res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  };
}
