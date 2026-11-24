#!/usr/bin/env bash
# Update the local Kubernetes demo (OrbStack / kind) to the current checkout
# or to a verified released version of Signet.
#
# Usage:
#   scripts/demo-k8s-update.sh                     # build from the working tree
#   scripts/demo-k8s-update.sh --no-build          # reuse existing :dev images
#   scripts/demo-k8s-update.sh --release v0.1.85   # verified release images
#
# What it does:
#   1. local mode: builds signet/{api,mcp,webapp-knowledge-manager}:dev from
#      the working tree and loads them into kind clusters (OrbStack shares its
#      Docker image store with its cluster, so no load step is needed there)
#   2. release mode: runs scripts/verify-release-signatures.sh for the tag
#      (fail-closed: signatures/attestations must verify), downloads the
#      release manifest, and pins the verified image digests. Released images
#      are linux/amd64 (emulated on Apple Silicon; local builds are native)
#   3. helm upgrade --install the local chart with the values overlay
#   4. waits for the api/mcp/webapp rollouts, then runs in-cluster /healthz
#      checks
#
# Demo state (registry graph + CAS) lives on the chart PVC and survives
# updates. Run `git pull` (or check out the release tag) first: the chart and
# the values overlay come from the working tree.
#
# Requires: docker, helm, kubectl. Release mode additionally requires the
# tools used by scripts/verify-release-signatures.sh (cosign, jq, gh).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

release_name="signet"
namespace="signet"
values_file="charts/signet/values-local.yaml"
release_tag=""
no_build=0
rollout_timeout=300

log()  { printf '%s\n' "$*"; }
note() { printf '== %s\n' "$*"; }
ok()   { printf 'ok   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: scripts/demo-k8s-update.sh [options]

  (no flags)          build images from the working tree and upgrade the demo
  --release vX.Y.Z    verify + deploy a released version (digest-pinned GHCR
                      images; requires cosign, jq, gh)
  --no-build          skip the docker build step (local mode)
  --release-name <n>  helm release name (default: signet)
  --namespace <ns>    namespace (default: signet)
  --values <file>     values overlay (default: charts/signet/values-local.yaml)
  --timeout <secs>    rollout timeout (default: 300)
  -h, --help          show this help

Demo state lives on the chart PVC and survives updates. Run `git pull` (or
check out the release tag) first: chart and values come from the working tree.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      release_tag="${2:-}"
      [[ -n "$release_tag" ]] || fail "--release needs a tag like v0.1.85"
      shift 2
      ;;
    --no-build)     no_build=1; shift ;;
    --release-name) release_name="${2:-}"; shift 2 ;;
    --namespace)    namespace="${2:-}"; shift 2 ;;
    --values)       values_file="${2:-}"; shift 2 ;;
    --timeout)      rollout_timeout="${2:-}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *)              fail "unknown option: $1 (see --help)" ;;
  esac
done

for tool in docker helm kubectl; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: $tool"
done
docker info >/dev/null 2>&1 || fail "the Docker daemon is not reachable"

if [[ -n "$release_tag" ]]; then
  [[ "$release_tag" == v* ]] || fail "--release expects a tag like v0.1.85"
  for tool in cosign jq gh; do
    command -v "$tool" >/dev/null 2>&1 || fail "release mode needs: $tool"
  done
fi

[[ -f "$values_file" ]] || fail "values overlay not found: $values_file"

kube_context="$(kubectl config current-context 2>/dev/null || true)"
log "context: $kube_context"
log "release: $release_name (namespace $namespace)"
log "values:  $values_file"
log ""

helm_args=(
  upgrade --install "$release_name" charts/signet
  --namespace "$namespace" --create-namespace
  --values "$values_file"
)

if [[ -n "$release_tag" ]]; then
  note "verifying release $release_tag (signatures + attestations)"
  scripts/verify-release-signatures.sh "$release_tag" ||
    fail "release verification failed — refusing to deploy $release_tag"
  ok "release $release_tag verified"

  note "resolving digest pins from the release manifest"
  manifest_dir="$(mktemp -d)"
  trap 'rm -rf "$manifest_dir"' EXIT
  gh release download "$release_tag" --pattern release-manifest.json --dir "$manifest_dir" --clobber
  manifest="$manifest_dir/release-manifest.json"

  registry="$(jq -r '.chart // ""' "$manifest" | sed 's|^oci://||; s|/.*||')"
  [[ -n "$registry" && "$registry" != "null" ]] ||
    fail "could not resolve the image registry from the release manifest chart reference"

  for target in api mcp webapp; do
    repository="$(jq -r --arg t "$target" '.images[$t].repository // ""' "$manifest")"
    digest="$(jq -r --arg t "$target" '.images[$t].digest // ""' "$manifest")"
    [[ -n "$repository" && "$digest" == sha256:* ]] ||
      fail "release manifest is missing the $target image digest"
    note "pulling $registry/$repository@${digest:0:19}…"
    # Released images are linux/amd64-only (see release.yaml); request the
    # platform explicitly so arm64 hosts pull instead of erroring, matching
    # the emulated-at-runtime behavior OrbStack/kind apply for such images.
    docker pull -q --platform linux/amd64 "$registry/$repository@$digest" >/dev/null
    ok "$target pinned to ${digest:0:19}…"
  done

  helm_args+=(--set-string "image.registry=$registry")
  for target in api mcp webapp; do
    helm_args+=(
      --set-string "$target.image.repository=$(jq -r --arg t "$target" '.images[$t].repository' "$manifest")"
      --set-string "$target.image.digest=$(jq -r --arg t "$target" '.images[$t].digest' "$manifest")"
    )
  done
else
  if [[ "$no_build" -eq 0 ]]; then
    note "building images from the working tree (${kube_context} cluster)"
    docker build --file service/api/Dockerfile --tag signet/api:dev .
    docker build --file service/mcp/Dockerfile --tag signet/mcp:dev .
    docker build --file service/webapp/knowledge-manager/Dockerfile --tag signet/webapp-knowledge-manager:dev .
    ok "images built"
  else
    note "skipping docker build (--no-build)"
  fi

  case "$kube_context" in
    kind-*)
      command -v kind >/dev/null 2>&1 || fail "context is $kube_context but the kind CLI is not installed"
      note "loading images into $kube_context"
      kind load docker-image signet/api:dev signet/mcp:dev signet/webapp-knowledge-manager:dev --name "${kube_context#kind-}"
      ok "images loaded"
      ;;
    orbstack)
      log "note: OrbStack shares the Docker image store with its cluster; no load step needed"
      ;;
    *)
      log "note: context $kube_context: assuming locally built images are visible to the cluster"
      ;;
  esac
fi

note "helm upgrade"
helm "${helm_args[@]}"
ok "helm release updated"

# Local mode reuses the same :dev tag, so the pod template does not change and
# kubelet needs a restart to pick up the freshly built image. Release mode
# changes the pinned digests, which already rolls the workloads.
if [[ -z "$release_tag" ]]; then
  note "restarting workloads to pick up the new images"
  kubectl -n "$namespace" rollout restart \
    "deploy/$release_name-api" "deploy/$release_name-mcp" "deploy/$release_name-webapp"
fi

for component in api mcp webapp; do
  kubectl -n "$namespace" rollout status "deploy/$release_name-$component" \
    --timeout="${rollout_timeout}s" >/dev/null
  ok "rollout $component"
done

note "health checks"
for spec in "api:3100" "mcp:3000" "webapp:3200"; do
  component="${spec%%:*}"
  port="${spec##*:}"
  if kubectl -n "$namespace" exec "deploy/$release_name-$component" -- node -e \
    "fetch('http://127.0.0.1:${port}/healthz').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))" \
    >/dev/null 2>&1; then
    ok "$component /healthz"
  else
    fail "$component /healthz check failed — inspect: kubectl -n $namespace logs deploy/$release_name-$component"
  fi
done

note "deployed images"
kubectl -n "$namespace" get deploy \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image' --no-headers

log ""
log "demo updated. webapp: kubectl -n $namespace port-forward svc/$release_name-webapp 3200:3200"
