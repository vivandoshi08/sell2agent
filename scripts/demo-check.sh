#!/usr/bin/env bash
# Pre-demo check (docs/DEMO.md): is the live system ready, without changing anything that matters.
#
#   scripts/demo-check.sh                 read-only checks against the deployed gateway
#   scripts/demo-check.sh --reset         also clear leftover anonymous/ChatGPT buyer memory (anon:reset --all)
#   scripts/demo-check.sh --runs 2        run the whole check twice in a row (Bridge 3: "demo runs twice with no manual fix")
#   scripts/demo-check.sh --pay           verify-prod also makes one Stripe TEST payment (and a retry that must not charge)
#   scripts/demo-check.sh --open          open the dashboard in the browser
#   scripts/demo-check.sh --gateway URL   check another gateway (default: production)
#
# What it never does: redeploy (that is a manual step, see docs/DEMO.md), delete data, or touch live buyers.
# verify-prod.mjs uses its own buyer id and run_id "s1-test-verify", which the dashboard hides.
# Memory is only cleared when you pass --reset; without it the script just reports frozen memory.
# Exit code: 0 when nothing FAILed (warnings are fine), 1 otherwise.
# Needs: node 22+, curl. Optional: .env with SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.

set -u

GATEWAY="https://dark-zero-mesv5.run.mcp-use.com/mcp"
DASHBOARD="http://localhost:3000"
PNPM="${PNPM:-npx -y pnpm@9.12.0}"
RESET=0; PAY=0; OPEN=0; RUNS=1

while [ $# -gt 0 ]; do
  case "$1" in
    --reset) RESET=1 ;;
    --pay) PAY=1 ;;
    --open) OPEN=1 ;;
    --runs) [ $# -gt 1 ] && { shift; RUNS="$1"; } ;;
    --gateway) [ $# -gt 1 ] && { shift; GATEWAY="$1"; } ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
case "$RUNS" in ''|*[!0-9]*|0) echo "--runs needs a positive number" >&2; exit 2 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORIGIN="$(printf '%s' "$GATEWAY" | sed -E 's#^(https?://[^/]+).*#\1#')"

if [ -t 1 ]; then G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; Z=$'\033[0m'; else G=""; Y=""; R=""; D=""; Z=""; fi
PASS=0; WARN=0; FAIL=0
pass() { PASS=$((PASS+1)); printf '  %sPASS%s %s\n' "$G" "$Z" "$1"; }
warn() { WARN=$((WARN+1)); printf '  %sWARN%s %s\n' "$Y" "$Z" "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  %sFAIL%s %s\n' "$R" "$Z" "$1"; }
note() { printf '       %s%s%s\n' "$D" "$1" "$Z"; }
indent() { sed 's/^/       /'; }

# Read one KEY=value from .env without sourcing it (values may contain odd characters). Never printed.
# Looks in the repo root, then in the main checkout (a git worktree has no .env of its own).
envval() {
  local f v common
  common="$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd)"
  for f in "$ROOT/.env" "$common/../.env"; do
    [ -f "$f" ] || continue
    v="$(grep -E "^$1=" "$f" | tail -n1 | cut -d= -f2-)"
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    [ -n "$v" ] && { printf '%s' "$v"; return 0; }
  done
  return 1
}
for k in SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY; do
  if [ -z "${!k:-}" ]; then v="$(envval "$k")" && export "$k=$v"; fi
done

# JSON-RPC over the streamable HTTP endpoint; prints the JSON body (handles an SSE reply).
rpc() {
  local params="${2:-}"; [ -n "$params" ] || params='{}'
  curl -sS --max-time 20 -X POST "$GATEWAY" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$params}" 2>&1 \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=s.trim();const l=t.startsWith("{")?t:(t.split("\n").filter(x=>x.startsWith("data:")).pop()||"").slice(5);process.stdout.write(l||t)})'
}

check_gateway() {
  echo "1. Gateway ($GATEWAY)"
  local out line rc
  out="$(rpc tools/list)"
  line="$(OUT="$out" node -e '
    let m; try { m = JSON.parse(process.env.OUT); } catch { console.log("BAD " + process.env.OUT.slice(0, 160)); process.exit(1); }
    const names = (m.result?.tools ?? []).map(t => t.name).sort();
    const want = ["accept_deal","ask_question","check_offers","get_listing","make_offer","pay_deal","review_deal","search_products","walk_away"];
    const missing = want.filter(n => !names.includes(n));
    console.log(missing.length ? "MISSING " + missing.join(", ") : "OK " + names.length + " tools: " + names.join(", "));
    process.exit(missing.length ? 1 : 0);' 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then pass "tools/list: ${line#OK }"; else fail "tools/list: $line"; note "gateway down, or a redeploy is still building (npx mcp-use deployments list: wait for the newest row to be running)"; fi
}

check_discovery() {
  echo "2. Discovery files"
  local p code
  for p in /.well-known/ucp /.well-known/mcp/server-card.json /openrpc.json; do
    code="$(curl -sS -o /dev/null --max-time 15 -w '%{http_code}' "$ORIGIN$p" 2>/dev/null)"
    if [ "$code" = "200" ]; then pass "$p"; else fail "$p returned ${code:-no response}"; fi
  done
}

check_verify_prod() {
  local out rc args label=""
  args="$GATEWAY"; [ "$PAY" = 1 ] && { args="$GATEWAY --pay"; label=" --pay"; }
  echo "3. Full buy path (apps/marketplace/scripts/verify-prod.mjs$label)"
  # shellcheck disable=SC2086
  out="$(node "$ROOT/apps/marketplace/scripts/verify-prod.mjs" $args 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then
    pass "9 tools, ranked search, haggle, deal card, owner check$([ "$PAY" = 1 ] && echo ', test payment + safe retry')"
    printf '%s\n' "$out" | tail -n 3 | indent
  else
    fail "verify-prod failed"
    printf '%s\n' "$out" | tail -n 8 | indent
  fi
  [ "$PAY" = 1 ] || note "add --pay to also make one Stripe test payment and check a retry doesn't charge twice"
}

check_memory() {
  echo "4. Anonymous / ChatGPT buyer memory"
  if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ] || [ -z "${SUPABASE_URL:-}" ]; then
    warn "no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env, can't inspect memory"; return
  fi
  local out rc
  # shellcheck disable=SC2086
  out="$(cd "$ROOT" && $PNPM --filter @sa/seller-mcp anon:reset 2>&1)"; rc=$?
  if [ $rc -ne 0 ]; then
    warn "anon:reset (read-only scan) failed; run an install first if tsx is missing"; printf '%s\n' "$out" | tail -n 4 | indent; return
  fi
  if [ "$RESET" = 0 ]; then
    if printf '%s' "$out" | grep -q 'FROZEN'; then
      warn "frozen buyer memory: a fresh chat would open at a final offer"
      printf '%s\n' "$out" | grep 'FROZEN' | head -n 5 | indent
      note "fix: scripts/demo-check.sh --reset (after the last redeploy, right before the demo)"
    else
      pass "no frozen memory"
    fi
    note "memory untouched (pass --reset to clear it)"
    return
  fi
  # shellcheck disable=SC2086
  out="$(cd "$ROOT" && $PNPM --filter @sa/seller-mcp anon:reset --all 2>&1)"; rc=$?
  if [ $rc -ne 0 ]; then fail "anon:reset --all failed"; printf '%s\n' "$out" | tail -n 4 | indent; return; fi
  printf '%s\n' "$out" | tail -n 1 | indent
  # shellcheck disable=SC2086
  out="$(cd "$ROOT" && $PNPM --filter @sa/seller-mcp anon:reset 2>&1)"
  if printf '%s' "$out" | grep -q 'FROZEN'; then fail "memory still frozen after anon:reset --all"; else pass "anon:reset --all done, nothing frozen"; fi
}

check_dashboard() {
  echo "5. Dashboard ($DASHBOARD) and live events"
  if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_ANON_KEY:-}" ]; then
    local row line
    row="$(curl -sS --max-time 15 "$SUPABASE_URL/rest/v1/events?select=ts,type&run_id=neq.exchange_state&order=ts.desc&limit=1" \
      -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" 2>&1)"
    line="$(ROW="$row" node -e '
      let r; try { r = JSON.parse(process.env.ROW); } catch { console.log("BAD " + process.env.ROW.slice(0, 120)); process.exit(1); }
      if (!Array.isArray(r)) { console.log("BAD " + JSON.stringify(r).slice(0, 120)); process.exit(1); }
      if (!r.length) { console.log("EMPTY"); process.exit(0); }
      const mins = Math.round((Date.now() - Date.parse(r[0].ts)) / 60000);
      console.log("OK last event " + r[0].type + " " + mins + " min ago");' 2>&1)"
    case "$line" in
      OK*) pass "Supabase events readable with the anon key: ${line#OK }" ;;
      EMPTY) warn "events table is empty (the Live tab will have nothing to show)" ;;
      *) fail "Supabase events: $line"; note "check SUPABASE_URL / SUPABASE_ANON_KEY, and that RLS lets anon read events" ;;
    esac
  else
    warn "no SUPABASE_URL / SUPABASE_ANON_KEY in .env, the dashboard can't load live data"
  fi
  if curl -sS -o /dev/null --max-time 3 "$DASHBOARD" 2>/dev/null; then
    pass "dashboard dev server is up"
  else
    warn "dashboard not running. Start it: $PNPM dev:dashboard"
  fi
  if [ "$OPEN" = 1 ]; then
    if command -v open >/dev/null 2>&1; then open "$DASHBOARD"; note "opened $DASHBOARD (Live tab; #proof for Results)"; else note "open $DASHBOARD in a browser"; fi
  fi
}

echo "demo-check  gateway=$GATEWAY  runs=$RUNS  reset=$RESET  pay=$PAY"
( cd "$ROOT" && git fetch -q origin 2>/dev/null; printf 'origin/main is %s. Production should be on this commit; compare with: npx mcp-use deployments list\n' "$(git rev-parse --short origin/main 2>/dev/null || echo unknown)" )
echo

CLEAN=0
i=1
while [ "$i" -le "$RUNS" ]; do
  [ "$RUNS" -gt 1 ] && printf '=== run %s of %s ===\n' "$i" "$RUNS"
  PASS=0; WARN=0; FAIL=0
  check_gateway
  check_discovery
  check_verify_prod
  check_memory
  check_dashboard
  printf '\nrun %s: %s%d passed%s, %s%d warnings%s, %s%d failed%s\n\n' "$i" "$G" "$PASS" "$Z" "$Y" "$WARN" "$Z" "$R" "$FAIL" "$Z"
  [ "$FAIL" -eq 0 ] && CLEAN=$((CLEAN+1))
  i=$((i+1))
done

if [ "$RUNS" -gt 1 ]; then
  printf 'Bridge 3 check: %d of %d runs clean with no manual fix between them.\n' "$CLEAN" "$RUNS"
fi
cat <<'EOF'
Not checked by this script (do by hand, docs/DEMO.md):
  - redeploy from main, if code changed since the last deploy (the script never deploys)
  - in ChatGPT: open the app's details and Refresh after any redeploy; confirm the connector is on in the chat
  - one rehearsal buy in the real client, then run this script again with --reset
EOF
[ "$CLEAN" -eq "$RUNS" ]
