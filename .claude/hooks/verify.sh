#!/bin/sh
# Claude Code Stop hook: Claude may not finish a task while `npm run verify` (tsc + ESLint + tests) fails in server/
# or `npm run check` (tsc) fails in web/.
# Exit 2 + stderr = Claude is blocked and reads the message. Hook JSON arrives on stdin:
# stop_hook_active=true means Claude is already continuing because of this hook, so let it stop (no loop).
if [ "$(jq -r '.stop_hook_active // false')" = "true" ]; then exit 0; fi
cd "$CLAUDE_PROJECT_DIR/server" || exit 0
out=$(npm run verify --silent 2>&1) || { printf 'npm run verify failed in server/ (tsc + ESLint + tests). Fix it before finishing:\n%s\n' "$out" >&2; exit 2; }
cd "$CLAUDE_PROJECT_DIR/web" || exit 0
out=$(npm run check --silent 2>&1) || { printf 'npm run check failed in web/ (tsc). Fix it before finishing:\n%s\n' "$out" >&2; exit 2; }
exit 0
