#!/usr/bin/env bash
set -euo pipefail

ROOT="${VOCBENCH_ROOT:-/workspace}"
RUNTIME_DIR="${VOCBENCH_RUNTIME_DIR:-$ROOT/tools/vocbench/runtime}"

ST_SCRIPT="$(find "$RUNTIME_DIR" -type f -path '*/bin/semanticturkey.sh' | head -n 1 || true)"
if [[ -z "${ST_SCRIPT:-}" ]]; then
  echo "Could not find semanticturkey.sh under $RUNTIME_DIR"
  echo "Download and unzip the VocBench full distribution first."
  exit 1
fi

ST_HOME="$(cd "$(dirname "$ST_SCRIPT")/.." && pwd)"
echo "Using Semantic Turkey home: $ST_HOME"
cd "$ST_HOME/bin"
exec ./semanticturkey.sh
