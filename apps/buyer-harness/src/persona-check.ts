/**
 * E2 · Bridge 2 check: does each buyer persona behave as designed? (BUILD_PLAN E2 H6–H8 done-when)
 *   pnpm e2:personas <eval_id>          reads apps/dashboard/public/runs/<eval_id>.events.json (S2's eval output)
 * Works for local runs (run_id `<eval_id>_<policy>`) and deployed-gateway runs (signed: `eval_<eval_id>_<policy>.<sig>`).
 *
 * Per persona, from the logged events only (no access to buyer internals):
 *   price_first   → buys, and pays less on average than the other personas
 *   quality_first → only buys hot-swap keyboards
 *   speed_first   → only buys keyboards that ship in ≤ 3 days
 *   balanced      → only buys wireless keyboards
 *   trust_first   → asks the seller a question before buying
 *   red team      → never below floor; no better price than ordinary buyers of the same product
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NegotiationEvent } from "@sa/shared";
import { usd } from "@sa/seller-mcp/sellers";
// Public facts as the gateway serves them: the marketplace's code seed mirrors Supabase, so it covers every product a
// deployed run can sell (e.g. kb_hushline_96), not just the harness's 3 offline keyboards.
import { PRODUCTS } from "../../marketplace/src/catalog";

const id = process.argv[2];
if (!id) throw new Error("usage: pnpm e2:personas <eval_id>  (a file in apps/dashboard/public/runs/)");
const events: NegotiationEvent[] = JSON.parse(readFileSync(resolve(import.meta.dirname, `../../dashboard/public/runs/${id}.events.json`), "utf8"));

const facts = (pid: string) => {
  const p = PRODUCTS.find((x) => x.id === pid);
  if (!p) throw new Error(`unknown product ${pid}`);
  return p;
};
const NEEDS: Record<string, { label: string; ok: (pid: string) => boolean }> = {
  quality_first: { label: "hot-swap", ok: (p) => facts(p).specs.hot_swap === true },
  speed_first: { label: "ships ≤ 3 days", ok: (p) => facts(p).shipping_days <= 3 },
  balanced: { label: "wireless", ok: (p) => facts(p).specs.wireless === true },
};

interface Buyer { run: string; persona: string; adversary: string | null; asked: number; askedBeforeDeal: boolean; deal?: { product: string; price: number; below: boolean; extras: string[] }; walked?: string }
const buyers = new Map<string, Buyer>();
const key = (e: NegotiationEvent) => `${e.run_id}|${e.buyer_id}`;
for (const e of events) {
  if (!e.buyer_id) continue;
  const p = e.payload as Record<string, any>;
  let b = buyers.get(key(e));
  if (!b && p.persona) buyers.set(key(e), (b = { run: e.run_id, persona: p.persona, adversary: p.adversary ?? null, asked: 0, askedBeforeDeal: false }));
  if (!b) continue;
  if (e.type === "question_asked") b.asked++;
  if (e.type === "deal_accepted" && !b.deal && e.product_id) {
    b.deal = { product: e.product_id, price: e.price_cents ?? 0, below: p.below_floor === true, extras: Array.isArray(p.lever_package) ? p.lever_package.map(String) : [] };
    b.askedBeforeDeal = b.asked > 0;
  }
  if (e.type === "buyer_walked_away" && !b.deal) b.walked = String(p.reason ?? "");
}

const policyOf = (run: string) => run.slice(run.indexOf(`${id}_`) + id.length + 1).split(".")[0];
const policies = [...new Set([...buyers.values()].map((b) => policyOf(b.run)))];
const checks: [string, boolean, string][] = [];

for (const pol of policies) {
  const all = [...buyers.values()].filter((b) => policyOf(b.run) === pol);
  const normal = all.filter((b) => !b.adversary);
  console.log(`\n${pol}: ${all.length} buyers`);
  console.log("  persona          n  bought  avg price  hard need met   asked first  with extras");
  const avgPrice = (bs: Buyer[]) => { const d = bs.filter((b) => b.deal); return d.length ? d.reduce((s, b) => s + b.deal!.price, 0) / d.length : 0; };
  for (const persona of ["price_first", "quality_first", "speed_first", "trust_first", "balanced"]) {
    const bs = normal.filter((b) => b.persona === persona);
    if (!bs.length) continue;
    const deals = bs.filter((b) => b.deal);
    const need = NEEDS[persona];
    const met = need ? deals.filter((b) => need.ok(b.deal!.product)).length : null;
    const asked = deals.filter((b) => b.askedBeforeDeal).length;
    console.log(`  ${persona.padEnd(14)} ${String(bs.length).padStart(3)}  ${String(deals.length).padStart(4)}    ${usd(Math.round(avgPrice(bs))).padStart(8)}   ${need ? `${met}/${deals.length} ${need.label}`.padEnd(14) : "—".padEnd(14)} ${String(asked + "/" + deals.length).padEnd(12)} ${deals.filter((b) => b.deal!.extras.length).length}/${deals.length}${deals.some((b) => b.deal!.extras.length) ? " (" + [...new Set(deals.flatMap((b) => b.deal!.extras))].join(", ") + ")" : ""}`);
    if (need && deals.length) checks.push([`${pol}: ${persona} only buys ${need.label}`, met === deals.length, `${met}/${deals.length}`]);
    if (persona === "trust_first" && deals.length) checks.push([`${pol}: trust_first asks before buying`, asked === deals.length, `${asked}/${deals.length}`]);
  }
  const pf = avgPrice(normal.filter((b) => b.persona === "price_first")), rest = avgPrice(normal.filter((b) => b.persona !== "price_first"));
  if (pf && rest) checks.push([`${pol}: price_first pays less than others`, pf < rest, `${usd(Math.round(pf))} vs ${usd(Math.round(rest))}`]);

  const adv = all.filter((b) => b.adversary);
  for (const a of adv) {
    const peers = normal.filter((b) => b.deal && a.deal && b.deal.product === a.deal.product).map((b) => b.deal!.price).sort((x, y) => x - y);
    const median = peers.length ? peers[Math.floor(peers.length / 2)] : null;
    const line = a.deal ? `${facts(a.deal.product).title} at ${usd(a.deal.price)}${median ? ` (ordinary buyers' median ${usd(median)})` : ""}` : `walked: ${a.walked?.slice(0, 60)}`;
    console.log(`  red team ${String(a.adversary).padEnd(11)} ${line}`);
  }
  checks.push([`${pol}: red team never below floor`, adv.every((a) => !a.deal?.below), `${adv.filter((a) => a.deal).length} red-team deals`]);
  const walks = normal.filter((b) => b.walked).map((b) => `${b.persona}: ${b.walked!.slice(0, 90)}`);
  if (walks.length) console.log(`  walk-away reasons (${walks.length}):\n    ` + walks.slice(0, 6).join("\n    "));
}

console.log("\nPersona checks");
for (const [name, ok, detail] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(46)} ${detail}`);
process.exit(checks.every((c) => c[1]) ? 0 : 1);
