#!/usr/bin/env bash
# Verifies the signatures and attestations attached to a signet release before
# its pinned digests are applied: the release manifest (keyless blob
# signature), every component image (keyless container signature), and the
# Helm chart (keyless container signature).
#
# Run before applying a new pin in the environment repo or any
# other consumer of release-manifest.json. Requires: cosign, jq, gh (or a
# downloaded manifest), and ECR authentication for image/chart verification
# (aws ecr get-login-password | docker login ...).
#
# Usage:
#   scripts/verify-release-signatures.sh v0.1.15
#   scripts/verify-release-signatures.sh v0.1.15 /path/to/release-manifest.json
set -euo pipefail

tag="${1:-}"
if [[ -z "$tag" ]]; then
  echo "usage: $0 <vX.Y.Z> [release-manifest.json]" >&2
  exit 2
fi
manifest_path="${2:-}"

# GitHub Actions keyless identity. Tag releases run release.yaml at the tag;
# manual re-publishes run it on main.
identity_regexp="${SIGNET_RELEASE_IDENTITY_REGEXP:-^https://github\.com/togethercomputer/signet/\.github/workflows/release\.yaml@(refs/tags/v.*|refs/heads/main)$}"
oidc_issuer="${SIGNET_RELEASE_OIDC_ISSUER:-https://token.actions.githubusercontent.com}"

for tool in cosign jq gh; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "missing required tool: $tool" >&2
    exit 2
  fi
done

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

if [[ -z "$manifest_path" ]]; then
  echo "== downloading release assets for $tag =="
  gh release download "$tag" \
    --pattern release-manifest.json \
    --pattern release-manifest.sigstore.json \
    --dir "$workdir" --clobber
  manifest_path="$workdir/release-manifest.json"
  bundle_path="$workdir/release-manifest.sigstore.json"
else
  manifest_path="$(cd "$(dirname "$manifest_path")" && pwd)/$(basename "$manifest_path")"
  bundle_path="$(dirname "$manifest_path")/release-manifest.sigstore.json"
  if [[ ! -f "$bundle_path" ]]; then
    echo "missing signature bundle next to the manifest: $bundle_path" >&2
    exit 2
  fi
fi

fail=0

echo "== release manifest signature =="
if cosign verify-blob \
  --bundle "$bundle_path" \
  --certificate-identity-regexp "$identity_regexp" \
  --certificate-oidc-issuer "$oidc_issuer" \
  "$manifest_path" >/dev/null; then
  echo "ok   release-manifest.json (keyless signature verified)"
else
  echo "FAIL release-manifest.json signature" >&2
  fail=1
fi

manifest_version="$(jq -r '.version' "$manifest_path")"
if [[ "$tag" != "v$manifest_version" ]]; then
  echo "FAIL manifest version $manifest_version does not match tag $tag" >&2
  fail=1
else
  echo "ok   manifest version matches $tag"
fi

# Image references in the manifest are repository-relative (for example
# "signet/api"); the registry comes from the fully-qualified chart OCI URL so
# cosign resolves against ECR and not Docker Hub.
chart_ref="$(jq -r '.chart' "$manifest_path" | sed 's|^oci://||')"
registry="${SIGNET_RELEASE_REGISTRY:-${chart_ref%%/*}}"
if [ -z "$registry" ] || [ "$registry" = "$chart_ref" ]; then
  echo "FAIL unable to resolve the image registry from the manifest chart reference: $chart_ref" >&2
  exit 2
fi

echo "== component image signatures =="
while IFS=$'\t' read -r target repository digest; do
  image="$registry/$repository@$digest"
  if cosign verify \
    --certificate-identity-regexp "$identity_regexp" \
    --certificate-oidc-issuer "$oidc_issuer" \
    "$image" >/dev/null; then
    echo "ok   $target $image"
  else
    echo "FAIL $target signature ($image)" >&2
    fail=1
  fi
done < <(jq -r '.images | to_entries[] | [.key, .value.repository, .value.digest] | @tsv' "$manifest_path")

echo "== chart signature =="
if cosign verify \
  --certificate-identity-regexp "$identity_regexp" \
  --certificate-oidc-issuer "$oidc_issuer" \
  "$chart_ref" >/dev/null; then
  echo "ok   $chart_ref"
else
  echo "FAIL chart signature ($chart_ref)" >&2
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo "signature verification failed for $tag" >&2
  exit 1
fi
echo "all release signatures verified for $tag"
