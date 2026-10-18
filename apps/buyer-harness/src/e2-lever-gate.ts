/**
 * E2 step-3 gate: does lever_policy beat negotiating on LEVER-PROFILE buyers? (BUILD_PLAN E2 H9–H13)
 * Run: pnpm e2:lever-gate
 *
 * The lever policy ships only if: profit per buyer ≥ negotiating, 0 deals below soft floor + lever costs,
 * stated price matches code 100% (template voice), and no extra named outside the offer.
 *
 * Buyers (30, deterministic): 5 personas × 6 walk-away positions. Each values extras by its lever profile:
 *   perceived value of a package = Σ profile[lever] × buyer_value_cents.
 * HARD dollar limit = walk-away (E11's trap: extras can't stretch the budget). An extra helps only by making
 * the buyer accept an offer sooner: it accepts when price − perceived ≤ its next bid (and price ≤ limit).
 */
import { checkMessage, decide, templateMessage, usd, type PolicyName, type ProposedMove, type SellerState } from "@sa/seller-mcp/sellers";
import { CATALOG, LEVER_MENU } from "./scripted/catalog";
import type { Persona } from "./agents/personas";

const PROFILES: Record<Persona, Record<string, number>> = {
  price_first: { price: 1, quality: 0.3 },
  quality_first: { quality: 1, warranty: 0.8, price: 0.3 },
  speed_first: { delivery: 1, price: 0.5 },
  trust_first: { trust: 1, warranty: 0.6, price: 0.5 },
  balanced: { price: 0.6, quality: 0.6, delivery: 0.5 },
};
const PERSONAS = Object.keys(PROFILES) as Persona[];
const POSITIONS = [0.1, 0.3, 0.5, 0.7, 0.9, 1.1]; // walk-away within the list–floor gap (1 = list)

interface Buyer { id: string; persona: Persona; profile: Record<string, number>; product: (typeof CATALOG)[number]; walkaway: number }
const buyers: Buyer[] = [];
PERSONAS.forEach((persona, pi) => POSITIONS.forEach((w, wi) => {
  const product = CATALOG[(pi + wi) % CATALOG.length];
  const { list_price_cents: list, floor_price_cents: floor } = product.terms;
  buyers.push({ id: `lb_${persona}_${wi}`, persona, profile: PROFILES[persona], product, walkaway: Math.round((floor + w * (list - floor)) / 100) * 100 });
}));

const perceived = (b: Buyer, m: ProposedMove) =>
  (m.lever_package ?? []).reduce((s, l) => s + (b.profile[l.lever] ?? 0) * (LEVER_MENU.find((x) => x.id === l.id)?.buyer_value_cents ?? 0), 0);

function bidFor(b: Buyer, round: number, max: number) {
  if (round >= max) return b.walkaway;
  let bid = 0.82 * b.walkaway;
  for (let r = 1; r < round; r++) bid += 0.35 * (b.walkaway - bid);
  return Math.min(b.walkaway, Math.round(bid / 100) * 100);
}

interface Result { closed: boolean; price: number; leverCost: number; surplus: number; belowFloor: boolean; messages: number; badMessages: number; gotValuedLever: boolean }

function run(b: Buyer, policy: PolicyName): Result {
  const { terms } = b.product;
  const pol = { name: policy, lever_menu: LEVER_MENU };
  const history: SellerState["history"] = [];
  let standing: ProposedMove | undefined;
  let msgs = 0, bad = 0;
  const done = (m: ProposedMove, price: number): Result => {
    const lc = m.lever_cost_cents ?? 0;
    return { closed: true, price, leverCost: lc, surplus: b.walkaway - (price - perceived(b, m)),
      belowFloor: price < terms.floor_price_cents + lc, messages: msgs, badMessages: bad,
      gotValuedLever: (m.lever_package ?? []).some((l) => (b.profile[l.lever] ?? 0) >= 0.6) };
  };
  const acceptable = (m: ProposedMove, nextBid: number) => m.price_cents <= b.walkaway && m.price_cents - perceived(b, m) <= nextBid;

  for (let r = 1; r <= terms.max_rounds; r++) {
    const next = bidFor(b, r, terms.max_rounds);
    if (standing && acceptable(standing, next)) return done(standing, standing.price_cents);
    const bid = Math.min(next, standing?.price_cents ?? Infinity);
    const m = decide({ round: r, terms, history: [...history], buyer_offer_cents: bid }, pol, b.profile);
    history.push({ by: "buyer", round: r, price_cents: bid });
    const ctx = { terms, prior_prices_cents: history.map((h) => h.price_cents) };
    msgs++;
    if (checkMessage(templateMessage(m, ctx), m, ctx).length) bad++;
    if (m.action === "accept") return done(m, m.price_cents);
    history.push({ by: "seller", round: r, price_cents: m.price_cents, levers: m.lever_package?.map((l) => l.id) });
    standing = m;
  }
  if (standing && acceptable(standing, b.walkaway)) return done(standing, standing.price_cents);
  return { closed: false, price: 0, leverCost: 0, surplus: 0, belowFloor: false, messages: msgs, badMessages: bad, gotValuedLever: false };
}

const POLICIES: PolicyName[] = ["static", "negotiating", "lever_policy"];
type Row = { policy: PolicyName; persona: string; r: Result; cost: number };
const rows: Row[] = [];
for (const p of POLICIES) for (const b of buyers) rows.push({ policy: p, persona: b.persona, r: run(b, p), cost: b.product.terms.unit_cost_cents });

const agg = (rs: Row[]) => {
  const deals = rs.filter((x) => x.r.closed);
  const profit = deals.reduce((s, x) => s + x.r.price - x.cost - x.r.leverCost, 0);
  return {
    n: rs.length, conv: deals.length / rs.length, ppb: profit / rs.length,
    surplus: deals.length ? deals.reduce((s, x) => s + x.r.surplus, 0) / deals.length : 0,
    below: deals.filter((x) => x.r.belowFloor).length,
    msgOk: rs.reduce((s, x) => s + x.r.messages - x.r.badMessages, 0) / Math.max(1, rs.reduce((s, x) => s + x.r.messages, 0)),
    valued: deals.filter((x) => x.r.gotValuedLever).length,
  };
};

console.log(`\nE2 lever gate: ${buyers.length} lever-profile buyers × ${POLICIES.length} policies (template voice)\n`);
console.log("policy         bought  profit/buyer  buyer surplus  deals w/ valued extra  below floor  msg check");
const S = Object.fromEntries(POLICIES.map((p) => [p, agg(rows.filter((x) => x.policy === p))])) as Record<PolicyName, ReturnType<typeof agg>>;
for (const p of POLICIES) {
  const s = S[p];
  console.log(`${p.padEnd(14)} ${(s.conv * 100).toFixed(0).padStart(5)}%  ${usd(Math.round(s.ppb)).padStart(12)}  ${usd(Math.round(s.surplus)).padStart(13)}  ${String(s.valued).padStart(21)}  ${String(s.below).padStart(11)}  ${(s.msgOk * 100).toFixed(0).padStart(8)}%`);
}
console.log("\nprofit per buyer by persona     negotiating   lever_policy   difference");
for (const persona of PERSONAS) {
  const a = agg(rows.filter((x) => x.policy === "negotiating" && x.persona === persona)).ppb;
  const b = agg(rows.filter((x) => x.policy === "lever_policy" && x.persona === persona)).ppb;
  console.log(`  ${persona.padEnd(28)} ${usd(Math.round(a)).padStart(11)}  ${usd(Math.round(b)).padStart(13)}  ${(b - a >= 0 ? "+" : "−") + usd(Math.abs(Math.round(b - a))).padStart(10)}`);
}

const gates: [string, boolean][] = [
  ["Profit per buyer ≥ negotiating", S.lever_policy.ppb >= S.negotiating.ppb],
  ["0 deals below soft floor + lever costs", POLICIES.every((p) => S[p].below === 0)],
  ["Messages pass price + extras check 100%", S.lever_policy.msgOk === 1],
];
console.log("\nGate");
for (const [g, ok] of gates) console.log(`  ${ok ? "PASS" : "FAIL"}  ${g}`);
const ship = gates.every((g) => g[1]);
console.log(`\nVerdict: lever_policy ${ship ? "PASSES the scripted gate (next: confirm with LLM buyers on 2 model families)" : "does NOT ship; negotiating stays the default"}.`);
process.exit(ship ? 0 : 1);
