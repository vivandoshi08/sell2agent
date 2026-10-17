"""E0 smoke test: one tractor negotiation, end to end, with every KPI logged.

    uv run python scripts/smoke.py [--model claude-opus-5-5] [--seed 0] [--index 0]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from sales_agent import llm
from sales_agent.agents import BuyerAgent, SellerAgent, render_transcript, Turn
from sales_agent.metrics import summarize
from sales_agent.negotiation import run_negotiation
from sales_agent.personas import make_personas
from sales_agent.policy import Offer, PolicyEngine
from sales_agent.runlog import RunLog


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=llm.DEFAULT_MODEL)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--index", type=int, default=0, help="which persona from the seeded list")
    args = ap.parse_args()

    personas = make_personas(max(args.index + 1, 5), seed=args.seed)
    persona = personas[args.index]
    print("Persona:", json.dumps(persona.to_dict(), indent=2))

    out = run_negotiation(
        BuyerAgent(persona, model=args.model),
        SellerAgent(model=args.model),
        policy=PolicyEngine(),
        meta={"experiment": "e0_smoke", "model": args.model},
    )
    turns = [Turn(t["role"], t["message"], t["action"], Offer(**t["offer"]) if t["offer"] else None, t["note"]) for t in out.transcript]
    print("\nTranscript:\n" + render_transcript(turns, viewer="none"))
    print(f"\nEnded by: {out.ended_by}  deal={out.deal}  price={out.price}  profit={out.profit}  error={out.error!r}")
    print("Summary:", json.dumps(summarize([out], bootstrap=0), indent=2))
    RunLog(Path(__file__).resolve().parent.parent / "experiments/e0_smoke/runs/smoke.jsonl").write(out)


if __name__ == "__main__":
    main()
