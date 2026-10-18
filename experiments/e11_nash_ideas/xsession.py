"""Cross-session defenses against floor probing (E11 Part 1, A18).

Every guardrail in E9 works inside one negotiation. A buyer can restart and
learn the floor across sessions. This module is the seller-side state that
spans sessions, written so it can move into `sales_agent/` for the build:

    DefenseConfig   which defenses are on.
    MemoryStore     per-buyer records keyed by every identifier we see
                    (buyer id, device/IP fingerprint, payment instrument).
    Breaker         product-level probe detector: abandoned deals and near-miss
                    deadline bids trip it, and it closes the hard-floor accept
                    zone for a cooldown.
    StartLimiter    session-start rate limit per fingerprint.
    XSessionSeller  the pricing core over all of the above. `start()` opens a
                    `SellerSession` (or refuses it), the session prices every
                    round and decides accepts, `close()` writes the outcome back.
    XSessionStrategy adapter to the harness `SellerStrategy` hook, so the same
                    code prices an LLM seller (part1_llm.py).

Pricing is E5's Boulware in concession-fraction space (0 = list, 1 = hard floor):

    t     = min(1, tau / max_rounds)      tau = this buyer's round count
    frac  = end_frac * t ** 3             end_frac = 1 (hard floor) or the soft floor's fraction
    price = list - frac * (list - floor), rounded up to $100, never below the endpoint

Without memory, tau restarts at 1 every session. With memory it resumes from
the buyer's earlier sessions, the seller never offers more than it already
offered this buyer, and each buyer gets one deadline: the "accept anything at or
above the hard floor in the last round" rule fires once per buyer, not once per
session.

Accept rule (E5 CodeStrategy): accept a buyer bid at or above our next offer;
at the deadline accept a bid at or above our endpoint; at the deadline also
accept a bid down to the hard floor if the hard-floor zone is open (soft floor
on: first deadline for this buyer, breaker closed).
"""

from __future__ import annotations

import copy
import math
import random
from dataclasses import asdict, dataclass, field

from sales_agent.catalog import floor_total, list_total

ROUND_TO = 100


def ceil_to(x: float, step: int = ROUND_TO) -> int:
    return int(math.ceil(round(x, 6) / step) * step)


@dataclass(frozen=True)
class DefenseConfig:
    name: str = "custom"
    memory: bool = False  # per-buyer memory: resume the clock, never beat earlier offers, one deadline per buyer
    soft_floor: bool = False  # offers stop at hard floor + buffer; deadline accepts may go to the hard floor
    soft_floor_frac: float = 0.05  # buffer = max(soft_floor_min, frac * (list - floor)), E9's defaults
    soft_floor_min: int = 300
    jitter: bool = False  # per-buyer random endpoint above the soft floor, noisy concession steps
    jitter_end_frac: float = 0.10  # endpoint drawn uniformly in [soft, soft + this * gap]
    jitter_step: float = 0.25  # each round's concession fraction is scaled by U(1 - x, 1 + x)
    link_identities: bool = False  # a new buyer id seen with a known fingerprint or payment id inherits that record
    start_limit: int | None = None  # max session starts per fingerprint per window (None = no limit)
    start_window_h: float = 24.0
    breaker: bool = False  # product-level probe breaker closes the hard-floor zone
    breaker_threshold: int = 2  # probe events in the window that trip it
    breaker_window_h: float = 24.0
    breaker_cooldown_h: float = 72.0
    near_miss_frac: float = 0.25  # a rejected deadline bid within this share of the gap below the hard floor is a probe event
    hard_zone: bool = True  # deadline accepts may go below the endpoint, down to the hard floor
    memory_ttl_h: float = 24.0 * 30
    exponent: float = 3.0
    max_rounds: int = 8

    def to_dict(self) -> dict:
        return asdict(self)


# The cumulative ablation used in the experiment.
CONDITIONS: dict[str, DefenseConfig] = {
    c.name: c
    for c in [
        DefenseConfig("no_memory"),
        DefenseConfig("memory", memory=True),
        DefenseConfig("memory_soft", memory=True, soft_floor=True),
        DefenseConfig("full", memory=True, soft_floor=True, jitter=True, link_identities=True, start_limit=4, breaker=True),
        DefenseConfig("full_strict", memory=True, soft_floor=True, jitter=True, link_identities=True, start_limit=4,
                      hard_zone=False),
    ]
}


def buffer_for(cfg: DefenseConfig, product_id: str, addons) -> int:
    if not cfg.soft_floor:
        return 0
    gap = list_total(product_id, addons) - floor_total(product_id, addons)
    return max(cfg.soft_floor_min, ceil_to(cfg.soft_floor_frac * gap))


# ============================================================== state


@dataclass
class BuyerRecord:
    rid: int
    keys: set = field(default_factory=set)  # ("buyer", id), ("fp", fingerprint), ("pay", payment id)
    rounds_used: int = 0  # tau at the end of the last session
    min_frac: dict = field(default_factory=dict)  # bundle key -> deepest concession fraction offered so far
    deadline_used: bool = False  # this buyer already had its deadline round
    end_jitter: float = 0.0  # endpoint above the soft floor, as a share of the gap (jitter)
    seed: int = 0
    sessions: int = 0
    last_seen_h: float = 0.0
    last_offer: dict = field(default_factory=dict)  # bundle key -> last price offered


def bundle_key(product_id: str, addons) -> str:
    return product_id + "+" + "+".join(sorted(addons))


class MemoryStore:
    """Per-buyer records. A record is found by any of its keys (linking on) or by buyer id only."""

    def __init__(self, cfg: DefenseConfig, rng: random.Random):
        self.cfg, self.rng = cfg, rng
        self.records: list[BuyerRecord] = []
        self.index: dict[tuple, int] = {}

    def lookup(self, keys: list[tuple], now_h: float) -> BuyerRecord | None:
        usable = keys if self.cfg.link_identities else [k for k in keys if k[0] == "buyer"]
        for k in usable:
            rid = self.index.get(k)
            if rid is not None:
                rec = self.records[rid]
                if now_h - rec.last_seen_h <= self.cfg.memory_ttl_h:
                    return rec
        return None

    def new(self, keys: list[tuple]) -> BuyerRecord:
        rec = BuyerRecord(rid=len(self.records), seed=self.rng.randrange(1 << 30))
        if self.cfg.jitter:
            rec.end_jitter = self.rng.uniform(0, self.cfg.jitter_end_frac)
        self.records.append(rec)
        return rec

    def attach(self, rec: BuyerRecord, keys: list[tuple]) -> None:
        for k in keys:
            rec.keys.add(k)
            self.index[k] = rec.rid


class Breaker:
    """Product-level probe breaker. Events: abandoned deals, near-miss deadline bids."""

    def __init__(self, cfg: DefenseConfig):
        self.cfg = cfg
        self.events: dict[str, list[float]] = {}
        self.open_until: dict[str, float] = {}  # product -> time the hard zone reopens
        self.trips: list[tuple[str, float]] = []

    def tripped(self, product_id: str, now_h: float) -> bool:
        return self.cfg.breaker and now_h < self.open_until.get(product_id, -1.0)

    def record(self, product_id: str, now_h: float, kind: str) -> None:
        if not self.cfg.breaker:
            return
        evs = [t for t in self.events.get(product_id, []) if now_h - t <= self.cfg.breaker_window_h] + [now_h]
        self.events[product_id] = evs
        if len(evs) >= self.cfg.breaker_threshold and not self.tripped(product_id, now_h):
            self.open_until[product_id] = now_h + self.cfg.breaker_cooldown_h
            self.trips.append((product_id, now_h))


class StartLimiter:
    def __init__(self, cfg: DefenseConfig):
        self.cfg = cfg
        self.starts: dict[str, list[float]] = {}

    def allow(self, fingerprint: str | None, now_h: float) -> bool:
        if self.cfg.start_limit is None or not fingerprint:
            return True
        recent = [t for t in self.starts.get(fingerprint, []) if now_h - t <= self.cfg.start_window_h]
        self.starts[fingerprint] = recent
        return len(recent) < self.cfg.start_limit

    def note(self, fingerprint: str | None, now_h: float) -> None:
        if fingerprint:
            self.starts.setdefault(fingerprint, []).append(now_h)


# ============================================================== pricing


class XSessionSeller:
    """Seller state across sessions: memory, breaker, start limiter, and the pricing core."""

    def __init__(self, cfg: DefenseConfig, seed: int = 0):
        self.cfg = cfg
        self.rng = random.Random(seed)
        self.memory = MemoryStore(cfg, self.rng)
        self.breaker = Breaker(cfg)
        self.limiter = StartLimiter(cfg)
        self.log: list[dict] = []

    def clone(self) -> "XSessionSeller":
        return copy.deepcopy(self)

    def start(self, *, buyer_id: str, product_id: str, addons, now_h: float, fingerprint: str | None = None,
              payment_id: str | None = None) -> "SellerSession | None":
        """Open a session, or return None if the start limit refuses it."""
        if not self.limiter.allow(fingerprint, now_h):
            self.log.append({"event": "start_refused", "buyer": buyer_id, "fp": fingerprint, "t": now_h})
            return None
        self.limiter.note(fingerprint, now_h)
        keys = [("buyer", buyer_id)] + ([("fp", fingerprint)] if fingerprint else []) + ([("pay", payment_id)] if payment_id else [])
        rec = self.memory.lookup(keys, now_h) if self.cfg.memory else None
        returning = rec is not None
        if rec is None:
            rec = self.memory.new(keys)
            if not self.cfg.memory:
                # No memory: a throwaway record per session (still jittered if jitter is on).
                rec.keys = set()
        if self.cfg.memory:
            self.memory.attach(rec, keys)
        rec.sessions += 1
        rec.last_seen_h = now_h
        return SellerSession(self, rec, product_id, list(addons), now_h, returning)


@dataclass
class SessionTrace:
    offers: list = field(default_factory=list)  # (session round, price)
    bids: list = field(default_factory=list)  # (session round, price)
    accepted_bid: int | None = None
    deal_price: int | None = None
    deadline_bid_rejected: int | None = None


class SellerSession:
    """One negotiation. Call `respond(j, bid)` each round (the buyer moves first), then `close()`."""

    def __init__(self, seller: XSessionSeller, rec: BuyerRecord, product_id: str, addons: list, now_h: float, returning: bool):
        self.s, self.cfg, self.rec = seller, seller.cfg, rec
        self.pid, self.addons, self.now = product_id, addons, now_h
        self.returning = returning
        self.key = bundle_key(product_id, addons)
        self.L = list_total(product_id, addons)
        self.F = floor_total(product_id, addons)
        self.gap = max(1, self.L - self.F)
        self.buffer = buffer_for(self.cfg, product_id, addons)
        self.tau0 = rec.rounds_used if self.cfg.memory else 0
        self.deadline_used_before = rec.deadline_used if self.cfg.memory else False
        self.last_round = 0
        self.trace = SessionTrace()
        self.hard_zone_open_at_start = self.hard_zone_open()

    # -- schedule
    @property
    def end_price(self) -> int:
        """Our lowest offer for this bundle: hard floor, soft floor, or the jittered endpoint."""
        p = self.F + self.buffer + (self.rec.end_jitter * self.gap if self.cfg.jitter else 0)
        return min(self.L, ceil_to(p))

    def _noise(self, tau: int) -> float:
        if not self.cfg.jitter:
            return 1.0
        r = random.Random(self.rec.seed * 1000 + tau)
        return r.uniform(1 - self.cfg.jitter_step, 1 + self.cfg.jitter_step)

    def offer_at(self, j: int) -> int:
        """The price we offer in session round j (before the buyer-consistency clamp)."""
        tau = self.tau0 + j
        t = min(1.0, tau / self.cfg.max_rounds)
        end_frac = (self.L - self.end_price) / self.gap
        frac = min(end_frac, end_frac * (t ** self.cfg.exponent) * (self._noise(tau) if t < 1 else 1.0))
        price = max(self.end_price, ceil_to(self.L - frac * self.gap))
        # Never offer this buyer more than we already offered it for this bundle (consistency, and monotone).
        if self.cfg.memory and self.key in self.rec.last_offer:
            price = min(price, self.rec.last_offer[self.key])
        if self.trace.offers:
            price = min(price, min(p for _, p in self.trace.offers))
        return price

    def is_deadline(self, j: int) -> bool:
        return self.tau0 + j >= self.cfg.max_rounds

    def hard_zone_open(self) -> bool:
        if not self.cfg.hard_zone or self.s.breaker.tripped(self.pid, self.now):
            return False
        return not self.deadline_used_before

    # -- moves
    def respond(self, j: int, bid: int | None) -> tuple[str, int]:
        """('accept', bid) or ('offer', price). j is the session round, from 1."""
        self.last_round = j
        nxt = self.offer_at(j)
        if bid is not None:
            self.trace.bids.append((j, bid))
            if bid >= nxt:
                return self._accept(bid)
            if self.is_deadline(j):
                if bid >= self.end_price:
                    return self._accept(bid)
                if self.hard_zone_open() and bid >= self.F:
                    return self._accept(bid)
                self.trace.deadline_bid_rejected = bid
        self.trace.offers.append((j, nxt))
        self.rec.last_offer[self.key] = min(nxt, self.rec.last_offer.get(self.key, nxt))
        return "offer", nxt

    def _accept(self, bid: int) -> tuple[str, int]:
        self.trace.accepted_bid = bid
        self.trace.deal_price = bid
        return "accept", bid

    def buyer_accepts(self) -> int:
        """The buyer accepted our standing offer."""
        price = self.trace.offers[-1][1]
        self.trace.deal_price = price
        return price

    def close(self, *, abandoned: bool = False) -> None:
        """Write the session back: the clock, the deadline, and probe events for the breaker."""
        tau_end = self.tau0 + self.last_round
        if self.cfg.memory:
            self.rec.rounds_used = tau_end
            if tau_end >= self.cfg.max_rounds:
                self.rec.deadline_used = True
        bid = self.trace.deadline_bid_rejected
        if bid is not None and self.trace.deal_price is None and bid >= self.F - self.cfg.near_miss_frac * self.gap:
            self.s.breaker.record(self.pid, self.now, "near_miss")
        if abandoned and self.trace.deal_price is not None:
            self.s.breaker.record(self.pid, self.now, "abandoned_deal")


# ============================================================== harness adapter


class XSessionStrategy:
    """`SellerStrategy` for an LLM seller: the cross-session pricer picks every move.

    One instance per negotiation. The harness's buyer moves first each round; this
    reads the buyer's standing offer (if it was made this round) and asks the
    session for the move. Bundle changes restart pricing on the new bundle at the
    same concession fraction (E5's convention); the experiment holds bundles fixed.
    """

    name = "xsession"

    def __init__(self, session: SellerSession):
        self.session = session

    def decide(self, state):
        from sales_agent.agents import StrategyMove  # local import: keeps this module harness-light

        s = self.session
        bid = None
        last = state.transcript[-1] if state.transcript else None
        if last is not None and last.role == "buyer" and last.action == "offer" and last.offer:
            o = last.offer
            if o.product_id == s.pid and sorted(o.addons) == sorted(s.addons):
                bid = o.price
        action, price = s.respond(state.round, bid)
        if action == "accept":
            return StrategyMove("accept", note=f"xsession: accept ${price:,}")
        return StrategyMove("offer", price=price, addons=list(s.addons), product_id=s.pid,
                            note=f"xsession: round {state.round} (tau {s.tau0 + state.round}), offer ${price:,}")
