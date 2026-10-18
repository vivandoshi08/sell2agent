# Armature evals (S2, Bridge 3)

Outside, cross-model check of the agent experience: Armature's tester agents (Claude in Claude Code, GPT in Codex) work toward a goal against our **deployed** gateway, and a separate judge scores each run 0–5 (4–5 Passed, 2–3 Partial, 0–1 Failed). S2's done-when: the ready cases score ≥ 4 on both testers.

- Cases: `cases.json` (goal prompt + required and optional criteria). All 7 are ready for the gateway's tools (`search_products`, `get_listing`, `ask_question`, `make_offer`, `accept_deal`, `walk_away`, `check_offers`, `review_deal`, `pay_deal`). `pay-retry-is-safe` and `unanswerable-question` need the deployed gateway to include S1's #34 follow-up and #51; `pay-retry-is-safe` also needs the gateway's Stripe test key.
- Server under test: `https://dark-zero-mesv5.run.mcp-use.com/mcp` (no auth). Update `server.url` if S1 redeploys to a new URL.
- Prices in the cases match the seed catalog: KeyForge Quiet 75 $129, ClackCo TKL Pro $115, TypeWell 65 Silent $139. Floors keep "$120 for a quiet keyboard" feasible (KeyForge) and "$80 for the TypeWell" infeasible.

## Run them
1. A teammate signs in to Armature and asks at the booth (or contact@armature.tech) to **enable Evaluation** on our workspace. It's off by default.
2. Add the MCP server (the URL above, no auth).
3. Create one eval case per entry in `cases.json` with `status: "ready"`: paste `goal` as the prompt, and each `required` / `optional` line as a criterion.
4. Run each case on **Claude Code** and on **Codex**. The free tier allows 1 target per case, so ask for the second target or duplicate the case.
5. Screenshot the results page with all runs (S2's Bridge 3 proof) and note any case under 4.

Armature's testers run in their cloud against the public URL, so this doesn't depend on any of our workspaces' network settings.

## When a case fails
Read the judge's notes and the trace. Most failures are agent-experience fixes in the gateway (S1): tool descriptions, error messages with a fix, or state rules like "send buyer_id back on every call". File them on S1's PR or in docs/live, not here.
