#!/bin/sh
# Compares src/vendor/ with the n8n package it was copied from. Exits 1 on any difference.
set -e
REF="${1:-main}"
STATUS=0
for f in agentRun mcp prompt graph share agents; do
  if ! curl -fsSL "https://raw.githubusercontent.com/roleALPHA/n8n-nodes-rolealpha/$REF/lib/$f.ts" | diff -q - "src/vendor/$f.ts" >/dev/null; then
    echo "differs: src/vendor/$f.ts (upstream lib/$f.ts @ $REF)"; STATUS=1
  fi
done
[ $STATUS -eq 0 ] && echo "src/vendor/ matches n8n-nodes-rolealpha@$REF"
exit $STATUS
