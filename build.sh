#!/usr/bin/env bash
# Build LocalMailFilter.xpi — install in Thunderbird via
#   Add-ons Manager -> gear icon -> Install Add-on From File
# Thunderbird does not require extension signing, so this installs permanently.
set -euo pipefail
cd "$(dirname "$0")"

# Bump the patch version on every build. Thunderbird only preserves an add-on's
# stored data when it treats the install as an UPGRADE; installing the same
# version, or uninstalling first, allocates a fresh storage UUID and silently
# discards the allow-list, corrections and verdict history.
if [ "${NO_BUMP:-}" != "1" ]; then
python3 - <<'PY'
import json
m = json.load(open("manifest.json"))
p = m["version"].split("."); p[-1] = str(int(p[-1]) + 1)
m["version"] = ".".join(p)
json.dump(m, open("manifest.json", "w"), indent=2)
open("manifest.json", "a").write("\n")
print("version ->", m["version"])
PY
fi

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
