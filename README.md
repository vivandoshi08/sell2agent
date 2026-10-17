# sales-agent

A selling agent that represents a merchant to AI buying agents: it presents the product in a form agents can use, negotiates for the seller, and closes the deal.

- [docs/NORTHSTAR.md](docs/NORTHSTAR.md): the problem and what we're building toward
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the setup our experiments assume
- [docs/experiments/EXPERIMENTS.md](docs/experiments/EXPERIMENTS.md): the assumptions we're testing and the experiments that test them
- [docs/experiments/OPEN_QUESTIONS.md](docs/experiments/OPEN_QUESTIONS.md): everything we don't know yet

## Layout

```
sales_agent/      shared harness (E0): catalog, personas, policy engine, agents, negotiation loop, metrics
experiments/      one folder per experiment, each with code, runs/, results.json, README.md
docs/research/    online research (E8)
scripts/          smoke test and the lock-safe commit helper
```

## Running

Model calls go through headless `claude -p` on your Claude login, so no API key is needed. If `ANTHROPIC_API_KEY` is set, the harness uses the Anthropic SDK instead.

```bash
uv sync
uv run python scripts/smoke.py
```

Settings: `SALES_AGENT_MODEL` (default `claude-opus-5-5`), `SALES_AGENT_EFFORT` (default `low`), `SALES_AGENT_MAX_CONCURRENCY` (default `4`).
