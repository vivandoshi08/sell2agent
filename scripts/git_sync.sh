#!/usr/bin/env bash
# Commit and push the given paths. Safe to call from several agents at once:
# a lock directory serializes git operations, and the pathspec commit only
# includes the paths passed in, never anything another agent has staged.
#
# Usage: scripts/git_sync.sh "<commit message>" <path> [<path>...]
set -euo pipefail

msg="${1:?usage: $0 <message> <path>...}"
shift
[ $# -gt 0 ] || { echo "usage: $0 <message> <path>..." >&2; exit 2; }

repo="$(git rev-parse --show-toplevel)"
cd "$repo"
lock="$repo/.git/agent-sync.lock"

# Clear a lock left behind by a killed process.
if [ -d "$lock" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +5 2>/dev/null)" ]; then
  rmdir "$lock" 2>/dev/null || true
fi

for i in $(seq 1 180); do
  if mkdir "$lock" 2>/dev/null; then break; fi
  if [ "$i" -eq 180 ]; then echo "could not get lock $lock" >&2; exit 1; fi
  sleep 1
done
trap 'rmdir "$lock" 2>/dev/null || true' EXIT

git add -- "$@"
if git diff --cached --quiet -- "$@"; then
  echo "nothing to commit in: $*"
else
  git commit -q -m "$msg" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- "$@"
  git log --oneline -1
fi

branch="$(git branch --show-current)"
for i in 1 2 3; do
  if git push -q origin "$branch" 2>/dev/null; then echo "pushed $branch"; exit 0; fi
  sleep $((i * 2))
done
echo "push failed" >&2
exit 1
