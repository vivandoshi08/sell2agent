// Build check: the gateway bundle must carry learned_policy.json inline (rolldown inlines the static JSON import in
// seller-mcp/src/exchange/learned.ts). A runtime path (import.meta.dirname) pointed at apps/marketplace/ on Manufact,
// so every `learned` negotiation fell back to negotiating. Run after `pnpm build`:  node scripts/check-learned-bundle.mjs
import { readFileSync } from "node:fs";

const bundle = readFileSync(new URL("../.mcp-use/build/index.js", import.meta.url), "utf8");
const policy = JSON.parse(readFileSync(new URL("../../seller-mcp/learned_policy.json", import.meta.url), "utf8"));
const fail = (m) => { console.error(`check-learned-bundle: FAIL ${m}`); process.exit(1); };

const m = bundle.match(/var (learned_policy_default\w*) = \{/);
if (!m) fail("no inlined learned_policy.json object in .mcp-use/build/index.js (static JSON import missing?)");
if (!bundle.includes(`if (!file) return checkLearnedPolicy(${m[1]});`)) fail("readLearnedPolicy's default path doesn't use the inlined policy");
const start = bundle.indexOf(`var ${m[1]} = {`);
const inlined = bundle.slice(start, start + 200_000);
if (!new RegExp(`\\bversion: ${policy.version},`).test(inlined)) fail(`inlined policy isn't v${policy.version} (rebuild after retraining)`);
if (policy.gate?.source && !inlined.includes(JSON.stringify(policy.gate.source))) fail("inlined gate doesn't match the committed file");
for (const [ctx, arm] of Object.entries(policy.choice)) if (!new RegExp(`"?${ctx}"?: "${arm}"`).test(inlined)) fail(`inlined choice ${ctx} → ${arm} missing`);
console.log(`check-learned-bundle: OK, gateway bundle inlines learned_policy v${policy.version} (gate passed = ${policy.gate?.passed}, choices ${JSON.stringify(policy.choice)})`);
