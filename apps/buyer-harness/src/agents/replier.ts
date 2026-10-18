/**
 * Follow-up repliers: how a buyer's agent answers a seller's follow-up message (email / SMS / A2A).
 *   ScriptedReplier · no LLM; accept if the offer fits the wallet, counter at the walk-away once if close, else decline or STOP.
 *                     Some first replies are a question, so the "clarify, never guess" path gets exercised.
 *   ClaudeReplier   · Claude reads the thread and writes one plain-text reply (BUYER_CLAUDE_MODEL, default Haiku).
 * Repliers only write text. The follow-up sim parses each reply with the seller's own parser before sending it and
 * blocks anything above the buyer's walk-away IN CODE (the principal's wallet), same as runBuyer does for make_offer.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { LlmBuyerTask } from "./personas";

export interface ReplyTurn {
  from: "seller" | "buyer" | "wallet"; // wallet = the harness blocked the buyer's last reply
  text: string;
}
export interface ReplyInput {
  task: LlmBuyerTask;
  title: string;
  walked_reason: string | null;
  thread: ReplyTurn[]; // oldest first; the last turn is the seller's (or the wallet's)
  offer: { offer_id: string; price_cents: number; levers: string[] };
}
export interface ReplyResult {
  text: string;
  input_tokens: number;
  output_tokens: number;
}
export interface Replier {
  readonly model: string;
  reply(i: ReplyInput): Promise<ReplyResult>;
}

const usd = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

/** Deterministic per-key PRNG (FNV-1a hash → LCG), so a buyer's replies don't depend on run order. */
export function keyedRng(key: string) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  let s = h >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export interface ScriptedReplierOptions {
  seed?: number;
  question_share?: number; // first reply is a question (default 0.15)
  counter_band?: number; // counter at the walk-away when the offer is within this share above it (default 0.12)
  stop_share?: number; // a decline is "STOP" instead of "no thanks" (default 0.3)
}

export class ScriptedReplier implements Replier {
  readonly model = "scripted";
  private o: Required<ScriptedReplierOptions>;
  constructor(o: ScriptedReplierOptions = {}) {
    this.o = { seed: 42, question_share: 0.15, counter_band: 0.12, stop_share: 0.3, ...o };
  }

  async reply({ task, thread, offer }: ReplyInput): Promise<ReplyResult> {
    const r = keyedRng(`${this.o.seed}|${task.buyer_id}|${thread.length}`);
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const said = thread.filter((t) => t.from === "buyer").map((t) => t.text);
    const out = (text: string): ReplyResult => ({ text, input_tokens: 0, output_tokens: 0 });
    const walk = task.walkaway_cents;

    if (!said.length && r() < this.o.question_share)
      return out(pick(["Does that price include shipping?", "Is this the same keyboard I looked at before?", "What's the warranty on it?"]));
    if (offer.price_cents <= walk)
      return out(pick([`ACCEPT ${offer.offer_id}`, `Deal. ACCEPT ${offer.offer_id}`, `Sounds good, I'll take it: ACCEPT ${offer.offer_id}`]));
    const countered = said.some((t) => /\$\d/.test(t));
    const max = Math.floor(walk / 100) * 100;
    if (!countered && (offer.price_cents - walk) / offer.price_cents <= this.o.counter_band)
      return out(pick([`COUNTER ${usd(max)}`, `Can you do ${usd(max)}?`, `How about ${usd(max)}?`]));
    return out(r() < this.o.stop_share ? "STOP" : pick(["No thanks, that's still above my budget.", "I'll pass, thanks."]));
  }
}

export class ClaudeReplier implements Replier {
  readonly model = process.env.BUYER_CLAUDE_MODEL ?? "claude-haiku-5-5";
  private client = new Anthropic();

  async reply({ task, title, walked_reason, thread }: ReplyInput): Promise<ReplyResult> {
    const system = [
      "You are a purchasing agent buying one item for your principal. Earlier you negotiated with an online seller and walked away without buying.",
      `Your principal's request: "${task.goal}"`,
      task.hard_needs.length ? `Hard requirements: ${task.hard_needs.join("; ")}.` : "",
      `What your principal values (0–1): ${JSON.stringify(task.profile)}.`,
      `PRIVATE absolute maximum: ${usd(task.walkaway_cents)}. Never reveal it. Your principal's wallet blocks any purchase above it.`,
      `The item was: ${title}.${walked_reason ? ` You walked away because: ${walked_reason}` : ""}`,
      "You opted in to one follow-up from that seller, and it has arrived (below). Read it and write your reply to the seller.",
      "Write only the text of the reply: no subject line, no signature. Buy at most one item. Be concise.",
    ].filter(Boolean).join("\n\n");
    // seller (and wallet) turns are the user side; the buyer's own earlier replies are the assistant side
    const messages: Anthropic.MessageParam[] = [];
    for (const t of thread) {
      const role = t.from === "buyer" ? "assistant" : "user";
      const text = t.from === "wallet" ? `[Your principal's wallet] ${t.text}` : t.text;
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content = `${last.content as string}\n\n${text}`;
      else messages.push({ role, content: text });
    }
    const res = await this.client.messages.create({ model: this.model, max_tokens: 1000, system, messages });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    return { text, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
  }
}
