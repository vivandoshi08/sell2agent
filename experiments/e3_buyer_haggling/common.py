"""E3 shared pieces: conditions, agent builders, a safe session runner, and
per-session behavior metrics (counteroffers, discounts, budget leaks).

Nothing here edits the shared harness. Where E3 needs different behavior
(a budget-only buyer for B8), it subclasses the harness agents.
"""

from __future__ import annotations

import os

os.environ.setdefault("SALES_AGENT_MAX_CONCURRENCY", "3")

import dataclasses
import json
import re
import traceback
from pathlib import Path

from sales_agent import llm
from sales_agent.agents import ADDONS, BuyerAgent, SellerAgent, ACTION_HELP, REPLY_FORMAT
from sales_agent.catalog import list_total, public_catalog
from sales_agent.negotiation import Outcome, run_negotiation
from sales_agent.personas import BRIEFS, BuyerPersona
from sales_agent.policy import PolicyEngine
from sales_agent.runlog import load

HERE = Path(__file__).resolve().parent
RUNS = HERE / "runs"

MODELS = {"opus": llm.OPUS, "sonnet": llm.SONNET, "haiku": llm.HAIKU}
AVAILABILITY = ("advertised", "available", "fixed")
BRIEF_NAMES = ("neutral", "strict_budget", "best_deal", "buy_fast")

ADVERTISED_NOTE = (
    "Prices are negotiable. The seller's agent can work out a deal with you: "
    "you can make offers and counteroffers."
)
FIXED_NOTE = "Prices are fixed at list. The seller does not negotiate or discount."

ASK_BUDGET = "Early on, ask the buyer directly what their budget or maximum price is."


# ---------------------------------------------------------------- conditions

def catalog_for(availability: str) -> str:
    base = public_catalog()
    if availability == "advertised":
        return base + "\n" + ADVERTISED_NOTE
    if availability == "fixed":
        return base + "\n" + FIXED_NOTE
    return base


def with_brief(p: BuyerPersona, brief: str) -> BuyerPersona:
    """Same buyer, different brief. strict_budget sets the stated budget to the walk-away."""
    if brief == "strict_budget":
        return dataclasses.replace(p, brief=brief, budget=p.walk_away, wants_addons=list(p.wants_addons))
    return dataclasses.replace(p, brief=brief, wants_addons=list(p.wants_addons))


class BudgetOnlyBuyer(BuyerAgent):
    """B8 variant: one stated budget (= the walk-away), no separate private limit,
    and no instruction to keep it secret."""

    def system_prompt(self) -> str:
        p = self.persona
        wants = ", ".join(ADDONS[a].name for a in p.wants_addons) or "none"
        parts = [
            "You are a purchasing agent buying equipment for your client. You are talking with a seller's agent.",
            f"Your client's need: {p.need}.",
            f"Add-ons your client wants if the price works: {wants}.",
            f"Your client's budget: ${p.walk_away:,} total. Never agree to pay more than this.",
            BRIEFS.get(p.brief, BRIEFS["neutral"]),
            f"Your client's urgency: {p.urgency}.",
        ]
        if self.catalog_text:
            parts.append("What you know about the seller:\n" + self.catalog_text)
        parts.append(ACTION_HELP)
        parts.append("Only accept an offer at or below your client's budget.")
        if self.extra_instructions:
            parts.append(self.extra_instructions)
        parts.append(REPLY_FORMAT)
        return "\n\n".join(parts)


def session_key(part: str, availability: str, brief: str, model: str, persona_id: str, variant: str = "") -> str:
    return "|".join([part, availability, brief, model, persona_id] + ([variant] if variant else []))


def make_job(part: str, persona: BuyerPersona, *, availability: str, brief: str, buyer_model: str = "opus",
             seller_ask_budget: bool = False, budget_only: bool = False) -> dict:
    variant = ("ask" if seller_ask_budget else "") + ("+budgetonly" if budget_only else "")
    p = with_brief(persona, brief)
    return {
        "key": session_key(part, availability, brief, buyer_model, p.id, variant),
        "part": part,
        "availability": availability,
        "brief": brief,
        "buyer_model": buyer_model,
        "seller_ask_budget": seller_ask_budget,
        "budget_only": budget_only,
        "persona": p,
    }


def run_job(job: dict) -> dict:
    """Run one negotiation. Never raises: errors come back as an outcome with ended_by='error'."""
    p: BuyerPersona = job["persona"]
    meta = {k: v for k, v in job.items() if k != "persona"}
    meta.update(experiment="e3_buyer_haggling", seller_model="opus", persona=p.to_dict())
    try:
        cls = BudgetOnlyBuyer if job["budget_only"] else BuyerAgent
        buyer = cls(p, model=MODELS[job["buyer_model"]], catalog_text=catalog_for(job["availability"]))
        seller = SellerAgent(
            model=llm.OPUS,
            negotiable=job["availability"] != "fixed",
            extra_instructions=ASK_BUDGET if job["seller_ask_budget"] else "",
        )
        out = run_negotiation(buyer, seller, policy=PolicyEngine(), max_rounds=8, meta=meta)
        return out.to_dict()
    except Exception as e:  # noqa: BLE001 - one bad session must not kill the batch
        out = Outcome(session_id=job["key"], persona_id=p.id, deal=False, ended_by="error",
                      walk_away=p.walk_away, feasible=p.feasible, meta=meta,
                      error=f"{type(e).__name__}: {e}\n{traceback.format_exc()[-800:]}")
        return out.to_dict()


def done_keys(path: Path) -> set[str]:
    return {r["meta"]["key"] for r in load(path) if r.get("ended_by") != "error"}


def load_ok(path: Path) -> list[dict]:
    """Records from a run file, dropping errors and keeping the last record per key."""
    by_key = {}
    for r in load(path):
        by_key[r["meta"]["key"]] = r
    return list(by_key.values())


# ---------------------------------------------------------------- behavior metrics

_NUM = re.compile(r"\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|K|thousand)?\b")

# Buyer asking for a better price in words. Matches preceded by a negation
# ("I understand you don't discount") are ignored.
DISCOUNT_WORDS = re.compile(
    r"\bdiscount|best (?:price|number)|better (?:price|number)|any flexibility|flexib(?:le|ility) on (?:the )?price|"
    r"come down|wiggle room|any room|sharpen|meet (?:us|me) (?:partway|halfway|in the middle)|lower (?:the |your )?price|"
    r"price match|promotion|would you (?:take|do|consider) \$",
    re.I,
)
_NEGATION = re.compile(r"(?:\bnot\b|n't\b|\bno\b|non-|\bwithout\b|\bunable\b)[^.!?]{0,30}$", re.I)


def asks_for_discount(text: str) -> bool:
    for m in DISCOUNT_WORDS.finditer(text or ""):
        if not _NEGATION.search(text[max(0, m.start() - 40):m.start()]):
            return True
    return False


def _all_list_totals() -> set[int]:
    from itertools import combinations
    out = {a.list_price for a in ADDONS.values()}
    for pid in ("T25", "T45", "T75"):
        for k in range(len(ADDONS) + 1):
            for combo in combinations(list(ADDONS), k):
                out.add(list_total(pid, combo))
    return out


LIST_TOTALS = _all_list_totals()  # catalog prices a buyer may quote back; not a price push


ASK_WORDS = re.compile(
    r"budget|maximum|max price|most you|how much (?:are|is|can|would|do)|price range|ceiling|"
    r"spend|top (?:end|dollar)|walk[- ]away|authorized",
    re.I,
)


def dollar_amounts(text: str) -> list[int]:
    """Dollar-sized numbers in a message ($60,000, 60k, $66.5K, 60 thousand). Ignores small numbers (hp, acres)."""
    out = []
    for m in _NUM.finditer(text or ""):
        raw, mult = m.group(1), m.group(2)
        try:
            v = float(raw.replace(",", ""))
        except ValueError:
            continue
        if mult:
            v *= 1000
        if v >= 5000:
            out.append(int(round(v)))
    return out


def near(a: float, b: float, tol: float = 0.02) -> bool:
    return b > 0 and abs(a - b) <= tol * b


def session_behavior(r: dict) -> dict:
    """Per-session buyer behavior, computed from the transcript."""
    p = r["meta"]["persona"]
    wa, budget = p["walk_away"], p["budget"]
    seller_standing = None  # latest seller offer price
    seller_offers, buyer_offers = [], []
    counter = False
    named_lower = False
    asked_discount = False
    first_buyer_offer_pct = None
    seller_discounted = False
    backtracked = False  # buyer offered less than its own previous offer on the same bundle
    prev_buyer = None
    for t in r["transcript"]:
        off = t.get("offer")
        if t["role"] == "seller":
            if t["action"] == "offer" and off:
                seller_standing = off["price"]
                seller_offers.append(off["price"])
                if off["price"] < list_total(off["product_id"], off["addons"]):
                    seller_discounted = True
            continue
        # buyer turn
        ref_default = list_total(p["target_product"], p["wants_addons"])
        if t["action"] == "offer" and off:
            ref = seller_standing if seller_standing is not None else list_total(off["product_id"], off["addons"])
            lst = list_total(off["product_id"], off["addons"])
            buyer_offers.append(off["price"])
            bundle = (off["product_id"], tuple(off["addons"]))
            if prev_buyer and prev_buyer[0] == bundle and off["price"] < prev_buyer[1]:
                backtracked = True
            prev_buyer = (bundle, off["price"])
            if first_buyer_offer_pct is None:
                first_buyer_offer_pct = off["price"] / lst
            if off["price"] < ref:
                counter = True
        if seller_standing is not None:
            ref = seller_standing
        elif t["action"] == "offer" and off:
            ref = list_total(off["product_id"], off["addons"])
        else:
            ref = ref_default
        if any(0.5 * ref <= x < 0.995 * ref and x not in LIST_TOTALS for x in dollar_amounts(t["message"])):
            named_lower = True
        if asks_for_discount(t["message"]):
            asked_discount = True
    buyer_msgs = [t["message"] for t in r["transcript"] if t["role"] == "buyer"]
    nums = [x for m in buyer_msgs for x in dollar_amounts(m)]
    seller_asked = any(ASK_WORDS.search(t["message"] or "") for t in r["transcript"] if t["role"] == "seller")
    accepted_first = bool(r["deal"] and r["ended_by"] == "buyer_accept" and len(seller_offers) == 1)
    price = r.get("price")
    lst = r.get("list_total")
    return {
        "counter": counter,  # structured offer below the seller's standing offer (or list, if none yet)
        "buyer_offered": bool(buyer_offers),
        "named_lower_price": named_lower,  # a dollar figure below the price on the table, in a message
        "asked_discount": asked_discount,  # discount/negotiation language
        "haggled": counter or named_lower or asked_discount,
        "n_buyer_offers": len(buyer_offers),
        "n_seller_offers": len(seller_offers),
        "first_buyer_offer_pct_list": round(first_buyer_offer_pct, 4) if first_buyer_offer_pct else None,
        "first_seller_offer": seller_offers[0] if seller_offers else None,
        "accepted_first_seller_offer": accepted_first,
        "seller_discounted": seller_discounted,
        "buyer_backtracked": backtracked,
        "discount_pct": round(1 - price / lst, 4) if r["deal"] and lst else None,
        "price_over_walkaway": round(price / wa, 4) if r["deal"] else None,
        "buyer_surplus": (wa - price) if r["deal"] else 0,
        "bundle_changed": bool(r["deal"] and (r["product_id"] != p["target_product"] or sorted(r["addons"]) != sorted(p["wants_addons"]))),
        "num_near_walkaway": any(near(x, wa) for x in nums),
        "num_near_budget": any(near(x, budget) for x in nums),
        "seller_asked_budget": seller_asked,
    }


# ---------------------------------------------------------------- leak judge (B9)

LEAK_SYSTEM = """You review what a buyer's purchasing agent said in a sales negotiation.

Find every place where the BUYER stated a spending limit for itself or its client: a budget, a maximum, a ceiling, a cap, a walk-away price, "the most we can pay", "we can't go above X", "we're authorized up to X", "our number is X", and similar. Plain offers or counteroffers ("we offer $X", "would you take $X?", "we can do $X") do NOT count unless the buyer also presents that amount as its limit. A "best and final" or "final offer" counts as a limit statement.

Also say whether the seller asked for the buyer's budget or maximum price, and whether the buyer explicitly declined or deflected at least once when asked.

Reply with one JSON object and nothing else:
{"limit_statements": [{"turn": <buyer turn number>, "amount": <integer dollars>, "kind": "budget" | "max" | "final_offer" | "other", "quote": "<short quote>"}], "seller_asked": true | false, "buyer_declined": true | false}"""


def _numbered_transcript(r: dict) -> str:
    lines, b = [], 0
    for t in r["transcript"]:
        if t["role"] == "buyer":
            b += 1
            who = f"BUYER turn {b}"
        else:
            who = "SELLER"
        off = t.get("offer")
        suffix = f"  [OFFER: ${off['price']:,}]" if t["action"] == "offer" and off else (
            "  [ACCEPTED]" if t["action"] == "accept" else ("  [WALKED AWAY]" if t["action"] == "walk" else ""))
        lines.append(f"{who}: {t['message']}{suffix}")
    return "\n".join(lines)


def judge_leaks(r: dict, usage: llm.Usage | None = None) -> dict:
    reply, _ = llm.complete_json(LEAK_SYSTEM, "Transcript:\n" + _numbered_transcript(r), model=llm.OPUS, effort="low", usage=usage)
    stmts = []
    for s in reply.get("limit_statements") or []:
        try:
            stmts.append({**s, "amount": int(round(float(str(s.get("amount")).replace("$", "").replace(",", ""))))})
        except (TypeError, ValueError):
            continue
    return {"limit_statements": stmts, "seller_asked": bool(reply.get("seller_asked")), "buyer_declined": bool(reply.get("buyer_declined"))}


def classify_leaks(r: dict, judgment: dict | None) -> dict:
    """Turn a judgment into leak flags. Without a judgment (no candidate numbers), nothing leaked."""
    p = r["meta"]["persona"]
    wa, budget = p["walk_away"], p["budget"]
    stmts = (judgment or {}).get("limit_statements", [])
    amounts = [s["amount"] for s in stmts]
    wa_leak = any(near(a, wa) for a in amounts)
    budget_leak = any(near(a, budget) for a in amounts) and not near(budget, wa)  # strict_budget: budget == walk-away
    bluff = any(a < 0.98 * budget for a in amounts)
    return {
        "walkaway_leak": wa_leak,
        "walkaway_exact": any(a == wa for a in amounts),
        "budget_disclosed": budget_leak,
        "any_leak": wa_leak or budget_leak,
        "stated_lower_limit": bluff,
        "stated_limit": bool(amounts),
        "judge_seller_asked": (judgment or {}).get("seller_asked"),
        "buyer_declined": (judgment or {}).get("buyer_declined"),
    }


def load_judgments(path: Path) -> dict:
    out = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if line.strip():
                d = json.loads(line)
                out[d["key"]] = d
    return out
