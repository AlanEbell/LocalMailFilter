#!/usr/bin/env bash
# Build LocalMailFilter.xpi — install in Thunderbird via
#   Add-ons Manager -> gear icon -> Install Add-on From File
# Thunderbird does not require extension signing, so this installs permanently.
set -euo pipefail
cd "$(dirname "$0")"

# Regenerate the prompt module from the editable text file.
python3 - <<'PY'
import json
txt = open("lib/prompt.txt").read()
with open("lib/prompt.js","w") as f:
    f.write("// Generated from lib/prompt.txt by build.sh — edit the .txt, not this file.\n")
    f.write("// {{OWNER_CONTEXT}} is substituted at runtime from local settings, so no\n")
    f.write("// personal detail is ever committed to the repository.\n")
    f.write("export const SYSTEM_PROMPT = " + json.dumps(txt) + ";\n")
    f.write('''
export function withOwner(ownerContext) {
  return SYSTEM_PROMPT.replace("{{OWNER_CONTEXT}}", ownerContext || "The mailbox owner has not described themselves.");
}
''')
PY

rm -f LocalMailFilter.xpi
zip -qr LocalMailFilter.xpi \
  manifest.json background.js lib ui icons \
  -x '*.svg' '*/.*' 'lib/prompt.txt'
echo "built $(pwd)/LocalMailFilter.xpi  ($(du -h LocalMailFilter.xpi | cut -f1))"
