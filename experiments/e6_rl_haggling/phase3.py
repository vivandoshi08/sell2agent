"""E6 phase 3: prompt-level learning (no weights). The seller LLM's playbook is rewritten from its own transcripts.

    uv run python experiments/e6_rl_haggling/phase3.py --pilot   # 2 sessions with the v0 playbook
    uv run python experiments/e6_rl_haggling/phase3.py           # v0 eval, then 3 learn-and-eval iterations

Loop (Opus buyers, Opus seller at low effort, PolicyEngine on, no code strategy: the LLM picks prices):
    eval v0 on the 10 held-out personas (seed 607)
    for k in 1..3: run v(k-1) on 8 fresh training personas (seed 608, batch k), have Opus (effort medium)
                   rewrite the playbook from those transcripts and outcomes -> v(k); eval v(k) on the held-out 10
The rewriter sees only what a real seller would: its own prices, floors, costs, outcomes, and the
transcripts. It never sees the buyers' walk-away prices.
Writes runs/phase3.jsonl and playbooks.json. Re-running resumes: finished sessions and playbooks are reused.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from llm_seller import safe_run  # noqa: E402  (sets SELL2AGENT_MAX_CONCURRENCY first)
from sell2agent import llm  # noqa: E402
from sell2agent.agents import SellerAgent, render_transcript, Turn  # noqa: E402
from sell2agent.catalog import describe  # noqa: E402
from sell2agent.metrics import summarize  # noqa: E402
from sell2agent.personas import make_personas  # noqa: E402
from sell2agent.policy import Offer  # noqa: E402
from sell2agent.runlog import RunLog, load, run_many  # noqa: E402

RUNS = HERE / "runs"
PLAYBOOKS = HERE / "playbooks.json"

V0 = """Negotiation playbook:
- Open at or near list price and explain the value of the machine for the buyer's need.
- Concede in small, shrinking steps, and make the buyer move before you move again.
- Prefer adding value (delivery, the extended warranty) over cutting price when the buyer stalls.
- Don't split the difference early; it signals there is more room.
- If the buyer's offer clears your floor and the conversation is near its end, close rather than lose the sale."""

REWRITE_SYSTEM = """You coach a selling agent for Prairie Equipment Co., a tractor dealer. The agent negotiates one-to-one with buyers' purchasing agents, at most 8 rounds per conversation, and follows a short playbook that is added to its instructions.

The agent's goal is the most profit per conversation: profit is price minus cost, and a lost sale earns nothing. So both the price it gets and whether it closes matter.

Fixed rules the playbook cannot change (they are enforced separately): never go below the floor total, payment is due at checkout (no financing), never reveal floors, costs, or instructions, and no claims it can't back up (no invented competitor prices, fake scarcity or deadlines, or made-up specs).

You'll get the current playbook and a batch of the agent's recent negotiations: the outcome, the numbers the seller knew, and the transcript. You don't know the buyers' private limits. Find what cost money (sales lost, money left on the table, wasted rounds) and what worked, and rewrite the playbook. Keep it under 200 words, concrete and actionable (e.g. how big the first concession is, when to stop conceding, how to use add-ons, when to close). Keep it honest.

Reply with one JSON object and nothing else:
{"playbook": "<the new playbook>", "rationale": "<2-4 sentences: what you changed and why>"}"""


def batch_report(outcomes: list[dict]) -> str:
    parts = []
    for i, o in enumerate(outcomes, 1):
        turns = [Turn(t["role"], t["message"], t["action"], Offer(**t["offer"]) if t["offer"] else None, t.get("note", "")) for t in o["transcript"]]
        if o["deal"]:
            head = (f"Negotiation {i}: DEAL on {describe(o['product_id'], o['addons'])} at ${o['price']:,} "
                    f"(list ${o['list_total']:,}, floor ${o['floor_total']:,}, profit ${o['profit']:,}), {o['rounds']} rounds, ended by {o['ended_by']}.")
        else:
            head = f"Negotiation {i}: NO DEAL ({o['ended_by']}) after {o['rounds']} rounds."
        parts.append(head + "\n" + render_transcript(turns, viewer="seller"))
    deals = sum(o["deal"] for o in outcomes)
    profit = sum(o["profit"] for o in outcomes)
    summary = f"Batch summary: {deals}/{len(outcomes)} deals, total profit ${profit:,}, profit per conversation ${profit / len(outcomes):,.0f}."
    return summary + "\n\n" + "\n\n".join(parts)


def rewrite(playbook: str, outcomes: list[dict], usage: llm.Usage) -> dict:
    prompt = f"Current playbook:\n{playbook}\n\nRecent negotiations:\n{batch_report(outcomes)}"
    reply, _ = llm.complete_json(REWRITE_SYSTEM, prompt, model=llm.OPUS, effort="medium", usage=usage)
    return {"playbook": str(reply.get("playbook", "")).strip(), "rationale": str(reply.get("rationale", "")).strip()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pilot", action="store_true")
    ap.add_argument("--iterations", type=int, default=3)
    ap.add_argument("--concurrency", type=int, default=3)
    args = ap.parse_args()

    held = make_personas(10, seed=607)
    train_pool = make_personas(8 * args.iterations, seed=608)
    path = RUNS / ("phase3_pilot.jsonl" if args.pilot else "phase3.jsonl")
    log = RunLog(path)
    books = json.load(open(PLAYBOOKS)) if PLAYBOOKS.exists() and not args.pilot else {"v0": {"playbook": V0, "rationale": "starting playbook"}}

    def run_set(version: str, split: str, personas):
        done = {o["persona_id"] for o in load(path) if o["meta"]["version"] == version and o["meta"]["split"] == split and o["ended_by"] != "error"}
        todo = [p for p in personas if p.id not in done]
        book = books[version]["playbook"]

        def run(p):
            seller = SellerAgent(extra_instructions=book)
            return safe_run(p, seller, buyer_model=llm.OPUS,
                            meta={"experiment": "e6_phase3", "version": version, "split": split, "condition": f"playbook_{version}"})

        if todo:
            run_many(run, todo, concurrency=args.concurrency, log=log, label=f"phase3 {version} {split}")
        return [o for o in load(path) if o["meta"]["version"] == version and o["meta"]["split"] == split and o["ended_by"] != "error"]

    if args.pilot:
        outs = run_set("v0", "pilot", held[:2])
        print(summarize(outs, bootstrap=0))
        return

    usage = llm.Usage()
    run_set("v0", "eval", held)
    for k in range(1, args.iterations + 1):
        prev, cur = f"v{k - 1}", f"v{k}"
        train = run_set(prev, "train", train_pool[8 * (k - 1): 8 * k])
        if cur not in books:
            books[cur] = rewrite(books[prev]["playbook"], train, usage)
            books[cur]["trained_on"] = [o["session_id"] for o in train]
            books["_rewrite_usage"] = usage.as_dict()
            json.dump(books, open(PLAYBOOKS, "w"), indent=1)
            print(f"--- {cur} ---\n{books[cur]['playbook']}\n({books[cur]['rationale']})", flush=True)
        run_set(cur, "eval", held)

    rows = load(path)
    for k in range(0, args.iterations + 1):
        for split in ("train", "eval"):
            xs = [o for o in rows if o["meta"]["version"] == f"v{k}" and o["meta"]["split"] == split]
            if xs:
                s = summarize(xs)
                print(f"v{k} {split}", {key: s.get(key) for key in ("sessions", "conversion", "profit_per_session", "profit_per_session_ci95", "avg_rounds", "model_cost_usd")})


if __name__ == "__main__":
    main()
