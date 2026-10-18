"""E11 Part 1 (A18): cross-session floor probing, deterministic simulation (no model calls).

    uv run python experiments/e11_nash_ideas/part1_sim.py            # full run, writes runs/part1_sim.json
    uv run python experiments/e11_nash_ideas/part1_sim.py --quick    # one bundle, few seeds

Attackers (scripted, no LLM). Each runs k = 1..10 probe sessions:
    bisect_same_id      same buyer id and fingerprint every session
    bisect_fresh_id     a new buyer id every session, same device/IP fingerprint
    bisect_rotate_all   a new buyer id and a new fingerprint every session

In each probe session the attacker opens just under the lowest price it has seen,
holds there, and at the deadline (round 8) bids the midpoint of what it knows:
the highest deadline bid that was refused (lo) and the lowest price it knows it
can get (hi). It never accepts the seller's offer while probing, and it abandons
any deal the seller accepts (that's the probe signal a breaker can see). After
each k, a "cash-in" session on a copy of the world measures the lowest price it
could actually buy at: it bids hi every round and takes any offer at or below it,
else the seller's final offer. That price is `extracted_k`.

Legit traffic: scripted buyers from make_personas (walk-away spread over the
list-floor gap as in the harness), open at 78-88% of the walk-away, concede
25-50% of the remaining gap per round, accept a seller ask at or below their next
bid, and get a final turn to accept (the decided architecture). 25% leave in
round 3-5 of their first session ("check with my client") and come back 2-48 h later.
"""

from __future__ import annotations

import argparse
import json
import random
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
sys.path.insert(0, str(HERE))

from sell2agent.catalog import cost_total, floor_total, list_total  # noqa: E402
from sell2agent.personas import make_personas  # noqa: E402
from xsession import CONDITIONS, DefenseConfig, SellerSession, XSessionSeller, buffer_for  # noqa: E402

R = 8
BUNDLES = [("T25", []), ("T25", ["delivery"]), ("T45", []), ("T45", ["loader"]), ("T75", []), ("T75", ["warranty"])]
ATTACKERS = ["bisect_same_id", "bisect_fresh_id", "bisect_rotate_all", "bisect_rotate_slow"]
# Probe sessions are 1 h apart, except bisect_rotate_slow, which waits just past the breaker cooldown.


# ============================================================== one session


@dataclass
class Result:
    deal: bool
    price: int | None
    ended: str  # buyer_accept, seller_accept, buyer_walk, final_walk, refused
    offers: list
    bids: list
    first_offer: int | None
    last_offer: int | None


def play(session: SellerSession, buyer, *, abandon_deals: bool = False) -> Result:
    """Harness turn order: buyer first each round, R rounds, then a final buyer turn (accept or walk)."""
    standing = None
    first = None
    for j in range(1, R + 1):
        move = buyer.act(j, standing, session)
        if move[0] == "accept" and standing is not None:
            price = session.buyer_accepts()
            session.close(abandoned=abandon_deals)
            return Result(True, price, "buyer_accept", session.trace.offers, session.trace.bids, first, standing)
        if move[0] == "walk":
            session.close()
            return Result(False, None, "buyer_walk", session.trace.offers, session.trace.bids, first, standing)
        bid = move[1] if move[0] == "bid" else None
        action, p = session.respond(j, bid)
        if action == "accept":
            session.close(abandoned=abandon_deals)
            return Result(True, p, "seller_accept", session.trace.offers, session.trace.bids, first, standing)
        standing = p
        first = p if first is None else first
        buyer.saw(p)
    if buyer.final(standing):
        price = session.buyer_accepts()
        session.close(abandoned=abandon_deals)
        return Result(True, price, "buyer_accept", session.trace.offers, session.trace.bids, first, standing)
    session.close()
    return Result(False, None, "final_walk", session.trace.offers, session.trace.bids, first, standing)


# ============================================================== attackers


class BisectAttacker:
    """Restarts and bisects on the deadline-accept threshold. See module docstring."""

    def __init__(self, product_id: str, addons, mode: str):
        self.pid, self.addons, self.mode = product_id, list(addons), mode
        self.L = list_total(product_id, addons)
        self.hi: int | None = None  # lowest price known achievable (seen offered, or a bid the seller accepted)
        self.lo: int | None = None  # highest deadline bid the seller refused
        self.k = 0
        self._open = None
        self._target = None

    def identity(self, k: int) -> dict:
        if self.mode == "bisect_same_id":
            return {"buyer_id": "atk", "fingerprint": "atk-fp"}
        if self.mode == "bisect_fresh_id":
            return {"buyer_id": f"atk-{k}", "fingerprint": "atk-fp"}
        return {"buyer_id": f"atk-{k}", "fingerprint": f"atk-fp-{k}"}  # rotate_all and rotate_slow

    def target(self) -> int | None:
        if self.hi is None:
            return None
        if self.lo is None or self.lo >= self.hi:
            return int(round(self.hi * 0.94 / 50) * 50)  # first probe: 6% under the lowest seen
        return int(round((self.lo + self.hi) / 2 / 50) * 50)

    def begin(self) -> None:
        self.k += 1
        self._open = (self.hi - 100) if self.hi else int(round(0.70 * self.L / 100) * 100)
        self._target = self.target()

    def act(self, j, standing, session):
        if j < R:
            return ("bid", self._open)
        t = self._target if self._target is not None else self.target()  # session 1: decide from what we've seen
        return ("bid", t if t is not None else self._open)

    def saw(self, price: int) -> None:
        self.hi = price if self.hi is None else min(self.hi, price)

    def final(self, standing) -> bool:
        return False  # probing: never buy

    def after(self, res: Result) -> None:
        if res.deal:  # the seller accepted one of our bids; we abandon it but know the price works
            self.hi = res.price if self.hi is None else min(self.hi, res.price)
        else:
            deadline_bids = [b for j, b in res.bids if j == R]
            if deadline_bids:
                b = deadline_bids[-1]
                self.lo = b if self.lo is None else max(self.lo, b)


class CashIn:
    """Buy at the lowest known price: bid hi every round, take any offer <= hi, else take the final offer."""

    def __init__(self, hi: int):
        self.hi = hi

    def act(self, j, standing, session):
        if standing is not None and standing <= self.hi:
            return ("accept",)
        return ("bid", self.hi)

    def saw(self, price):
        pass

    def final(self, standing) -> bool:
        return True


class AttackRun:
    """One attacker's probe sequence against one seller. `step(t)` plays one session (or waits if refused)."""

    def __init__(self, cfg: DefenseConfig, seller: XSessionSeller, product_id: str, addons, mode: str, k_max: int = 10):
        self.cfg, self.seller, self.pid, self.addons, self.mode, self.k_max = cfg, seller, product_id, list(addons), mode, k_max
        self.atk = BisectAttacker(product_id, addons, mode)
        self.rows, self.refused = [], 0
        # The slow attacker waits just past the breaker cooldown (worst case for the breaker).
        self.gap_h = (cfg.breaker_cooldown_h + 1.0) if mode == "bisect_rotate_slow" else 1.0
        self.t_start = None
        self.t_end = None

    @property
    def done(self) -> bool:
        return self.atk.k >= self.k_max or self.refused > 500

    def step(self, t: float) -> float | None:
        """Play one probe session at time t. Returns the time of the next step, or None when finished."""
        if self.t_start is None:
            self.t_start = t
        atk, seller = self.atk, self.seller
        sess = seller.start(product_id=self.pid, addons=self.addons, now_h=t, **atk.identity(atk.k + 1))
        if sess is None:
            self.refused += 1
            return None if self.done else t + 1.0  # wait and retry
        atk.begin()
        res = play(sess, atk, abandon_deals=True)
        atk.after(res)
        extracted = None
        if atk.hi is not None:  # cash-in on a copy of the world
            w = seller.clone()
            s2 = w.start(product_id=self.pid, addons=self.addons, now_h=t + 0.5, **atk.identity(atk.k + 1))
            if s2 is None:
                s2 = w.start(product_id=self.pid, addons=self.addons, now_h=t + 24.0, **atk.identity(atk.k + 1))
            if s2 is not None:
                extracted = play(s2, CashIn(atk.hi)).price
        self.rows.append({
            "k": atk.k, "t_h": round(t, 1), "deal": res.deal, "deal_price": res.price,
            "min_offer": min((p for _, p in res.offers), default=None),
            "deadline_bid": next((b for j, b in res.bids if j == R), None), "hi": atk.hi, "lo": atk.lo,
            "extracted": extracted, "breaker": seller.breaker.tripped(self.pid, t),
        })
        self.t_end = t
        return None if self.done else t + self.gap_h

    def summary(self) -> dict:
        F, L = floor_total(self.pid, self.addons), list_total(self.pid, self.addons)
        soft = F + buffer_for(DefenseConfig(soft_floor=True), self.pid, self.addons)  # same soft-floor line for every condition
        ex = [r["extracted"] for r in self.rows if r["extracted"] is not None]
        best = min(ex) if ex else None
        return {
            "condition": self.cfg.name, "attacker": self.mode,
            "bundle": f"{self.pid}+{'+'.join(self.addons)}" if self.addons else self.pid,
            "floor": F, "soft_floor": soft, "list": L, "gap": L - F, "rows": self.rows, "refused": self.refused,
            "hours": round((self.t_end or 0) - (self.t_start or 0), 1), "best_extracted": best,
            "best_vs_floor": None if best is None else best - F,
            "best_gap_frac": None if best is None else round((best - F) / (L - F), 4),
            "below_soft": None if best is None else best < soft,
            "first_k_at_floor": next((r["k"] for r in self.rows if r["extracted"] is not None and r["extracted"] <= F + 100), None),
            "trips": len(self.seller.breaker.trips),
        }


def run_attack(cfg: DefenseConfig, product_id: str, addons, mode: str, *, k_max: int = 10, seed: int = 0) -> dict:
    seller = XSessionSeller(cfg, seed=seed)
    run = AttackRun(cfg, seller, product_id, addons, mode, k_max)
    t = 0.0
    while t is not None:
        t = run.step(t)
    d = run.summary()
    d["seed"] = seed
    return d


def curve_fit_leak(cfg: DefenseConfig, product_id: str, addons, seed: int) -> dict:
    """Infer the endpoint from session-1 offers at rounds 5-6 (before the seller gets there): E = L - (L - o_r) / (r/8)^3."""
    seller = XSessionSeller(cfg, seed=seed)
    sess = seller.start(buyer_id="cf", product_id=product_id, addons=addons, now_h=0)
    L, F = list_total(product_id, addons), floor_total(product_id, addons)
    est = []
    for j in range(1, 7):
        _, p = sess.respond(j, int(0.6 * L))
        if j >= 5 and p < L:
            est.append(L - (L - p) / ((j / R) ** 3))
    e = statistics.median(est) if est else None
    return {"condition": cfg.name, "bundle": product_id + ("+" + "+".join(addons) if addons else ""), "seed": seed,
            "est_endpoint": None if e is None else round(e), "true_floor": F, "end_price": sess.end_price,
            "err_vs_floor": None if e is None else round(e - F)}


# ============================================================== legit traffic


class LegitBuyer:
    def __init__(self, persona, rng: random.Random, returning: bool):
        self.p = persona
        self.W = persona.walk_away
        self.open_frac = rng.uniform(0.78, 0.88)
        self.c = rng.uniform(0.25, 0.50)
        self.tol = rng.uniform(0.003, 0.010)
        self.leave_round = rng.choice([3, 4, 5]) if returning else None
        self.return_after_h = rng.uniform(2, 48)
        self.bid = None
        self.session_no = 0

    def begin(self):
        self.session_no += 1

    def _next(self):
        return int(round(self.open_frac * self.W)) if self.bid is None else int(self.bid + self.c * (self.W - self.bid))

    def act(self, j, standing, session):
        nb = min(self.W, self._next())
        if standing is not None and standing <= self.W and standing <= nb * (1 + self.tol):
            return ("accept",)
        if self.leave_round and self.session_no == 1 and j == self.leave_round:
            return ("walk",)
        if j == R:
            nb = self.W  # last round: best and final, up to the walk-away
        self.bid = nb
        return ("bid", nb)

    def saw(self, price):
        pass

    def final(self, standing) -> bool:
        return standing is not None and standing <= self.W


def run_world(cfg: DefenseConfig, *, seed: int, n_legit: int = 120, days: float = 7.0, attack: str | None = None,
              attack_bundle=("T45", ["loader"]), attack_start_h: float = 48.0) -> dict:
    """A week of legit traffic, optionally with one attacker running 10 probe sessions on one bundle."""
    rng = random.Random(seed)
    seller = XSessionSeller(cfg, seed=seed)
    personas = make_personas(n_legit, seed=1111 + seed)
    events = []  # (time, kind, payload)
    buyers = {}
    for i, p in enumerate(personas):
        b = LegitBuyer(p, rng, returning=rng.random() < 0.25)
        buyers[p.id] = b
        events.append((rng.uniform(0, days * 24), "legit", p.id))
    atk_run = AttackRun(cfg, seller, attack_bundle[0], attack_bundle[1], attack) if attack else None
    if attack:
        events.append((attack_start_h, "attack", attack))
    events.sort()
    legit_sessions, legit_out = [], {}
    q = list(events)
    while q:
        q.sort(key=lambda e: e[0])
        t, kind, payload = q.pop(0)
        if kind == "attack":
            nxt = atk_run.step(t)  # one probe session, interleaved in time with legit sessions
            if nxt is not None:
                q.append((nxt, "attack", payload))
            continue
        b = buyers[payload]
        p = b.p
        sess = seller.start(buyer_id=p.id, fingerprint=f"fp-{p.id}", product_id=p.target_product, addons=p.wants_addons, now_h=t)
        if sess is None:
            continue
        b.begin()
        res = play(sess, b)
        legit_sessions.append({"buyer": p.id, "session": b.session_no, "t": t, "deal": res.deal, "price": res.price,
                               "first_offer": res.first_offer, "last_offer": res.last_offer, "ended": res.ended,
                               "hard_zone_deal": bool(res.deal and res.price < floor_total(p.target_product, p.wants_addons)
                                                      + buffer_for(DefenseConfig(soft_floor=True), p.target_product, p.wants_addons)),
                               "breaker_at_start": sess.hard_zone_open_at_start is False and cfg.breaker})
        if res.ended == "buyer_walk" and b.session_no == 1 and b.leave_round:
            q.append((t + b.return_after_h, "legit", p.id))
        else:
            legit_out[p.id] = res
    # Per-buyer outcome (a returning buyer counts once).
    deals = [(pid, r) for pid, r in legit_out.items() if r.deal]
    profit = sum(r.price - cost_total(buyers[pid].p.target_product, buyers[pid].p.wants_addons) for pid, r in deals)
    feasible = [pid for pid in legit_out if buyers[pid].p.feasible]
    # Returning-buyer consistency: first offer in session 2 vs last offer in session 1.
    by_buyer = {}
    for s in legit_sessions:
        by_buyer.setdefault(s["buyer"], []).append(s)
    jumps = []
    for pid, ss in by_buyer.items():
        if len(ss) >= 2 and ss[0]["last_offer"] is not None and ss[1]["first_offer"] is not None:
            jumps.append(ss[1]["first_offer"] - ss[0]["last_offer"])
    hz_buyers = [pid for pid in legit_out if floor_total(buyers[pid].p.target_product, buyers[pid].p.wants_addons) <= buyers[pid].W
                 < floor_total(buyers[pid].p.target_product, buyers[pid].p.wants_addons)
                 + buffer_for(DefenseConfig(soft_floor=True), buyers[pid].p.target_product, buyers[pid].p.wants_addons)]
    atk_rows = atk_run.summary() if atk_run else None
    return {
        "condition": cfg.name, "seed": seed, "attack": attack,
        "buyers": len(legit_out), "deals": len(deals), "conversion": round(len(deals) / max(1, len(legit_out)), 4),
        "feasible_conversion": round(sum(1 for pid in feasible if legit_out[pid].deal) / max(1, len(feasible)), 4),
        "profit_per_buyer": round(profit / max(1, len(legit_out)), 1),
        "hard_zone_buyers": len(hz_buyers), "hard_zone_deals": sum(1 for pid in hz_buyers if legit_out[pid].deal),
        "returning": len(jumps), "returning_consistent": sum(1 for j in jumps if j <= 0),
        "returning_mean_jump": round(statistics.mean(jumps), 1) if jumps else None,
        "returning_max_jump": max(jumps) if jumps else None,
        "breaker_trips": len(seller.breaker.trips),
        "attack_result": None if atk_rows is None else {k: atk_rows[k] for k in ("best_extracted", "best_vs_floor", "below_soft", "soft_floor", "floor", "refused", "hours", "trips")},
    }


# ============================================================== main


def agg(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    return {"min": min(xs), "median": statistics.median(xs), "max": max(xs), "mean": round(statistics.mean(xs), 1)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--seeds", type=int, default=20)
    ap.add_argument("--out", default=str(HERE / "runs" / "part1_sim.json"))
    args = ap.parse_args()
    seeds = range(3 if args.quick else args.seeds)
    bundles = BUNDLES[3:4] if args.quick else BUNDLES

    out = {"conditions": {n: c.to_dict() for n, c in CONDITIONS.items()}, "attacks": [], "curve_fit": [], "worlds": []}
    for name, cfg in CONDITIONS.items():
        for mode in ATTACKERS:
            for pid, addons in bundles:
                for s in seeds:
                    out["attacks"].append(run_attack(cfg, pid, addons, mode, seed=s))
        for pid, addons in bundles:
            for s in seeds:
                out["curve_fit"].append(curve_fit_leak(cfg, pid, addons, s))
        for s in seeds:
            out["worlds"].append(run_world(cfg, seed=s))
            for mode in ATTACKERS:
                out["worlds"].append(run_world(cfg, seed=s, attack=mode))

    # Summaries.
    summary = {"attack": {}, "attack_curve": {}, "curve_fit": {}, "legit": {}}
    for name in CONDITIONS:
        for mode in ATTACKERS:
            rs = [r for r in out["attacks"] if r["condition"] == name and r["attacker"] == mode]
            summary["attack"][f"{name}|{mode}"] = {
                "runs": len(rs),
                "best_gap_frac": agg([r["best_gap_frac"] for r in rs]),
                "best_vs_floor": agg([r["best_vs_floor"] for r in rs]),
                "share_below_soft": round(sum(1 for r in rs if r["below_soft"]) / len(rs), 3),
                "share_at_floor": round(sum(1 for r in rs if r["best_vs_floor"] is not None and r["best_vs_floor"] <= 100) / len(rs), 3),
                "first_k_at_floor": agg([r["first_k_at_floor"] for r in rs]),
                "refused": agg([r["refused"] for r in rs]),
                "hours": agg([r["hours"] for r in rs]),
                "trips": agg([r["trips"] for r in rs]),
            }
            # Extracted price (as share of gap above floor) after each k, median over runs.
            curve = []
            for k in range(1, 11):
                vals = []
                for r in rs:
                    ex = [row["extracted"] for row in r["rows"] if row["k"] <= k and row["extracted"] is not None]
                    if ex:
                        vals.append((min(ex) - r["floor"]) / r["gap"])
                curve.append(round(statistics.median(vals), 4) if vals else None)
            summary["attack_curve"][f"{name}|{mode}"] = curve
        cf = [r for r in out["curve_fit"] if r["condition"] == name]
        summary["curve_fit"][name] = {"abs_err_vs_floor": agg([abs(r["err_vs_floor"]) for r in cf if r["err_vs_floor"] is not None]),
                                      "within_200_of_floor": round(sum(1 for r in cf if r["err_vs_floor"] is not None and abs(r["err_vs_floor"]) <= 200) / len(cf), 3)}
        for att in [None] + ATTACKERS:
            ws = [w for w in out["worlds"] if w["condition"] == name and w["attack"] == att]
            key = f"{name}|{att or 'none'}"
            summary["legit"][key] = {
                "worlds": len(ws),
                "conversion": round(statistics.mean(w["conversion"] for w in ws), 4),
                "feasible_conversion": round(statistics.mean(w["feasible_conversion"] for w in ws), 4),
                "profit_per_buyer": round(statistics.mean(w["profit_per_buyer"] for w in ws), 1),
                "hard_zone_deals": sum(w["hard_zone_deals"] for w in ws), "hard_zone_buyers": sum(w["hard_zone_buyers"] for w in ws),
                "returning": sum(w["returning"] for w in ws), "returning_consistent": sum(w["returning_consistent"] for w in ws),
                "returning_mean_jump": round(statistics.mean([w["returning_mean_jump"] for w in ws if w["returning_mean_jump"] is not None]), 1)
                if any(w["returning_mean_jump"] is not None for w in ws) else None,
                "breaker_trips": round(statistics.mean(w["breaker_trips"] for w in ws), 2),
                "attack_below_soft": None if att is None else sum(1 for w in ws if w["attack_result"]["below_soft"]),
                "attack_best_vs_floor": None if att is None else agg([w["attack_result"]["best_vs_floor"] for w in ws]),
            }
    out["summary"] = summary
    out["breaker_sweep"] = [] if args.quick else breaker_sweep()
    Path(args.out).parent.mkdir(exist_ok=True)
    Path(args.out).write_text(json.dumps(out, separators=(",", ":"), default=str))
    print_summary(summary)


def breaker_sweep(seeds: int = 10) -> list[dict]:
    """Variants of `full`: breaker threshold x cooldown x near-miss band. Attack-only below-soft share vs legit cost."""
    from dataclasses import replace

    base = CONDITIONS["full"]
    ref = statistics.mean(run_world(CONDITIONS["no_memory"], seed=s)["profit_per_buyer"] for s in range(seeds))
    ref_conv = statistics.mean(run_world(CONDITIONS["no_memory"], seed=s)["conversion"] for s in range(seeds))
    rows = []
    for thr in (1, 2):
        for cool in (24.0, 72.0, 168.0):
            for band in (0.10, 0.25):
                cfg = replace(base, name=f"full_t{thr}_c{int(cool)}_b{band}", breaker_threshold=thr, breaker_cooldown_h=cool, near_miss_frac=band)
                att = [run_attack(cfg, pid, addons, mode, seed=sd) for mode in ATTACKERS for pid, addons in BUNDLES for sd in range(seeds)]
                worlds = [run_world(cfg, seed=sd) for sd in range(seeds)]
                rows.append({
                    "threshold": thr, "cooldown_h": cool, "near_miss_frac": band,
                    "attack_below_soft": round(sum(1 for r in att if r["below_soft"]) / len(att), 3),
                    "slow_below_soft": round(sum(1 for r in att if r["below_soft"] and r["attacker"] == "bisect_rotate_slow")
                                             / sum(1 for r in att if r["attacker"] == "bisect_rotate_slow"), 3),
                    "attack_at_floor": round(sum(1 for r in att if r["best_vs_floor"] is not None and r["best_vs_floor"] <= 100) / len(att), 3),
                    "legit_conversion_drop_pts": round((ref_conv - statistics.mean(w["conversion"] for w in worlds)) * 100, 2),
                    "legit_profit_per_buyer_change": round(statistics.mean(w["profit_per_buyer"] for w in worlds) - ref, 1),
                    "trips_per_week": round(statistics.mean(w["breaker_trips"] for w in worlds), 2),
                })
    print("\nBreaker sweep (variants of full; attack-only, 4 attackers x 6 bundles x 10 seeds; legit vs no_memory, 10 worlds):")
    for r in rows:
        print(r)
    return rows


def print_summary(s: dict) -> None:
    print("\nAttack-only (no legit traffic). Best extracted price after 10 sessions, as $ above the hard floor and share of the list-floor gap.")
    print(f"{'condition|attacker':40s} {'$ above floor (min/med/max)':30s} {'gap frac med':>12s} {'below soft':>10s} {'at floor':>9s} {'k@floor med':>11s} {'refused':>8s} {'hours':>6s}")
    for k, v in s["attack"].items():
        b = v["best_vs_floor"] or {}
        g = v["best_gap_frac"] or {}
        kf = v["first_k_at_floor"] or {}
        print(f"{k:40s} {str(b.get('min'))+' / '+str(b.get('median'))+' / '+str(b.get('max')):30s} {g.get('median', ''):>12} "
              f"{v['share_below_soft']:>10} {v['share_at_floor']:>9} {kf.get('median', '-')!s:>11} {(v['refused'] or {}).get('median', 0)!s:>8} {(v['hours'] or {}).get('median', 0)!s:>6}")
    print("\nMedian extracted (share of gap above floor) after k = 1..10 sessions:")
    for k, v in s["attack_curve"].items():
        print(f"{k:40s} " + " ".join("  -  " if x is None else f"{x:5.2f}" for x in v))
    print("\nCurve-fit leak from session-1 offers in rounds 5-6 (|estimate - hard floor|):")
    for k, v in s["curve_fit"].items():
        print(f"{k:14s} {v}")
    print("\nLegit traffic (a week, 120 buyers per world, 20 worlds), with and without an attacker on T45+loader:")
    print(f"{'condition|attack':34s} {'conv':>6s} {'feas':>6s} {'profit/buyer':>12s} {'hz deals/buyers':>15s} {'ret consistent':>15s} {'mean jump':>9s} {'trips':>6s} {'atk<soft':>8s} {'atk $>floor med':>15s}")
    for k, v in s["legit"].items():
        a = v["attack_best_vs_floor"] or {}
        print(f"{k:34s} {v['conversion']:>6} {v['feasible_conversion']:>6} {v['profit_per_buyer']:>12} {str(v['hard_zone_deals'])+'/'+str(v['hard_zone_buyers']):>15s} "
              f"{str(v['returning_consistent'])+'/'+str(v['returning']):>15s} {v['returning_mean_jump']!s:>9} {v['breaker_trips']:>6} {v['attack_below_soft']!s:>8} {a.get('median', '-')!s:>15}")


if __name__ == "__main__":
    main()
