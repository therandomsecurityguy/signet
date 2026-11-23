#!/usr/bin/env bash
# Signet local demo — no Docker, no AWS.
#
# Runs service/api, service/mcp, and the knowledge-manager webapp directly on
# the host (Node + tsx) with SQLite state, a JSON-file graph, and filesystem
# CAS under ./data. Seeds the blessed demo pack with the operator CLI.
#
# Usage:
#   scripts/demo-local.sh demo    reset state, start services, seed the demo
#   scripts/demo-local.sh up      start the three services (keep existing state)
#   scripts/demo-local.sh seed    seed the blessed demo (catalog + transparency sample) against running services
#   scripts/demo-local.sh down    stop the services
#   scripts/demo-local.sh status  show service health
#
# Requires: Node >= 20 and npm; dependencies installed in service/* and
# client/registry-cli (npm ci in each).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="$REPO_ROOT/data/demo"
API_PORT=3100
MCP_PORT=3000
WEBAPP_PORT=3200

log() { printf '%s\n' "$*"; }

need_node() {
  command -v node >/dev/null 2>&1 || { log "node is required (>= 20)"; exit 1; }
  command -v npm >/dev/null 2>&1 || { log "npm is required"; exit 1; }
}

pid_file_entry() {
  # prints "pid" for the given service name from the pid file, if alive
  local name="$1"
  [ -f "$DEMO_DIR/pids" ] || return 1
  local pid
  pid="$(awk -F: -v n="$name" '$1 == n { print $2 }' "$DEMO_DIR/pids" | head -1)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && printf '%s' "$pid"
}

port_pid() {
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true
}

start_service() {
  local name="$1" cwd="$2" logfile="$3"
  shift 3
  if pid_file_entry "$name" >/dev/null; then
    log "  $name already running (pid $(pid_file_entry "$name"))"
    return 0
  fi
  # os.setsid-style detachment (macOS has no setsid binary; perl does the
  # job): each service becomes its own session leader, so it survives the
  # launching terminal closing and never keeps the caller's pipeline open.
  ( cd "$cwd" && nohup perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV' -- \
      env "$@" npm run dev </dev/null >"$logfile" 2>&1 & echo "$name:$!" >>"$DEMO_DIR/pids" )
  log "  $name starting (log: ${logfile#"$REPO_ROOT"/})"
}

wait_health() {
  local name="$1" url="$2"
  for _ in $(seq 1 60); do
    if curl -sf -o /dev/null "$url"; then
      log "  $name ready ($url)"
      return 0
    fi
    sleep 1
  done
  log "  $name did not become ready: $url"
  return 1
}

cmd_up() {
  need_node
  mkdir -p "$DEMO_DIR" \
    "$REPO_ROOT/data/api" "$REPO_ROOT/data/mcp" "$REPO_ROOT/data/webapp" \
    "$REPO_ROOT/data/registry/graph" "$REPO_ROOT/data/registry/objects"
  : >"$DEMO_DIR/pids"

  start_service api "$REPO_ROOT/service/api" "$DEMO_DIR/api.log" \
    NODE_ENV=development LOG_LEVEL=info PORT="$API_PORT" AUTH_MODE=api_key OKTA_MODE=mock \
    DATABASE_URL="file:$REPO_ROOT/data/api/signet-api.db" \
    REGISTRY_GRAPH_BACKEND=json_file REGISTRY_GRAPH_STATE_FILE="$REPO_ROOT/data/registry/graph/registry-state.json" \
    REGISTRY_ARTIFACT_BACKEND=fs REGISTRY_OBJECTS_DIR="$REPO_ROOT/data/registry/objects"

  start_service mcp "$REPO_ROOT/service/mcp" "$DEMO_DIR/mcp.log" \
    NODE_ENV=development LOG_LEVEL=info PORT="$MCP_PORT" AUTH_MODE=api_key OKTA_MODE=mock \
    DATABASE_URL="file:$REPO_ROOT/data/mcp/signet-mcp.db" \
    REGISTRY_GRAPH_BACKEND=json_file REGISTRY_GRAPH_STATE_FILE="$REPO_ROOT/data/registry/graph/registry-state.json" \
    REGISTRY_ARTIFACT_BACKEND=fs REGISTRY_OBJECTS_DIR="$REPO_ROOT/data/registry/objects"

  start_service webapp "$REPO_ROOT/service/webapp/knowledge-manager" "$DEMO_DIR/webapp.log" \
    NODE_ENV=development LOG_LEVEL=info PORT="$WEBAPP_PORT" \
    API_ORIGIN="http://localhost:$API_PORT" AUTH_MODE=api_key OKTA_MODE=mock \
    DATABASE_URL="file:$REPO_ROOT/data/webapp/knowledge-manager.db"

  wait_health api "http://localhost:$API_PORT/healthz"
  wait_health mcp "http://localhost:$MCP_PORT/healthz"
  wait_health webapp "http://localhost:$WEBAPP_PORT/healthz"
}

cmd_down() {
  local stopped=0
  if [ -f "$DEMO_DIR/pids" ]; then
    while IFS=: read -r name pid; do
      [ -n "${pid:-}" ] || continue
      if kill -0 "$pid" 2>/dev/null; then
        # Services are session/group leaders; kill the whole group so the npm
        # wrapper and the node child stop together.
        kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        stopped=$((stopped + 1))
      fi
    done <"$DEMO_DIR/pids"
    rm -f "$DEMO_DIR/pids"
  fi
  # Fallback: anything still listening on the demo ports.
  for port in "$API_PORT" "$MCP_PORT" "$WEBAPP_PORT"; do
    local pid
    pid="$(port_pid "$port")"
    if [ -n "$pid" ]; then
      kill -9 "$pid" 2>/dev/null || true
      stopped=$((stopped + 1))
    fi
  done
  log "stopped $stopped service(s)"
}

cmd_reset() {
  if [ -n "$(port_pid "$API_PORT")$(port_pid "$MCP_PORT")$(port_pid "$WEBAPP_PORT")" ]; then
    log "refusing to reset while demo services are running — run: scripts/demo-local.sh down"
    exit 1
  fi
  ( cd "$REPO_ROOT/client/registry-cli" && npm run dev -- local reset --force >/dev/null 2>&1 ) || true
  rm -rf "$DEMO_DIR"
  log "local state cleared"
}

cmd_seed() {
  need_node
  ( cd "$REPO_ROOT/client/registry-cli" && \
    DATABASE_URL="file:$REPO_ROOT/data/api/signet-api.db" \
    API_ORIGIN="http://localhost:$API_PORT" \
    MCP_ORIGIN="http://localhost:$MCP_PORT" \
    npm run dev -- bootstrap test --force )
  # Seed the transparency sample graph too, so the witness-network
  # walkthrough in docs/local-demo.md runs against seeded state. The API
  # key is minted in the demo database (the same flow local-demo.md
  # documents for ad-hoc curl use).
  local demo_token
  demo_token="$( cd "$REPO_ROOT/service/api" && \
    DATABASE_URL="file:$REPO_ROOT/data/api/signet-api.db" \
    NODE_ENV=development LOG_LEVEL=silent \
    node --import tsx scripts/create-api-key.ts \
      --owner-label demo-transparency --scopes read,write,lifecycle \
    | node -e 'let raw="";process.stdin.on("data",(chunk)=>raw+=chunk).on("end",()=>process.stdout.write(JSON.parse(raw).token))' )"
  ( cd "$REPO_ROOT/client/registry-cli" && \
    API_ORIGIN="http://localhost:$API_PORT" \
    npm run dev -- seed transparency-sample --api-token "$demo_token" )
}

cmd_status() {
  for pair in "api:$API_PORT" "mcp:$MCP_PORT" "webapp:$WEBAPP_PORT"; do
    local name="${pair%%:*}" port="${pair##*:}"
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$port/healthz" 2>/dev/null || true)"
    log "  $name (:$port): ${code:-down}"
  done
}

case "${1:-demo}" in
  demo)
    cmd_down
    cmd_reset
    cmd_up
    cmd_seed
    log ""
    log "Demo is up:"
    log "  webapp  http://localhost:$WEBAPP_PORT"
    log "  api     http://localhost:$API_PORT/v1/docs"
    log "  mcp     http://localhost:$MCP_PORT/mcp"
    log "Stop with: scripts/demo-local.sh down"
    ;;
  up) cmd_up ;;
  down) cmd_down ;;
  reset) cmd_reset ;;
  seed) cmd_seed ;;
  status) cmd_status ;;
  *)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
