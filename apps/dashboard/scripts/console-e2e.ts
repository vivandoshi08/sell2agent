/**
 * S2 · Bridge 3 done-test on production: "the merchant console edits a lever menu and the next negotiation uses it".
 *
 *   pnpm --filter @sa/dashboard console:e2e [mcp_url] [--product kb_clackco_tkl] [--lever extended_warranty]
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the console's store) and EXCHANGE_HMAC_SECRET (signed eval run_id,
 * so the dashboard never counts it as a shopper), and the live DB on contract v2 (0002_contract_v2.sql).
 *
 *  1. before: a scripted buyer asks the deployed gateway for the lever → refused (not on this product's menu)
 *  2. edit:   PUT /api/console/policies/:id through the console's own API (in-process server, same store as /console):
 *             switch the lever on and raise the objective's margin weight → seller_policies.lever_menu + objective
 *  3. after:  wait out the gateway's catalog cache (5 s), ask again → the standing offer carries the lever, priced at
 *             or above floor + the lever's cost
 *  4. revert: restore the row's exact columns from before, wait out the cache, ask again → refused again
 * The revert runs even when a step fails. Exit 0 only when all four steps pass.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { signEvalRun } from "@sa/seller-mcp/exchange";
import { consoleApi } from "../src/console/api";
import type { ConsolePolicy } from "../src/console/policy";
import { supabaseStore } from "../src/console/store";

const arg = (name: string, dflt: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt; };
const MCP = process.argv.slice(2).find((a) => a.startsWith("http")) ?? "https://dark-zero-mesv5.run.mcp-use.com/mcp";
const PID = arg("product", "kb_clackco_tkl");
const LEVER = arg("lever", "extended_warranty");
const CACHE_MS = Number(process.env.EXCHANGE_CATALOG_TTL_MS) || 5000;
const tag = Date.now().toString(36);
const RUN = signEvalRun(`s2-console-e2e-${tag}`);
const COLS = "floor_price_cents, policy, objective, lever_menu, allowed_concessions";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (the console writes seller_policies)");
if (!process.env.EXCHANGE_HMAC_SECRET) throw new Error("EXCHANGE_HMAC_SECRET is required: without it the eval run_id isn't signed like production's");
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const results: { step: string; ok: boolean; detail: string }[] = [];
const record = (step: string, ok: boolean, detail: string) => { results.push({ step, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${step}: ${detail}`); return ok; };

// ---------- MCP over streamable HTTP (stateless; same as apps/marketplace/scripts/verify-prod.mjs) ----------
let rpcId = 0;
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }) });
  const text = await res.text();
  const body = text.trim().startsWith("{") ? text : (text.split("\n").filter((l) => l.startsWith("data:")).pop() ?? "").slice(5);
  const msg = JSON.parse(body);
  if (msg.error) throw new Error(`${name}: ${JSON.stringify(msg.error)}`);
  const out = msg.result?.content?.[0]?.text ?? "";
  return msg.result?.structuredContent ?? { ok: false, text: out, error: { code: /Error (\w+)/.exec(out)?.[1], message: out } };
}

/** One scripted buyer opens a negotiation on PID asking for LEVER. Fresh buyer_id each time: no start limits or memory. */
async function ask(label: string) {
  const buyer_id = `s2c_${tag}_${label}`;
  const r = await call("make_offer", { product_id: PID, offer_price_cents: 9000, levers: [LEVER], buyer_id, run_id: RUN, buyer_model: "console-e2e" });
  const levers: string[] = r.standing_offer?.levers ?? [];
  return { r, buyer_id, offered: !!r.ok && levers.includes(LEVER), price: r.standing_offer?.price_cents as number | undefined };
}

async function row() {
  const { data, error } = await db.from("seller_policies").select(COLS).eq("product_id", PID).single();
  if (error) throw new Error(`seller_policies: ${error.message}`);
  return data as Record<string, any>;
}

async function main() {
  console.log(`gateway ${MCP}\nproduct ${PID}  lever ${LEVER}  run_id ${RUN.replace(/\..*/, ".<sig>")}`);
  const store = supabaseStore(db);
  if ((await store.schema()) !== "v2") throw new Error("live seller_policies has no lever_menu: apply supabase/migrations/0002_contract_v2.sql first");
  const offers = await db.from("offers").select("id").limit(1);
  console.log(`contract v2: seller_policies.lever_menu ok, offers table ${offers.error ? `MISSING (${offers.error.message})` : "ok"}`);

  // The console's HTTP API on a throwaway port, over the same Supabase store /console uses.
  const handler = consoleApi(store);
  const server: Server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/console`;

  const original = await row();
  let edited = false;
  try {
    const list = (await (await fetch(`${api}/policies`)).json()) as { policies: ConsolePolicy[] };
    const p = list.policies.find((x) => x.product_id === PID);
    if (!p) throw new Error(`${PID} isn't in the console`);
    const lever = p.levers.find((l) => l.id === LEVER);
    if (!lever) throw new Error(`${LEVER} isn't a console lever`);
    if (lever.enabled) throw new Error(`${LEVER} is already on for ${PID}; pick a product where it's off (--product)`);
    console.log(`console: ${p.title}, floor ${usd(p.floor_price_cents)}, levers on: ${p.levers.filter((l) => l.enabled).map((l) => l.id).join(", ") || "none"}, objective.margin ${p.objective.margin}`);

    // 1. before
    const before = await ask("before");
    record("before", !before.offered && before.r.error?.code === "bad_lever", before.offered ? `seller offered ${LEVER} before the edit` : `refused: ${before.r.error?.message ?? before.r.message}`);

    // 2. edit through the console API
    const margin = p.objective.margin >= 0.8 ? 0.6 : 0.8;
    const edit: ConsolePolicy = { ...p, objective: { ...p.objective, margin }, levers: p.levers.map((l) => (l.id === LEVER ? { ...l, enabled: true } : l)) };
    edited = true;
    const put = await fetch(`${api}/policies/${encodeURIComponent(PID)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(edit) });
    const saved = (await put.json()) as { ok: boolean; problems?: unknown };
    const after_row = await row();
    const menu = (after_row.lever_menu ?? []) as { id: string; cost_cents: number; label: string }[];
    const item = menu.find((m) => m.id === LEVER);
    record("edit", put.status === 200 && saved.ok && !!item && after_row.objective?.margin === margin,
      `PUT ${put.status}; lever_menu = [${menu.map((m) => `${m.id} ${usd(m.cost_cents)}`).join(", ")}]; objective.margin ${original.objective?.margin ?? "unset"} → ${after_row.objective?.margin}${saved.ok ? "" : `; problems ${JSON.stringify(saved.problems)}`}`);

    // 3. after the cache: the next negotiation carries the lever, never under floor + lever cost
    await sleep(CACHE_MS + 1500);
    let after = await ask("after");
    for (let i = 1; !after.offered && i <= 3; i++) { await sleep(2000); after = await ask(`after${i}`); } // a second gateway instance may still be warm
    const min = (after_row.floor_price_cents as number) + (item?.cost_cents ?? 0);
    record("after", after.offered && (after.price ?? 0) >= min,
      after.offered ? `standing offer ${after.r.standing_offer.offer_id}: ${usd(after.price!)} incl. ${after.r.standing_offer.levers.join(", ")} (floor + lever cost ${usd(min)} stays private)`
        : `not offered: ${after.r.error?.message ?? after.r.message}`);
  } finally {
    // 4. revert: the row's exact columns from before the edit (not a console save, which would rewrite defaults)
    if (edited) {
      const { error } = await db.from("seller_policies").update(original).eq("product_id", PID);
      if (error) record("revert", false, `seller_policies update failed: ${error.message}. Restore by hand: ${JSON.stringify(original)}`);
      else {
        await sleep(CACHE_MS + 1500);
        let back = await ask("reverted");
        for (let i = 1; back.offered && i <= 3; i++) { await sleep(2000); back = await ask(`reverted${i}`); }
        const now = await row();
        const same = JSON.stringify(now) === JSON.stringify(original);
        record("revert", same && !back.offered, `${same ? "row restored" : `row differs: ${JSON.stringify(now)}`}; gateway ${back.offered ? `still offers ${LEVER}` : "refuses the lever again"}`);
      }
    }
    server.close();
  }
}

main()
  .catch((e) => record("run", false, (e as Error).message))
  .finally(() => {
    const ok = results.length >= 4 && results.every((r) => r.ok);
    console.log(ok ? `OK  console edit reached the deployed gateway on the next negotiation, then reverted (run ${RUN.replace(/\..*/, "")})` : "FAILED");
    process.exit(ok ? 0 : 1);
  });
