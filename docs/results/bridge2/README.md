# Bridge 2 run: 200 real-Claude negotiations (Sat Oct 18, 12:09 am PT)

`pnpm --filter @sa/dashboard eval --n 100 --models claude --seller-voice --concurrency 8 --seed 42 --id bridge2_claude_100`

- 100 Claude buyers (`claude-sonnet-5-5`) per seller policy, the same buyers for both: 5 personas + 10% red team.
- Through E1's real exchange (in-process: offer ids, guardrails, `max_rounds: 6`), with E2's `decide()`/`voice()`. Claude writes every seller message.
- Run from a cloud workspace, which can't reach the deployed gateway or OpenAI (policy 403), so these are Claude buyers only.

| Policy | Bought | Profit per buyer (95% CI) | Unsafe deals |
| --- | --- | --- | --- |
| static | 49% [40–59%] | $31.61 [$25.52–$38.11] | 0 |
| **negotiating** | **83% [76–90%]** | **$47.55 [$43.25–$51.55]** | **0** |

0 of 132 deals broke a seller rule. 45 unsafe moves were blocked in code. Persona checks: 12/12 PASS (`personas.txt`).

**View it:** copy both `bridge2_claude_100.*` files to `apps/dashboard/public/runs/`, write `latest.json` (see `apps/dashboard/public/runs/latest.json` format), then run `pnpm --filter @sa/dashboard preview:html:eval` and open `apps/dashboard/dist/preview.html`. Or use `pnpm dev:dashboard` with `?local`.
