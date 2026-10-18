#!/usr/bin/env bash
# Print every role's live log mirror (docs/live/<role>.md) from main AND from every unmerged branch,
# newest version per role first. For Claude sessions that can't open artifact pages.
#   bash scripts/live-docs.sh            # all roles, full text
#   bash scripts/live-docs.sh --list     # just which roles/branches have a mirror, with last-commit time
#   bash scripts/live-docs.sh e1         # one role
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git fetch -q origin 2>/dev/null || echo "(fetch failed; showing what's already fetched)" >&2

mode="full"; only=""
case "${1:-}" in --list) mode="list" ;; "") ;; *) only="$1" ;; esac

# role -> "epoch|branch" of the newest commit touching that role's mirror
declare -A newest
for ref in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin | grep -v '/HEAD$'); do
  for f in $(git ls-tree -r --name-only "$ref" -- docs/live 2>/dev/null | grep '\.md$' || true); do
    role=$(basename "$f" .md)
    [ -n "$only" ] && [ "$role" != "$only" ] && continue
    t=$(git log -1 --format=%ct "$ref" -- "$f" 2>/dev/null || echo 0)
    cur=${newest[$role]:-0|}
    [ "$t" -gt "${cur%%|*}" ] && newest[$role]="$t|$ref"
  done
done

if [ ${#newest[@]} -eq 0 ]; then echo "No docs/live/*.md mirrors found on any branch yet."; exit 0; fi

for role in $(printf '%s\n' "${!newest[@]}" | sort); do
  v=${newest[$role]}; t=${v%%|*}; ref=${v#*|}
  when=$(TZ=America/Los_Angeles date -d "@$t" '+%a %-I:%M %p PT' 2>/dev/null || date -r "$t")
  if [ "$mode" = "list" ]; then
    printf '%-6s %-32s %s\n' "$role" "$ref" "$when"
  else
    printf '\n========== %s  (from %s, %s) ==========\n\n' "$role" "$ref" "$when"
    git show "$ref:docs/live/$role.md"
  fi
done
