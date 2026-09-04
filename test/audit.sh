#!/usr/bin/env bash
# Fails if anything that looks like personal mailbox detail would reach the repository.
#
# Scans only files git would actually commit — tracked files plus untracked ones that
# are not ignored — so deliberately-ignored local notes do not trip it, while anything
# genuinely on its way into a commit does.
#
# Extend PATTERN with your own identifiers before publishing a fork.
set -uo pipefail
cd "$(dirname "$0")/.."

PATTERN='[a-z0-9._%+-]+@[a-z0-9.-]+\.(com|org|net|io|co)|([0-9]{1,3}\.){3}[0-9]{1,3}'
ALLOW='example\.(com|org|net)|\.example|@example|localhost|noreply@|0\.0\.0\.0|127\.0\.0\.1'

files=$(git ls-files --cached --others --exclude-standard 2>/dev/null)
[ -z "$files" ] && { echo "audit: no committable files found"; exit 0; }

hits=$(echo "$files" | grep -vE '^test/' | while read -r f; do
  [ -f "$f" ] || continue
  grep -IEn "$PATTERN" "$f" 2>/dev/null | grep -vE "$ALLOW" | sed "s|^|$f:|"
done)

if [ -n "$hits" ]; then
  echo "audit FAILED — possible personal data in files git would commit:"
  echo "$hits"
  exit 1
fi
echo "audit passed: no addresses or IP literals outside example domains"
