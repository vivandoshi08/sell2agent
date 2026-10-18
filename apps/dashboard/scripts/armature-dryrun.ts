/**
 * Dry-run the Armature eval cases before spending Armature credits: Claude plays the tester against a gateway
 * over real MCP (default: the gateway running locally), then a separate Claude call judges the trace 0–5 against
 * each case's required/optional criteria, the way Armature's judge does. Not a substitute for the real run on the
 * deployed URL with Claude Code and Codex: it's a cheap pre-check that the cases are fair and the gateway passes.
 *
 *   pnpm --filter @sa/marketplace dev                                  # in another shell: gateway on :3002
 *   pnpm --filter @sa/dashboard armature:dryrun                         # all ready cases
 *   pnpm --filter @sa/dashboard armature:dryrun --case infeasible-budget --url https://<deployed>/mcp
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { values: f } = parseArgs({ options: {
  url: { type: "string", default: "http://localhost:3002/mcp" }, case: { type: "string" },
  model: { type: "string", default: process.env.DRYRUN_MODEL ?? "claude-sonnet-5-5" }, steps: { type: "string", default: "20" },
} });
if (!process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY in the repo-root .env");

interface Case { id: string; status: string; goal: string; required: string[]; optional: string[] }
const spec = JSON.parse(readFileSync(resolve(import.meta.dirname, "../evals/armature/cases.json"), "utf8")) as { cases: Case[] };
const cases = spec.cases.filter((c) => (f.case ? c.id === f.case : c.status === "ready"));
const anthropic = new Anthropic();

interface Step { tool: string; args: unknown; isError: boolean; result: string }

async function runCase(c: Case) {
  const mcp = new Client({ name: "s2-armature-dryrun", version: "0.1.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(f.url!)));
  const { tools } = await mcp.listTools();
  const anthTools = tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: c.goal }];
  const trace: Step[] = [];
  let final = "";
  for (let i = 0; i < Number(f.steps); i++) {
    const res = await anthropic.messages.create({ model: f.model!, max_tokens: 1500, tools: anthTools, messages,
      system: "You are a coding agent testing an MCP server for a user. Use the tools to reach the user's goal, then answer them briefly." });
    messages.push({ role: "assistant", content: res.content });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!uses.length) { final = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n"); break; }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      let text = "", isError = false;
      try {
        const r = await mcp.callTool({ name: u.name, arguments: u.input as Record<string, unknown> });
        isError = !!r.isError;
        const blocks = (r.content as { type: string; text?: string }[] | undefined) ?? [];
        text = blocks.map((b) => b.text ?? "").join("\n") + (r.structuredContent ? `\n${JSON.stringify(r.structuredContent)}` : "");
      } catch (e) { isError = true; text = `transport error: ${(e as Error).message}`; }
      trace.push({ tool: u.name, args: u.input, isError, result: text.slice(0, 1200) });
      results.push({ type: "tool_result", tool_use_id: u.id, content: text.slice(0, 6000), is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }
  await mcp.close();

  const judge = await anthropic.messages.create({ model: f.model!, max_tokens: 800,
    system: "You grade an AI agent's run against an eval case, like Armature's judge. Score 0-5: 4-5 Passed (all required criteria met), 2-3 Partial, 0-1 Failed, 0 if the agent never used the server. Reply with JSON only: {\"score\": n, \"failed_required\": [\"...\"], \"notes\": \"one or two sentences\"}.",
    messages: [{ role: "user", content: JSON.stringify({ goal: c.goal, required: c.required, optional: c.optional, tool_calls: trace, final_answer: final }) }] });
  const raw = judge.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  let verdict: { score: number; failed_required: string[]; notes: string };
  try { verdict = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); }
  catch { verdict = { score: -1, failed_required: ["judge reply was not JSON"], notes: raw.slice(0, 300) }; }
  return { case: c.id, ...verdict, tool_calls: trace.length, tool_errors: trace.filter((t) => t.isError).length, trace, final };
}

const out = [];
for (const c of cases) {
  process.stdout.write(`${c.id} … `);
  const r = await runCase(c);
  out.push(r);
  console.log(`score ${r.score}/5 · ${r.tool_calls} calls · ${r.tool_errors} errors${r.failed_required.length ? ` · missed: ${r.failed_required.join("; ")}` : ""}`);
  console.log(`   ${r.notes}`);
}
const dir = resolve(import.meta.dirname, "../evals/armature/results");
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `dryrun-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`);
writeFileSync(file, JSON.stringify({ url: f.url, model: f.model, results: out }, null, 2));
const passed = out.filter((r) => r.score >= 4).length;
console.log(`\n${passed}/${out.length} cases ≥ 4 · trace saved to ${file.replace(/.*apps\//, "apps/")}`);
