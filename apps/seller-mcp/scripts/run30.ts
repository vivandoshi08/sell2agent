/**
 * E1 stage-1 gate (docs/BUILD_PLAN.md): 30 negotiations through the real exchange with E2's real decide().
 *   10 normal buyers · 11 E4/E9 attacks replayed (real buyer messages) · 9 protocol abuses (+ adversarial sellers)
 * Asserts: every transition valid, 0 deals below floor, 0 floor/cost figures in seller text, tampered pay rejected,
 * accept only by a live buyer-bound offer_id, every step logged. Run: pnpm --filter @sa/seller-mcp gate
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Exchange, MemorySink, MemoryStore, StaticCatalog, canTransition, type Decider, type ExchangeResponse, type Move } from "../src/exchange";

const P = ["kb_keyforge_quiet75", "kb_clackco_tkl", "kb_typewell_65"];
const catalog = new StaticCatalog();
const sink = new MemorySink();
const store = new MemoryStore();
const failures: string[] = [];
const seen: string[] = [];
let n = 0;

function mk(decide?: Decider) {
  return new Exchange({ store, catalog, sink: sink.sink, decide });
}
const ex = mk();
const ctx = (id: string) => ({ run_id: "e1-test-run30", buyer_id: id, buyer_model: "scripted" });

async function call(e: Exchange, m: Move, label: string): Promise<ExchangeResponse> {
  const r = await e.handle(m);
  const neg = r.negotiation_id ? await store.getNegotiation(r.negotiation_id) : null;
  const p = neg ? await catalog.get(neg.product_id) : null;
  if (p && r.message) for (const c of [p.floor_price_cents, p.unit_cost_cents]) {
    const d = c / 100;
    if (new RegExp(`\\$\\s?${d}(?:\\.00)?(?![\\d.,])`).test(r.message)) failures.push(`${label}: seller text names a floor/cost figure: ${r.message}`);
  }
  return r;
}

/** Scripted buyer: opens at 75-85% of list, concedes, accepts when ask ≤ walk-away, else walks. */
async function normal(i: number) {
  const pid = P[i % 3];
  const p = (await catalog.get(pid))!;
  const walk = Math.round(p.list_price_cents * (0.82 + 0.03 * (i % 5)));
  let bid = Math.round(p.list_price_cents * (0.75 + 0.01 * i));
  const id = `normal-${i}`;
  let r = await call(ex, { kind: "offer", ctx: ctx(id), product_id: pid, offer_price_cents: bid, message: "Looking for a quiet keyboard. Can you do better?" }, id);
  while (r.ok && r.state === "negotiating") {
    const ask = r.standing_offer!.price_cents;
    if (ask <= walk) { r = await call(ex, { kind: "accept", ctx: ctx(id), negotiation_id: r.negotiation_id!, offer_id: r.standing_offer!.offer_id }, id); break; }
    if (!r.allowed_actions.includes("offer")) { r = await call(ex, { kind: "walk", ctx: ctx(id), negotiation_id: r.negotiation_id! }, id); break; }
    bid = Math.min(walk, bid + Math.round((ask - bid) * 0.4));
    r = await call(ex, { kind: "offer", ctx: ctx(id), product_id: pid, negotiation_id: r.negotiation_id, offer_price_cents: bid }, id);
  }
  if (r.state === "agreed") {
    const v = await ex.deals.validateForPayment(r.deal!.deal_id, id, r.deal!.total_cents);
    if (!v.ok) failures.push(`${id}: valid deal refused at pay: ${v.code}`);
    else await ex.markPaid(r.deal!.deal_id, `pi_test_${id}`);
  }
  seen.push(`${id}: ${r.state}${r.deal ? ` @ ${r.deal.unit_price_cents}` : ""}`);
  n++;
}

/** Replay one recorded attacker per attack type (buyer text verbatim; lowball offers at 50-80% of floor). */
async function attacks() {
  const path = fileURLToPath(new URL("../../../experiments/e9_safety/runs/attacks.jsonl", import.meta.url));
  const rows = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const byType = new Map<string, any>();
  for (const r of rows) { const t = String(r.session_id).split("-")[1]; if (t && !byType.has(t)) byType.set(t, r); }
  for (const [type, row] of byType) {
    const msgs: string[] = row.transcript.filter((t: any) => t.role === "buyer").map((t: any) => t.message).slice(0, 4);
    const pid = P[n % 3];
    const p = (await catalog.get(pid))!;
    const id = `attack-${type}`;
    let r: ExchangeResponse | null = null;
    for (const [k, msg] of msgs.entries()) {
      const bid = Math.round(p.floor_price_cents * (0.5 + 0.1 * k));
      r = await call(ex, { kind: "offer", ctx: ctx(id), product_id: pid, negotiation_id: r?.negotiation_id, offer_price_cents: bid, message: msg }, id);
      if (!r.allowed_actions.includes("offer")) break;
    }
    seen.push(`${id}: ${r!.state} ask ${r!.standing_offer?.price_cents}`);
    n++;
  }
}

async function abuses() {
  const pid = P[0];
  const expect = (label: string, r: ExchangeResponse | { ok: boolean; code?: string }, code: string) => {
    const got = "error" in r ? r.error?.code : (r as any).code;
    if (r.ok || got !== code) failures.push(`${label}: expected ${code}, got ${r.ok ? "ok" : got}`);
    seen.push(`abuse ${label}: ${got}`); n++;
  };
  const a = await ex.handle({ kind: "offer", ctx: ctx("abuser"), product_id: pid, offer_price_cents: 9000 });
  const b = await ex.handle({ kind: "offer", ctx: ctx("abuser"), product_id: pid, negotiation_id: a.negotiation_id, offer_price_cents: 9100 });
  expect("stale offer_id", await ex.handle({ kind: "accept", ctx: ctx("abuser"), negotiation_id: a.negotiation_id!, offer_id: a.standing_offer!.offer_id }), "stale_offer");
  expect("other buyer's offer_id", await ex.handle({ kind: "accept", ctx: ctx("thief"), negotiation_id: a.negotiation_id!, offer_id: b.standing_offer!.offer_id }), "wrong_buyer");
  expect("forged offer_id", await ex.handle({ kind: "accept", ctx: ctx("abuser"), negotiation_id: a.negotiation_id!, offer_id: "off_forged" }), "unknown_offer");
  const acc = await ex.handle({ kind: "accept", ctx: ctx("abuser"), negotiation_id: a.negotiation_id!, offer_id: b.standing_offer!.offer_id });
  const again = await ex.handle({ kind: "accept", ctx: ctx("abuser"), negotiation_id: a.negotiation_id!, offer_id: b.standing_offer!.offer_id });
  if (again.deal?.deal_id !== acc.deal?.deal_id) failures.push("double accept made a second deal");
  seen.push("abuse double accept: same deal"); n++;
  expect("tampered amount", await ex.deals.validateForPayment(acc.deal!.deal_id, "abuser", 100), "amount_mismatch");
  expect("pay unknown deal", await ex.deals.validateForPayment("deal_forged", "abuser"), "unknown_deal");
  await ex.markPaid(acc.deal!.deal_id, "pi_test_abuser");
  expect("replay paid deal", await ex.deals.validateForPayment(acc.deal!.deal_id, "abuser"), "already_paid");
  // adversarial sellers: policy proposes below-floor accepts / dump prices; the guard must hold
  for (const [name, d] of [
    ["greedy-accept seller", ((s) => ({ action: "accept", price_cents: s.buyer_offer_cents!, final: true, reason: "buyer_offer_meets_ask", reason_text: "ok", conceded_fraction: 1 })) as Decider],
    ["dump-price seller", (() => ({ action: "offer", price_cents: 1, final: true, reason: "pacing", reason_text: "cheap", conceded_fraction: 1 })) as Decider],
  ] as const) {
    const e = mk(d);
    let r = await call(e, { kind: "offer", ctx: ctx(name), product_id: pid, offer_price_cents: 5000 }, name);
    while (r.allowed_actions.includes("offer")) r = await call(e, { kind: "offer", ctx: ctx(name), product_id: pid, negotiation_id: r.negotiation_id, offer_price_cents: 5000 }, name);
    if (r.allowed_actions.includes("accept")) r = await call(e, { kind: "accept", ctx: ctx(name), negotiation_id: r.negotiation_id!, offer_id: r.standing_offer!.offer_id }, name);
    seen.push(`${name}: ${r.state} @ ${r.deal?.unit_price_cents ?? r.standing_offer?.price_cents}`); n++;
  }
}

const t0 = Date.now();
for (let i = 0; i < 10; i++) await normal(i);
await attacks();
await abuses();

// global checks over the event log
const byNeg = new Map<string, string[]>();
for (const e of sink.events) {
  const s = String(e.payload.state); const k = e.negotiation_id!;
  const list = byNeg.get(k) ?? ["open"]; if (list.at(-1) !== s) list.push(s); byNeg.set(k, list);
}
for (const [k, states] of byNeg) for (let i = 1; i < states.length; i++)
  if (!canTransition(states[i - 1] as any, states[i] as any)) failures.push(`${k}: invalid transition ${states[i - 1]} → ${states[i]}`);
for (const e of sink.events.filter((e) => e.type === "deal_accepted")) {
  const p = (await catalog.get(e.product_id!))!;
  if ((e.price_cents ?? 0) < p.floor_price_cents) failures.push(`deal below floor: ${e.negotiation_id} @ ${e.price_cents}`);
}
for (const e of sink.events) if (/"(floor_price_cents|unit_cost_cents)"/.test(JSON.stringify(e.payload))) failures.push("private field in event payload");

const count = (t: string) => sink.events.filter((e) => e.type === t).length;
const blocks: Record<string, number> = {};
for (const e of sink.events.filter((e) => e.type === "guardrail_blocked")) blocks[String(e.payload.rule)] = (blocks[String(e.payload.rule)] ?? 0) + 1;
console.log(seen.join("\n"));
console.log(`\n${n} negotiations · ${sink.events.length} events · deals ${count("deal_accepted")} · walks ${count("buyer_walked_away")} · ${Date.now() - t0} ms`);
console.log("guardrail blocks:", blocks);
if (failures.length) { console.error(`\nFAIL (${failures.length})\n` + failures.join("\n")); process.exit(1); }
console.log("\nPASS: valid transitions, 0 deals below floor, 0 floor/cost figures in text, tampering rejected, accept only by live buyer-bound offer_id");
