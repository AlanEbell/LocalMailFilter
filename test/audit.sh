#!/usr/bin/env bash
# Fails if anything that looks like personal mailbox detail reaches the repository.
# Extend PATTERN with your own identifiers before publishing a fork.
set -uo pipefail
cd "$(dirname "$0")/.."
PATTERN='[a-z0-9._%+-]+@[a-z0-9.-]+\.(com|org|net|io|co)|([0-9]{1,3}\.){3}[0-9]{1,3}'
hits=$(grep -rIEn "$PATTERN" --exclude-dir=.git --exclude-dir=test . \
        | grep -vE 'example\.(com|org|net)|\.example|@example|localhost|noreply@|0\.0\.0\.0|127\.0\.0\.1' || true)
if [ -n "$hits" ]; then
  echo "audit FAILED — possible personal data:"; echo "$hits"; exit 1
fi
echo "audit passed: no addresses or IP literals outside example domains"
