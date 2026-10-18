"""E7 marketplace: four competing sellers, a multi-seller buyer, direct and broker modes.

Sellers (same catalog, same floors and costs, different list prices and pricing):
    heartland  fixed        list x1.00, negotiable=False, code holds the price at list
    valueag    fixed_low    list x0.95, negotiable=False, code holds the price at its list
    prairie    negotiating  list x1.00, the harness SellerAgent (free LLM) + PolicyEngine
    fieldline  dynamic      list x1.00, DynamicStrategy picks the price from buyer signals

The buyer sees a registry of agent cards (with list prices) and every conversation
it has, and each turn picks a recipient (one seller or "all") and an action.

Modes:
    direct  the buyer contacts whichever sellers it wants. Sellers know only what the
            buyer tells them.
    broker  a MarketLink broker (Inkbox-like, but with fan-out, which Inkbox lacks)
            forwards the buyer's first message as an RFQ to every seller, shows the buyer
            a bid board, and relays counters. Sellers are told they are competing.
"""

from __future__ import annotations

import random
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from sell2agent import llm
from sell2agent.agents import NegotiationState, SellerAgent, StrategyMove, Turn, parse_turn, render_transcript
from sell2agent.catalog import ADDONS, PRODUCTS, SELLER_NAME, Item, cost_total, floor_total, list_total, seller_catalog
from sell2agent.negotiation import Outcome, _seller_turn
from sell2agent.personas import BRIEFS, BuyerPersona
from sell2agent.policy import Offer, PolicyEngine

HERE = Path(__file__).resolve().parent
BROKER_NAME = "MarketLink"

# ---------------------------------------------------------------------------
# Sellers and the registry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SellerSpec:
    id: str
    name: str
    kind: str  # fixed | fixed_low | negotiating | dynamic
    mult: float  # list price multiplier on the catalog list
    negotiable: bool
    description: str
    pitch: str

    @property
    def endpoint(self) -> str:
        return f"https://{self.id}.agents.example/a2a"


SELLERS: list[SellerSpec] = [
    SellerSpec(
        "heartland", "Heartland Tractor Supply", "fixed", 1.00, False,
        "Family-run tractor dealer since 1987. Sells the T25 Compact, T45 Utility and T75 Row-Crop, plus loader, warranty and delivery add-ons.",
        "Straightforward pricing: our list price is the price. No haggling, no surprises.",
    ),
    SellerSpec(
        "valueag", "ValueAg Direct", "fixed_low", 0.95, False,
        "Online-first equipment dealer with low overhead. Sells the T25 Compact, T45 Utility and T75 Row-Crop, plus loader, warranty and delivery add-ons.",
        "Everyday low prices: about 5% below standard list on every tractor and add-on. Fixed prices, no haggling.",
    ),
    SellerSpec(
        "prairie", SELLER_NAME, "negotiating", 1.00, True,
        "Regional tractor dealer. Sells the T25 Compact, T45 Utility and T75 Row-Crop, plus loader, warranty and delivery add-ons.",
        "Talk to our sales agent: we'll work with you on price and bundles to find a deal that fits.",
    ),
    SellerSpec(
        "fieldline", "FieldLine Machinery", "dynamic", 1.00, True,
        "Equipment dealer with an automated pricing desk. Sells the T25 Compact, T45 Utility and T75 Row-Crop, plus loader, warranty and delivery add-ons.",
        "Live pricing: our quotes respond to your order, your timeline, and the market. Bring us a written quote and we'll try to beat it.",
    ),
]
SPECS = {s.id: s for s in SELLERS}
KIND = {s.id: s.kind for s in SELLERS}


def item_list(spec: SellerSpec, item: Item) -> int:
    """This seller's list price for one item, rounded to $50."""
    if spec.mult == 1.0:
        return item.list_price
    return int(item.list_price * spec.mult / 50 + 0.5) * 50


def my_list_total(spec: SellerSpec, product_id: str, addons=()) -> int:
    return item_list(spec, PRODUCTS[product_id]) + sum(item_list(spec, ADDONS[a]) for a in addons)


def seller_catalog_text(spec: SellerSpec) -> str:
    """Same format as catalog.seller_catalog(), with this seller's own list prices."""
    lines = ["Tractors (id: name | list | floor | cost):"]
    for p in PRODUCTS.values():
        lines.append(f"- {p.id}: {p.name} | list ${item_list(spec, p):,} | floor ${p.floor_price:,} | cost ${p.cost:,}. {p.description}")
    lines.append("Add-ons (id: name | list | floor | cost):")
    for a in ADDONS.values():
        lines.append(f"- {a.id}: {a.name} | list ${item_list(spec, a):,} | floor ${a.floor_price:,} | cost ${a.cost:,}. {a.description}")
    lines.append("An offer's floor total is the tractor's floor plus each included add-on's floor.")
    return "\n".join(lines)


def card(spec: SellerSpec) -> dict:
    return {
        "id": spec.id,
        "name": spec.name,
        "description": spec.description,
        "endpoint": spec.endpoint,
        "negotiable": spec.negotiable,
        "pitch": spec.pitch,
        "list_prices": {
            "tractors": {p.id: item_list(spec, p) for p in PRODUCTS.values()},
            "addons": {a.id: item_list(spec, a) for a in ADDONS.values()},
        },
    }


def registry() -> dict:
    return {
        "registry": "E7 local seller registry (simulated discovery)",
        "note": "All four sellers carry the same three tractors and three add-ons with identical specs.",
        "sellers": [card(s) for s in SELLERS],
    }


def card_text(spec: SellerSpec) -> str:
    c = card(spec)
    tractors = ", ".join(f"{pid} {PRODUCTS[pid].name} ${v:,}" for pid, v in c["list_prices"]["tractors"].items())
    addons = ", ".join(f"{aid} ({ADDONS[aid].name}) ${v:,}" for aid, v in c["list_prices"]["addons"].items())
    return (
        f"- id: {c['id']}\n  name: {c['name']}\n  endpoint: {c['endpoint']}\n  negotiable: {str(c['negotiable']).lower()}\n"
        f"  description: {c['description']}\n  pitch: {c['pitch']}\n  list prices: tractors: {tractors}; add-ons: {addons}"
    )


# ---------------------------------------------------------------------------
# Seller agents
# ---------------------------------------------------------------------------


class MarketSeller(SellerAgent):
    """The harness SellerAgent with this seller's own name and list prices in its prompt.

    The policy engine still uses the catalog floors (identical for every seller).
    """

    def __init__(self, spec: SellerSpec, **kw):
        super().__init__(negotiable=spec.negotiable, **kw)
        self.spec = spec

    def system_prompt(self) -> str:
        base = super().system_prompt()
        return base.replace(seller_catalog(), seller_catalog_text(self.spec)).replace(SELLER_NAME, self.spec.name)


class FixedPriceStrategy:
    """Always offer this seller's list total for the basket under discussion; accept at or above it."""

    def __init__(self, spec: SellerSpec):
        self.spec = spec

    def decide(self, state: NegotiationState) -> StrategyMove:
        last = state.transcript[-1] if state.transcript else None
        if last and last.role == "buyer" and last.action == "offer" and last.offer:
            if last.offer.price >= my_list_total(self.spec, last.offer.product_id, last.offer.addons):
                return StrategyMove("accept", note="buyer offer at or above fixed list")
        price = my_list_total(self.spec, state.product_id, state.addons)
        return StrategyMove("offer", price=price, product_id=state.product_id, addons=list(state.addons), note="fixed list price")


@dataclass
class Signals:
    quotes: list[dict] = field(default_factory=list)  # verified competitor quotes from this conversation
    rejected_quotes: list[dict] = field(default_factory=list)  # extracted but not found verbatim in the buyer's text
    other_sellers: int = 0
    urgency: str = "unknown"


EXTRACT_SYSTEM = """You read a buyer's messages to one tractor seller and extract pricing signals. Report only what the buyer actually wrote. Never guess or compute numbers.

A competitor quote is a total price the buyer says ANOTHER seller offered or lists. The buyer's own offers, targets, and budget are not competitor quotes.

Reply with one JSON object and nothing else:
{"competitor_quotes": [{"seller": "<seller name the buyer gave, or 'unnamed'>", "price": <integer dollars, exactly as the buyer wrote it>, "product_id": "T25" | "T45" | "T75" | null, "addons": ["loader" | "warranty" | "delivery", ...] or null}], "other_sellers_count": <how many other sellers the buyer says it is talking to or has quotes from; 0 if not mentioned>, "urgency": "low" | "medium" | "high" | "unknown"}

"addons" lists the add-ons the quoted price includes: [] if the buyer says the price is for the tractor alone, null only if the buyer doesn't say."""

_NUM = re.compile(r"\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?([kK])?\b")
_BROKER_PREFIX = re.compile(r"^\[" + BROKER_NAME + r"[^\]]*\]\s*")


def numbers_in(text: str) -> set[int]:
    out = set()
    for m in _NUM.finditer(text):
        try:
            v = float(m.group(1).replace(",", ""))
        except ValueError:
            continue
        if m.group(2):
            v *= 1000
        out.add(int(round(v)))
    return out


def strip_prefix(msg: str) -> str:
    return _BROKER_PREFIX.sub("", msg)


class DynamicStrategy:
    """Starts at list. Concedes faster with more competition and a patient buyer, slower with an
    urgent one, and beats a competitor quote the buyer cited (only quotes that appear verbatim in
    this conversation). Never below the floor; never raises its own price on the same basket."""

    URGENCY_MULT = {"high": 0.6, "medium": 1.0, "low": 1.25, "unknown": 1.0}

    def __init__(self, spec: SellerSpec, known_competitors: int = 0):
        self.spec = spec
        self.known_competitors = known_competitors
        self.signals = Signals()
        self.last_explain = ""

    @staticmethod
    def _adjust(q: dict, product_id: str, addons: list[str]) -> int | None:
        """A competitor quote, adjusted to this basket by standard list prices of add-ons."""
        if q.get("product_id") and q["product_id"] != product_id:
            return None
        if q.get("addons") is None:
            return int(q["price"])
        theirs = set(q["addons"])
        mine = set(addons)
        adj = int(q["price"]) + sum(ADDONS[a].list_price for a in mine - theirs) - sum(ADDONS[a].list_price for a in theirs - mine)
        return adj

    def decide(self, state: NegotiationState) -> StrategyMove:
        pid, addons = state.product_id, list(state.addons)
        L = my_list_total(self.spec, pid, addons)
        F = floor_total(pid, addons)
        room = L - F
        k = len(state.offers("seller"))
        s = self.signals
        comp = max(self.known_competitors, s.other_sellers, 1 if s.quotes else 0)
        um = self.URGENCY_MULT.get(s.urgency, 1.0)
        cm = 0.8 if comp == 0 else (1.0 if comp == 1 else 1.25)
        frac = min(0.9, (1 - 0.8**k) * um * cm)
        target = L - room * frac
        why = [f"k={k} comp={comp} urgency={s.urgency} frac={frac:.2f}"]

        best_q = None
        for q in s.quotes:
            adj = self._adjust(q, pid, addons)
            if adj is not None and (best_q is None or adj < best_q[0]):
                best_q = (adj, q)
        if best_q is not None:
            beat = max(100, int(best_q[0] * 0.005 / 50) * 50)
            if best_q[0] - beat < target:
                target = best_q[0] - beat
                why.append(f"beat cited {best_q[1].get('seller')} ${best_q[1]['price']:,} (adj ${best_q[0]:,}) by ${beat:,}")

        # Never raise the price on a basket it already quoted, even after the buyer switched baskets and back.
        # (Fixed after the full run: the version that produced runs/full_*.jsonl only checked the latest offer.)
        same = [o.price for o in state.offers("seller") if o.product_id == pid and sorted(o.addons) == sorted(addons)]
        if same:
            target = min(target, min(same))
        target = int(target // 50 * 50)
        if target < F:
            target = F
            why.append("held at floor")
        self.last_explain = "; ".join(why)

        last = state.transcript[-1] if state.transcript else None
        if last and last.role == "buyer" and last.action == "offer" and last.offer:
            b = last.offer.price
            if b >= target or (k >= 3 and b >= F and b >= target - 0.01 * L):
                return StrategyMove("accept", note=f"dynamic: buyer ${b:,} >= target ${target:,}; {self.last_explain}")
        return StrategyMove("offer", price=target, product_id=pid, addons=addons, note=f"dynamic: {self.last_explain}")


class DynamicSeller(MarketSeller):
    """MarketSeller + DynamicStrategy, with a cheap Haiku pass that pulls signals out of the
    buyer's messages in this conversation before the strategy picks the price."""

    def __init__(self, spec: SellerSpec, known_competitors: int = 0, extract_model: str = llm.HAIKU, **kw):
        self.dyn = DynamicStrategy(spec, known_competitors)
        super().__init__(spec, strategy=self.dyn, **kw)
        self.extract_model = extract_model
        self._seen = -1
        self.signal_log: list[dict] = []

    def _update_signals(self, state: NegotiationState, usage: llm.Usage | None) -> None:
        if len(state.transcript) == self._seen:
            return
        self._seen = len(state.transcript)
        msgs = [strip_prefix(t.message) for t in state.transcript if t.role == "buyer"]
        text = "\n".join(msgs)
        prompt = "Buyer's messages to this seller, oldest first:\n" + "\n".join(f"- {m}" for m in msgs)
        try:
            reply, _ = llm.complete_json(EXTRACT_SYSTEM, prompt, model=self.extract_model, effort="low", usage=usage, retries=2)
        except (llm.LLMError, ValueError):
            reply = {}
        present = numbers_in(text)
        quotes, rejected = [], []
        for q in reply.get("competitor_quotes") or []:
            try:
                price = int(round(float(str(q.get("price")).replace("$", "").replace(",", ""))))
            except (TypeError, ValueError):
                continue
            pid = q.get("product_id") if q.get("product_id") in PRODUCTS else None
            ads = q.get("addons")
            ads = [a for a in ads if a in ADDONS] if isinstance(ads, list) else None
            rec = {"seller": str(q.get("seller") or "unnamed"), "price": price, "product_id": pid, "addons": ads}
            (quotes if any(abs(price - v) <= 1 for v in present) else rejected).append(rec)
        s = self.dyn.signals
        s.quotes, s.rejected_quotes = quotes, rejected
        try:
            s.other_sellers = max(s.other_sellers, int(reply.get("other_sellers_count") or 0))
        except (TypeError, ValueError):
            pass
        u = str(reply.get("urgency") or "unknown").lower()
        if u in DynamicStrategy.URGENCY_MULT and u != "unknown":
            s.urgency = u
        self.signal_log.append({"turn": state.round, "quotes": quotes, "rejected": rejected, "other_sellers": s.other_sellers, "urgency": s.urgency})

    def act(self, state: NegotiationState, usage: llm.Usage | None = None, feedback: str = "") -> Turn:
        self._update_signals(state, usage)
        s = self.dyn.signals
        notes = []
        if s.quotes:
            notes.append(
                "Competitor quotes the buyer stated in this conversation (you may refer to these, and only these): "
                + "; ".join(f"{q['seller']} ${q['price']:,}" for q in s.quotes)
                + "."
            )
        notes.append("Don't state or imply any competitor price, other buyer, or stock level the buyer didn't tell you about.")
        fb = "\n".join(notes) + (f"\n\n{feedback}" if feedback else "")
        return super().act(state, usage, feedback=fb)


def make_seller(spec: SellerSpec, mode: str, n_sellers: int, model=None, effort=None) -> SellerAgent:
    listing = f"Your public agent card says: \"{spec.description} {spec.pitch}\" Act consistently with it."
    if mode == "broker":
        listing += (
            f"\n\nYou are bidding through {BROKER_NAME}, a broker. The buyer's request went to {n_sellers} sellers, including you, "
            "and the buyer will compare bids. You don't see other sellers' bids unless the buyer tells you."
        )
    kw = dict(model=model, effort=effort, extra_instructions=listing)
    if spec.kind in ("fixed", "fixed_low"):
        return MarketSeller(spec, strategy=FixedPriceStrategy(spec), **kw)
    if spec.kind == "dynamic":
        return DynamicSeller(spec, known_competitors=(n_sellers - 1) if mode == "broker" else 0, **kw)
    return MarketSeller(spec, **kw)  # negotiating: free LLM behind the policy engine


# ---------------------------------------------------------------------------
# Multi-seller buyer
# ---------------------------------------------------------------------------

MARKET_ACTION_HELP = """Each turn, write one message, choose who gets it, and choose one action:
- "to": one seller id from the registry, or "all" to send the same message to every seller. Each seller only sees what you send to it.
- "offer": propose a deal to the recipient(s): a product id, one total price in dollars for the tractor plus add-ons, and the add-on ids.
- "accept": accept the named seller's standing offer exactly as stated. This closes the purchase. "to" must be one seller id.
- "message": talk or ask a question without making an offer.
- "walk": stop talking to the named seller; with "to": "all", end your search without buying."""

MARKET_REPLY_FORMAT = """Reply with one JSON object and nothing else:
{"to": "<seller id>" | "all", "message": "<what you say>", "action": "offer" | "accept" | "message" | "walk", "offer": {"product_id": "<id>", "price": <integer dollars>, "addons": ["<add-on id>", ...]} or null, "why": "<one short sentence for your client on why you chose this move and recipient; sellers never see it>"}"""


class MarketBuyer:
    role = "buyer"

    def __init__(self, persona: BuyerPersona, specs: list[SellerSpec], mode: str, *, max_turns: int = 12, model=None, effort=None):
        self.persona = persona
        self.specs = specs
        self.mode = mode
        self.max_turns = max_turns
        self.model = model
        self.effort = effort

    def system_prompt(self) -> str:
        p = self.persona
        wants = ", ".join(ADDONS[a].name for a in p.wants_addons) or "none"
        n = len(self.specs)
        if self.mode == "broker":
            how = (
                f"You are shopping through {BROKER_NAME}, a broker. Your first message is a request for quotes (RFQ): {BROKER_NAME} forwards it "
                f"to all {n} sellers in its registry below and returns their bids. After that, each turn you can send a counter or message "
                f"to one seller or to all; {BROKER_NAME} relays it and returns the replies. The sellers know they are competing. "
                f"You have at most {self.max_turns} turns in total."
            )
        else:
            how = (
                f"You found these {n} sellers in a public registry. Each card lists the seller's agent endpoint, whether it negotiates, and its list prices. "
                f"You contact sellers directly and decide whom to talk to and in what order. You have at most {self.max_turns} turns in total."
            )
        parts = [
            "You are a purchasing agent buying equipment for your client. Several sellers offer the same tractor models with identical specs. "
            "You can talk with any of them and buy from one.",
            f"Your client's need: {p.need}.",
            f"Add-ons your client wants if the price works: {wants}.",
            f"Budget your client mentioned: ${p.budget:,}. You may share this or keep it to yourself.",
            f"Your walk-away price: ${p.walk_away:,} total. Never agree to pay more than this. It is private: don't reveal it.",
            BRIEFS.get(p.brief, BRIEFS["neutral"]),
            f"Your client's urgency: {p.urgency}.",
            how,
            "Seller registry (agent cards):\n" + "\n".join(card_text(s) for s in self.specs),
            MARKET_ACTION_HELP,
            "Only accept an offer at or below your walk-away price.",
            MARKET_REPLY_FORMAT,
        ]
        return "\n\n".join(parts)

    def _thread_view(self, spec: SellerSpec, state: NegotiationState, closed: bool) -> str:
        if not state.transcript:
            return "(not contacted yet)"
        lines = []
        for t in state.transcript:
            if t.role == "buyer":
                who = "YOU" + (" (sent to all)" if "to:all" in t.note else "")
                msg = strip_prefix(t.message)
            else:
                who = spec.name.upper()
                msg = t.message
            suffix = ""
            if t.action == "offer" and t.offer:
                suffix = f"  [OFFER: {t.offer.label()}]"
            elif t.action == "accept":
                suffix = "  [ACCEPTED the other side's offer]"
            elif t.action == "walk":
                suffix = "  [WALKED AWAY]"
            lines.append(f"{who}: {msg}{suffix}")
        if closed:
            lines.append("(conversation closed)")
        return "\n".join(lines)

    def prompt(self, k: int, threads: dict, closed: set, notes: list[str]) -> str:
        head = f"Turn {k} of at most {self.max_turns}."
        if self.mode == "broker" and k == 1:
            head += f" Write your RFQ: {BROKER_NAME} sends it to all sellers."
        rows = []
        for s in self.specs:
            st = threads[s.id]
            off = st.standing_offer("seller")
            if s.id in closed:
                status = "closed"
            elif not st.transcript:
                status = "not contacted yet"
            elif off:
                status = off.label()
            else:
                status = "no offer yet"
            rows.append((off.price if off and s.id not in closed else 10**9, f"- {s.name} ({s.id}): {status}"))
        if self.mode == "broker":
            rows.sort(key=lambda r: r[0])
            board = f"{BROKER_NAME} bid board (each seller's standing offer to you, lowest first):\n"
        else:
            board = "Standing offers (each seller's latest offer to you):\n"
        board += "\n".join(r[1] for r in rows)
        convs = "\n\n".join(f"=== {s.name} ({s.id}) ===\n{self._thread_view(s, threads[s.id], s.id in closed)}" for s in self.specs)
        parts = [head]
        if notes:
            parts.append("Note: " + " ".join(notes))
        parts += [board, "Your conversations:\n" + convs, "Your turn."]
        return "\n\n".join(parts)

    def act(self, k: int, threads: dict, closed: set, notes: list[str], usage: llm.Usage) -> tuple[Turn, str, str]:
        reply, _ = llm.complete_json(self.system_prompt(), self.prompt(k, threads, closed, notes), model=self.model, effort=self.effort, usage=usage)
        dummy = NegotiationState(round=k, max_rounds=self.max_turns, product_id=self.persona.target_product, addons=list(self.persona.wants_addons))
        turn = parse_turn("buyer", reply, dummy)
        return turn, str(reply.get("to") or "all").strip(), str(reply.get("why") or "").strip()


def resolve_to(to: str, specs: list[SellerSpec]) -> str | None:
    """A seller id, "all", or None if unresolvable."""
    t = to.strip().lower()
    if t in ("all", "everyone", "*", "all sellers"):
        return "all"
    for s in specs:
        if t == s.id:
            return s.id
    for s in specs:
        if s.id in t or s.name.lower() in t or t in s.name.lower():
            return s.id
    return None


# ---------------------------------------------------------------------------
# The market session
# ---------------------------------------------------------------------------


def card_order(persona_index: int, seed: int = 7070) -> list[SellerSpec]:
    rng = random.Random(seed * 1000 + persona_index)
    order = list(SELLERS)
    rng.shuffle(order)
    return order


def run_market_session(
    persona: BuyerPersona,
    mode: str,
    *,
    persona_index: int,
    max_turns: int = 12,
    model=None,
    effort=None,
    session_id: str | None = None,
    meta: dict | None = None,
) -> dict:
    assert mode in ("direct", "broker")
    sid_ = session_id or uuid.uuid4().hex[:12]
    specs = card_order(persona_index)
    n = len(specs)
    policy = PolicyEngine()
    start = time.monotonic()
    rng = random.Random(f"{sid_}-tiebreak")

    buyer = MarketBuyer(persona, specs, mode, max_turns=max_turns, model=model, effort=effort)
    sellers = {s.id: make_seller(s, mode, n, model=model, effort=effort) for s in specs}
    threads = {
        s.id: NegotiationState(round=0, max_rounds=max_turns, product_id=persona.target_product, addons=list(persona.wants_addons))
        for s in specs
    }
    b_usage = llm.Usage()
    s_usage = {s.id: llm.Usage() for s in specs}
    base_meta = {"experiment": "e7_marketplace", "mode": mode, **(meta or {})}
    outs = {
        s.id: Outcome(
            session_id=sid_, persona_id=persona.id, deal=False, ended_by="not_contacted",
            walk_away=persona.walk_away, feasible=persona.feasible,
            meta={**base_meta, "seller_id": s.id, "kind": s.kind},
        )
        for s in specs
    }
    closed: set[str] = set()
    events: list[dict] = []
    notes: list[str] = []
    result = {"deal": False, "ended_by": "turn_cap", "winner": None}
    error = ""

    def close(offer: Offer, winner: str, ended_by: str, k: int) -> None:
        cost = cost_total(offer.product_id, offer.addons)
        result.update(
            deal=True, ended_by=ended_by, winner=winner, winner_kind=KIND[winner], turn=k,
            product_id=offer.product_id, addons=list(offer.addons), price=offer.price, cost=cost, profit=offer.price - cost,
            list_total=list_total(offer.product_id, offer.addons), floor_total=floor_total(offer.product_id, offer.addons),
            seller_list_total=my_list_total(SPECS[winner], offer.product_id, offer.addons),
            violations_closed=0 if policy.check(offer).approved else 1,
            buyer_overpaid=offer.price > persona.walk_away,
        )
        o = outs[winner]
        o.deal, o.ended_by = True, ended_by
        o.product_id, o.addons, o.price, o.cost, o.profit = offer.product_id, list(offer.addons), offer.price, cost, offer.price - cost
        o.list_total, o.floor_total = result["list_total"], result["floor_total"]
        o.violations_closed, o.buyer_overpaid = result["violations_closed"], result["buyer_overpaid"]
        o.meta["seller_list_total"] = result["seller_list_total"]

    try:
        for k in range(1, max_turns + 1):
            turn, to_raw, why = buyer.act(k, threads, closed, notes, b_usage)
            notes = []
            to = resolve_to(to_raw, specs)
            open_ids = [s.id for s in specs if s.id not in closed]
            if mode == "broker" and k == 1:
                if to != "all":
                    notes.append(f"(Your first message went to all sellers as an RFQ.)")
                to = "all"
                if turn.action in ("accept", "walk"):
                    turn.action, turn.note = "message", "broker RFQ: forced to message"
            if to is None:
                notes.append(f"Your last message named an unknown recipient {to_raw!r}; it was sent to all sellers.")
                to = "all"
            ev = {"k": k, "to_raw": to_raw, "to": to, "why": why, "buyer": turn.to_dict(), "targets": [], "replies": {}}
            events.append(ev)

            # Accept: closes with one seller's standing offer.
            if turn.action == "accept":
                target = to if to != "all" else None
                if target is None:
                    standing = [sid for sid in open_ids if threads[sid].standing_offer("seller")]
                    if turn.offer:
                        match = [sid for sid in standing if threads[sid].standing_offer("seller").price == turn.offer.price]
                        if len(match) == 1:
                            target = match[0]
                    if target is None and len(standing) == 1:
                        target = standing[0]
                offer = threads[target].standing_offer("seller") if target and target not in closed else None
                if offer is not None:
                    ev["targets"] = [target]
                    t = Turn("buyer", turn.message, "accept", None)
                    threads[target].transcript.append(t)
                    close(offer, target, "buyer_accept", k)
                    break
                notes.append("Your accept didn't match a seller's standing offer, so it was delivered as a message.")
                turn.action, turn.note = "message", "accept without a standing offer; treated as a message"

            # Walk: one seller, or the whole search.
            if turn.action == "walk":
                if to == "all":
                    result["ended_by"] = "buyer_walk"
                    for sid in open_ids:
                        threads[sid].transcript.append(Turn("buyer", turn.message, "walk", None, note="to:all"))
                    break
                if to in open_ids:
                    threads[to].transcript.append(Turn("buyer", turn.message, "walk", None))
                    closed.add(to)
                    ev["targets"] = [to]
                if len(closed) == n:
                    result["ended_by"] = "buyer_walk"
                    break
                continue

            # Route the message or offer.
            targets = open_ids if to == "all" else ([to] if to in open_ids else [])
            if not targets:
                notes.append(f"{to} is closed; nothing was sent.")
                continue
            ev["targets"] = targets
            for sid in targets:
                msg = turn.message
                if mode == "broker":
                    if k == 1:
                        msg = f"[{BROKER_NAME} RFQ, sent to all {n} sellers] {msg}"
                    elif to == "all":
                        msg = f"[{BROKER_NAME} relay, sent to all sellers] {msg}"
                    else:
                        msg = f"[{BROKER_NAME} relay, sent only to you] {msg}"
                bt = Turn("buyer", msg, turn.action, turn.offer, note="to:all" if to == "all" else "")
                st = threads[sid]
                st.transcript.append(bt)
                st.round += 1
                outs[sid].rounds = st.round
                if outs[sid].ended_by == "not_contacted":
                    outs[sid].ended_by = "contacted"
                if turn.action == "offer" and turn.offer:
                    st.product_id, st.addons = turn.offer.product_id, list(turn.offer.addons)

            def reply(sid: str) -> Turn:
                return _seller_turn(sellers[sid], threads[sid], s_usage[sid], policy, 2, outs[sid])

            with ThreadPoolExecutor(max_workers=len(targets)) as pool:
                replies = dict(zip(targets, pool.map(reply, targets)))

            acceptors = []
            for sid in targets:
                rt = replies[sid]
                st = threads[sid]
                if rt.action == "accept":
                    if st.standing_offer("buyer") is None:
                        rt.action, rt.note = "message", "accept with no standing buyer offer; treated as a message"
                st.transcript.append(rt)
                ev["replies"][sid] = rt.to_dict()
                if rt.action == "offer" and rt.offer:
                    st.product_id, st.addons = rt.offer.product_id, list(rt.offer.addons)
                    if not policy.check(rt.offer).approved:
                        outs[sid].offers_below_floor_sent += 1
                elif rt.action == "accept":
                    acceptors.append(sid)
                elif rt.action == "walk":
                    closed.add(sid)
            if acceptors:
                winner = rng.choice(sorted(acceptors))
                if len(acceptors) > 1:
                    result["tie_acceptors"] = sorted(acceptors)
                close(threads[winner].standing_offer("buyer"), winner, "seller_accept", k)
                break
            if len(closed) == n:
                result["ended_by"] = "all_sellers_walked"
                break
    except llm.LLMError as e:
        result["ended_by"], error = "error", str(e)

    wall = round(time.monotonic() - start, 2)
    total = llm.Usage()
    total.merge(b_usage)
    for u in s_usage.values():
        total.merge(u)

    for s in specs:
        o = outs[s.id]
        if result["ended_by"] == "error":
            o.ended_by, o.error = "error", error
        elif not o.deal and o.ended_by == "contacted":
            o.ended_by = f"lost_to_{result['winner']}" if result["deal"] else ("closed" if s.id in closed else "no_deal")
        o.usage = s_usage[s.id].as_dict()
        o.wall_s = wall
        o.transcript = [t.to_dict() for t in threads[s.id].transcript]
        o.meta["contacted"] = bool(threads[s.id].transcript)
        o.meta["card_position"] = [x.id for x in specs].index(s.id)
        if isinstance(sellers[s.id], DynamicSeller):
            o.meta["signals"] = sellers[s.id].signal_log

    # A market-level Outcome (buyer's view), so metrics.summarize works on sessions too.
    m = Outcome(
        session_id=sid_, persona_id=persona.id, deal=result["deal"], ended_by=result["ended_by"],
        walk_away=persona.walk_away, feasible=persona.feasible, rounds=len(events),
        usage=total.as_dict(), wall_s=wall, meta={**base_meta, "winner": result.get("winner")}, error=error,
    )
    if result["deal"]:
        for key in ("product_id", "addons", "price", "cost", "profit", "list_total", "floor_total", "violations_closed", "buyer_overpaid"):
            setattr(m, key, result[key])
    m.violations_attempted = sum(o.violations_attempted for o in outs.values())
    m.offers_below_floor_sent = sum(o.offers_below_floor_sent for o in outs.values())

    first = events[0] if events else {}
    return {
        "session_id": sid_,
        "mode": mode,
        "persona": persona.to_dict(),
        "persona_index": persona_index,
        "card_order": [s.id for s in specs],
        **result,
        "first_contact": first.get("to"),
        "first_contact_raw": first.get("to_raw"),
        "first_contact_why": first.get("why"),
        "buyer_turns": len(events),
        "events": events,
        "market": m.to_dict(),
        "sellers": {sid: o.to_dict() for sid, o in outs.items()},
        "usage": {"total": total.as_dict(), "buyer": b_usage.as_dict(), **{sid: u.as_dict() for sid, u in s_usage.items()}},
        "wall_s": wall,
        "error": error,
    }


def render_session(rec: dict) -> str:
    """A readable log of a session, in chronological order."""
    lines = [f"Session {rec['session_id']} mode={rec['mode']} persona={rec['persona']['id']} order={rec['card_order']}"]
    names = {s.id: s.name for s in SELLERS}
    for ev in rec["events"]:
        b = ev["buyer"]
        off = f" [OFFER {b['offer']['product_id']}+{b['offer']['addons']} ${b['offer']['price']:,}]" if b.get("offer") else ""
        lines.append(f"\n[{ev['k']}] BUYER -> {ev['to']} ({b['action']}){off}: {strip_prefix(b['message'])}")
        if ev.get("why"):
            lines.append(f"     (why: {ev['why']})")
        for sid, r in ev["replies"].items():
            off = f" [OFFER {r['offer']['product_id']}+{r['offer']['addons']} ${r['offer']['price']:,}]" if r.get("offer") else ""
            note = f" <{r['note']}>" if r.get("note") else ""
            lines.append(f"     {names[sid]} ({r['action']}){off}: {r['message']}{note}")
    lines.append(f"\nResult: deal={rec['deal']} ended_by={rec['ended_by']} winner={rec.get('winner')} price={rec.get('price')} walk_away={rec['persona']['walk_away']}")
    return "\n".join(lines)
