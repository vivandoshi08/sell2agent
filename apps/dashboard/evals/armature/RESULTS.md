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

## Cross-check against our own server log (Oct 18, after the run)

The gateway's `events` rows (`run_id = live`, 12:30–1:05 am PT) line up with the cases: the $100 → $110 stale-offer
pattern, two $80 TypeWell walk-aways at the seller's $117 final, $105 ClackCo offers, one `payment_succeeded` per
paid deal (no double charge), and an `anon_intruder` pay attempt refused with `wrong_buyer`. Testers send no
`buyer_model`, so the log can't tell Claude Code runs from Codex runs; per-target verdicts come from Armature.

**Found, which the eval passed anyway:** `ask_question` matched words from the product's own name as catalog fields.
"Is the TypeWell 65 Silent waterproof?" hit `switch` via "Silent" and came back `grounded: true` with the switch
spec. The testers only got the honest "I don't know" after re-asking with the bare word ("waterproof"). Titles with
"Quiet" or "TKL" had the same problem. Fixed in `apps/seller-mcp/src/sellers/answers.ts` (`withoutTitle`): runs of
2+ title words are dropped before matching. Re-run `unanswerable-question` after the gateway redeploys.

## Re-run on production main `fbd0186` (Oct 18, 8:03 am PT)

After the 7:52 am deploy (#101–#106, including the `ask_question` fix). 7 cases × Claude Code (Sonnet 5) + Codex
(GPT-5.6 Terra), plus one extra Codex `infeasible-budget` run: **13 Passed, 2 Partial, 0 Failed.**
`unanswerable-question` passed on both testers, so the `withoutTitle` fix holds on production.

Neither Partial is a gateway problem:
- `find-by-need` / Claude Code, 3/5: the case was stale. It recommended the Keychron K2 ($40, quiet, wireless,
  ranked first by search), which the criterion didn't list because that listing was added after the case was written.
  `cases.json` now accepts it; update the same criterion in Armature.
- `infeasible-budget` / Codex, 3/5: the judge thought the agent looped because the trace view hid some calls. The
  trace has exactly 6 `make_offer` calls (the limit), then a walk-away at the seller's final $112 with the right explanation.

The local Claude dry-run (`armature:dryrun`) against the same build scored `infeasible-budget` 2/5. Search with
`max_price_cents: 8000` hid the TypeWell, so the tester never asked its seller. #107 makes search name the
over-budget product (dry-run 5/5 ×3 on the branch).
