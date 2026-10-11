#!/usr/bin/env bash
# td.sh PLAN N MSG -- test cmd...   : commit all, task-done, then task-start N+1
set -e
S=/Users/bjunya/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/executing-plans/scripts
pname=$1; plan=docs/superpowers/plans/$1; n=$2; msg=$3; shift 4
base=$(cat .superpowers/base-$pname-$n 2>/dev/null || git rev-parse HEAD~1)
git add -A && git commit -qm "$msg

Claude-Session: https://claude.ai/code/session_01HS12Fv8RCq8LUW6HYct5wW"
$S/task-done "$plan" "$n" "$base" -- "$@" 2>&1 | grep -E "^ledger|Tests |FAIL" | tail -2
next=$((n+1))
out=$($S/task-start "$plan" "$next" 2>&1) && { echo "$out" | sed -n 's/^base: //p' > .superpowers/base-$pname-$next; echo "started $next"; } || echo "no task $next"
