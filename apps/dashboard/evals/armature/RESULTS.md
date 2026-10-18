# Armature results (S2, Bridge 3): all 7 cases pass on both testers

Run Sun Oct 18, 12:35–12:58 am PT in Armature workspace `acommerce` (Ananya), against the **deployed gateway**
`https://dark-zero-mesv5.run.mcp-use.com/mcp` (no auth, 9 tools). Testers: **Claude Code (Claude Sonnet 5)** and
**Codex (GPT-5.6 Terra)**. Cases are `cases.json` verbatim (goal = instructions, required = success criteria).

| Case | Claude Code | Codex |
|---|---|---|
| find-by-need | Passed | Passed |
| negotiate-and-accept-under-budget | Passed | Passed |
| infeasible-budget | Passed | Passed |
| read-state-without-changes | Passed | Passed |
| pay-retry-is-safe (real Stripe test charge, retry not charged again) | Passed | Passed |
| unanswerable-question | Passed (re-run) | Passed |
| recover-from-stale-offer | Passed (re-run) | Passed (re-run) |

**First-pass Partials, both explained:**
- `recover-from-stale-offer`, both testers: the seller's very first counter was already **final** ($112), so no offer
  could be superseded. Cause: testers send no user id, so they get `anon_` ids that share E1's buyer memory per
  product, and earlier anonymous traffic had frozen it. Passed on both after Vivan ran `anon:reset --all`.
  **Demo risk:** any client without a user id can hit this again; reset before the demo (E1 runbook).
- `unanswerable-question`, Claude Code: the agent answered correctly ("seller doesn't know"), but Armature's judge
  returned no verdict. A re-run passed.

**Re-running:** run the anonymous negotiation cases one target at a time. Both testers share the `anon` bucket, so
running them in parallel can freeze each other's offers.
