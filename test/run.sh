#!/usr/bin/env bash
# Unit tests for the pure logic — header parsing, DKIM identity keys, prompt assembly.
# These need no Thunderbird and no Ollama.
set -euo pipefail
cd "$(dirname "$0")/.."
node test/extract.test.mjs
node test/lint-ui.mjs
node test/parse.test.mjs
