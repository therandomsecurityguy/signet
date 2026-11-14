#!/usr/bin/env bash
set -euo pipefail

ROOT="${VOCBENCH_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DOWNLOAD_DIR="$ROOT/tools/vocbench/downloads"
mkdir -p "$DOWNLOAD_DIR"

ZIP_PATH="$DOWNLOAD_DIR/vocbench3-14.0.0-full.zip"
URL="${VOCBENCH_DOWNLOAD_URL:-https://bitbucket.org/art-uniroma2/vocbench3/downloads/vocbench3-14.0.0-full.zip}"

echo "Downloading VocBench full distribution from $URL"
curl -fL -o "$ZIP_PATH" "$URL"
echo "Saved to $ZIP_PATH"
