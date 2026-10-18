# sales-agent

Seller-side negotiating agents for agentic commerce. Start with [CLAUDE.md](./CLAUDE.md), then your `apps/<yours>/BRIEF.md`.

## Research and experiments

Everything we tested before the build lives on this branch's `docs/` and `experiments/` folders:

- [docs/NORTHSTAR.md](docs/NORTHSTAR.md): the problem and what we're building toward
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): layer-by-layer decisions with the experiment evidence behind them
- [docs/experiments/EXPERIMENTS.md](docs/experiments/EXPERIMENTS.md): the assumptions tested (E1–E11) and their verdicts
- [docs/TRACKS.md](docs/TRACKS.md): prize tracks (Armature, Stripe, Manufact) and how each sponsor fits
- [docs/research/](docs/research/): protocol, discovery, payments, and competitor research

The experiment harness is Python (`sales_agent/`, run with `uv sync` then `uv run python scripts/smoke.py`). Model calls go through headless `claude -p` on your Claude login, or the Anthropic SDK if `ANTHROPIC_API_KEY` is set.
