#!/usr/bin/env bash
# Verifies that published client package versions carry npm provenance before
# they are referenced in docs or relied on by consumers: checks the registry
# attestation metadata, then re-verifies signatures on the installed
# tarballs with `npm audit signatures`.
#
# Usage:
#   scripts/verify-npm-provenance.sh 0.1.1
set -euo pipefail

version="${1:-}"
if [[ -z "$version" ]]; then
  echo "usage: $0 <X.Y.Z>" >&2
  exit 2
fi

packages=("@signet-registry/sdk" "@signet-registry/operator")

for pkg in "${packages[@]}"; do
  echo "== ${pkg}@${version} =="
  attestations="$(npm view "${pkg}@${version}" dist.attestations --json 2>/dev/null || true)"
  if [[ -z "$attestations" || "$attestations" == "null" || "$attestations" == "undefined" ]]; then
    echo "  no dist.attestations on the registry" >&2
    echo "  while the source repository is internal this is expected: npm rejects" >&2
    echo "  provenance from non-public repos (E422), so the workflows publish with" >&2
    echo "  NPM_CONFIG_PROVENANCE=false — see docs/runbooks/npm-release.md" >&2
    exit 1
  fi
  node -e '
const attestations = JSON.parse(process.argv[1]);
for (const [name, value] of Object.entries(attestations)) {
  console.log(`  ${name}: ${value && value.url ? value.url : JSON.stringify(value)}`);
}
' "$attestations"
done

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
cd "$workdir"
npm init -y >/dev/null 2>&1
for pkg in "${packages[@]}"; do
  npm install --ignore-scripts --no-save "${pkg}@${version}" >/dev/null
done

echo "== npm audit signatures =="
npm audit signatures
