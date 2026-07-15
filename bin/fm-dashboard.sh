#!/usr/bin/env bash
# fm-dashboard.sh - Fleet Dashboard lifecycle owner.
#
# This script is the single owner of dashboard process lifecycle and runtime
# artifacts. The server owns the read-only data/schema/UI contract; see
# bin/fm-dashboard-server.mjs and docs/fleet-dashboard.md.
#
# Runtime artifacts are local and ignored under the active home's state/:
#   .dashboard.pid   verified server pid
#   .dashboard.port  stable selected port
#   .dashboard.log   bounded-by-operator diagnostic log (never HTTP-served)
#   .dashboard-start.lock/  atomic concurrent-start exclusion
#
# `start` and `ensure` are idempotent. A responsive same-home process is reused.
# The default candidate port is 7331. A saved healthy port wins; otherwise the
# lifecycle tries the deterministic candidate and a bounded ascending collision
# range, then persists the working port for future reuse. It never kills a pid
# unless /healthz proves both the same home identity and the recorded pid.
#
# Usage: fm-dashboard.sh <start|ensure|status|stop|open|url>
# Run fm-dashboard.sh --help for command and environment details.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
if [ "${FM_HOME+x}" = x ] && [ -n "${FM_HOME:-}" ]; then
  HOME_SELECTION=explicit
elif [ "${FM_ROOT_OVERRIDE+x}" = x ] && [ -n "${FM_ROOT_OVERRIDE:-}" ]; then
  HOME_SELECTION=root-override
else
  HOME_SELECTION=implicit
fi
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
SERVER="$SCRIPT_DIR/fm-dashboard-server.mjs"
NODE=${FM_DASHBOARD_NODE:-$(command -v node 2>/dev/null || true)}

usage() {
  cat <<'EOF'
usage: fm-dashboard.sh <command>

Start and inspect the local, read-only Firstmate Fleet Dashboard for the active
FM_HOME. Automatic lock-owning session start calls `ensure`; manual commands are:

  start    start the dashboard or reuse a healthy same-home process
  ensure   alias of start, used by fm-session-start.sh
  status   print the running URL and process id, or report stopped
  url      print only the running URL
  stop     stop only a health-verified same-home process
  open     start/reuse, then open the URL with the platform browser command

Environment:
  FM_HOME                    explicit operational home (repo root when unset;
                             an in-page warning identifies inferred homes)
  FM_DASHBOARD_PORT          first candidate port (default 7331)
  FM_DASHBOARD_PORT_SPAN     ascending collision attempts (default 20)
  FM_DASHBOARD_DISABLE=1     skip automatic/manual start for troubleshooting
  FM_DASHBOARD_REFRESH_MS    server snapshot cadence (default 2500)
  FM_DASHBOARD_IDLE_MS       idle span with no client polls before refresh pauses
  FM_DASHBOARD_TASK_TIMEOUT  per-task current-state read bound (default 2s)
  FM_DASHBOARD_SNAPSHOT_TIMEOUT_MS  whole-snapshot safety bound (default 30000)
  FM_DASHBOARD_STALE_MS      age before cached tasks become Unknown/stale
  FM_DASHBOARD_EXPIRE_MS     age marking retained last-known-good rows expired

The server always binds 127.0.0.1 and exposes GET/HEAD only. Runtime artifacts
live under FM_HOME/state and are never tracked.
EOF
}

die() {
  printf 'fm-dashboard: %s\n' "$*" >&2
  exit 1
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac

[ -n "$NODE" ] && [ -x "$NODE" ] || die "node is required"
[ -f "$SERVER" ] || die "server is missing: $SERVER"
[ -d "$FM_HOME" ] || die "FM_HOME is not a directory: $FM_HOME"
HOME_REAL=$(cd "$FM_HOME" && pwd -P) || die "cannot resolve FM_HOME"
STATE="$HOME_REAL/state"
PID_FILE="$STATE/.dashboard.pid"
PORT_FILE="$STATE/.dashboard.port"
LOG_FILE="$STATE/.dashboard.log"
START_LOCK="$STATE/.dashboard-start.lock"
BASE_PORT=${FM_DASHBOARD_PORT:-7331}
PORT_SPAN=${FM_DASHBOARD_PORT_SPAN:-20}

case "$BASE_PORT" in
  ''|*[!0-9]*) die "FM_DASHBOARD_PORT must be an integer" ;;
esac
case "$PORT_SPAN" in
  ''|*[!0-9]*|0) die "FM_DASHBOARD_PORT_SPAN must be a positive integer" ;;
esac
[ "$BASE_PORT" -ge 1024 ] && [ "$BASE_PORT" -le 65535 ] || die "FM_DASHBOARD_PORT must be between 1024 and 65535"
[ "$PORT_SPAN" -le 100 ] || die "FM_DASHBOARD_PORT_SPAN must be 100 or less"
HOME_ID=$("$NODE" "$SERVER" --home-id "$HOME_REAL") || die "cannot compute home identity"

valid_port() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]
}

read_recorded_port() {
  local port=''
  [ -f "$PORT_FILE" ] && IFS= read -r port < "$PORT_FILE"
  valid_port "$port" && printf '%s\n' "$port"
}

read_recorded_pid() {
  local pid=''
  [ -f "$PID_FILE" ] && IFS= read -r pid < "$PID_FILE"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$pid"
}

probe_port() {
  # Prints the server pid and exits 0 only for this exact canonical home id.
  "$NODE" "$SERVER" --probe "$1" "$HOME_ID" 2>/dev/null
}

atomic_record() {  # <path> <value>
  local target=$1 value=$2 tmp="$1.tmp.$$"
  printf '%s\n' "$value" > "$tmp"
  mv "$tmp" "$target"
}

running_url() {
  local port probe pid
  port=$(read_recorded_port) || return 1
  probe=$(probe_port "$port") || return 1
  pid=${probe#pid=}
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  printf 'http://127.0.0.1:%s\n' "$port"
}

record_verified_process() {  # <port> <probe-output>
  local pid=${2#pid=}
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  atomic_record "$PID_FILE" "$pid"
  atomic_record "$PORT_FILE" "$1"
}

acquire_start_lock() {
  local attempt=0 owner=''
  mkdir -p "$STATE"
  while ! mkdir "$START_LOCK" 2>/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 5 ]; then
      [ -f "$START_LOCK/owner" ] && IFS= read -r owner < "$START_LOCK/owner"
      case "$owner" in
        ''|*[!0-9]*)
          rm -f "$START_LOCK/owner" 2>/dev/null || true
          rmdir "$START_LOCK" 2>/dev/null || true
          ;;
        *)
          if ! kill -0 "$owner" 2>/dev/null; then
            rm -f "$START_LOCK/owner" 2>/dev/null || true
            rmdir "$START_LOCK" 2>/dev/null || true
          fi
          ;;
      esac
    fi
    if [ "$attempt" -ge 25 ]; then
      return 1
    fi
    sleep 0.2
  done
  printf '%s\n' "$$" > "$START_LOCK/owner"
}

release_start_lock() {
  rm -f "$START_LOCK/owner" 2>/dev/null || true
  rmdir "$START_LOCK" 2>/dev/null || true
}

try_start_port() {  # <port>
  local port=$1 pid probe attempt=0
  : >> "$LOG_FILE"
  {
    printf '%s start home=%s port=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HOME_ID" "$port" >> "$LOG_FILE"
    pid=$("$NODE" "$SERVER" --daemonize --home "$HOME_REAL" --port "$port" --home-id "$HOME_ID" \
      --home-selection "$HOME_SELECTION" --snapshot "$SCRIPT_DIR/fm-fleet-snapshot.sh" --log "$LOG_FILE") || return 1
    case "$pid" in ''|*[!0-9]*) return 1 ;; esac
    while [ "$attempt" -lt 30 ]; do
      probe=$(probe_port "$port") && {
        record_verified_process "$port" "$probe"
        return 0
      }
      kill -0 "$pid" 2>/dev/null || break
      attempt=$((attempt + 1))
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
    return 1
  }
}

start_dashboard() {
  local url saved probe port offset started=0
  case "${FM_DASHBOARD_DISABLE:-0}" in
    1|true|TRUE|yes|YES)
      printf 'dashboard: disabled by FM_DASHBOARD_DISABLE\n'
      return 0
      ;;
  esac
  if url=$(running_url); then
    port=${url##*:}
    probe=$(probe_port "$port") || return 1
    record_verified_process "$port" "$probe"
    printf 'dashboard: reused %s\n' "$url"
    return 0
  fi
  acquire_start_lock || die "another dashboard start did not settle"
  trap release_start_lock EXIT INT TERM
  if url=$(running_url); then
    printf 'dashboard: reused %s\n' "$url"
    release_start_lock
    trap - EXIT INT TERM
    return 0
  fi
  saved=$(read_recorded_port || true)
  if [ -n "$saved" ] && try_start_port "$saved"; then
    port=$saved
    started=1
  else
    offset=0
    while [ "$offset" -lt "$PORT_SPAN" ]; do
      port=$((BASE_PORT + offset))
      [ "$port" -le 65535 ] || break
      if [ "$port" != "$saved" ] && try_start_port "$port"; then
        started=1
        break
      fi
      offset=$((offset + 1))
    done
  fi
  release_start_lock
  trap - EXIT INT TERM
  [ "$started" -eq 1 ] || die "no loopback port was available in the configured range"
  printf 'dashboard: started http://127.0.0.1:%s\n' "$port"
}

status_dashboard() {
  local port probe pid url
  port=$(read_recorded_port) || { printf 'dashboard: stopped\n'; return 1; }
  probe=$(probe_port "$port") || { printf 'dashboard: stopped (stale runtime artifacts)\n'; return 1; }
  pid=${probe#pid=}
  case "$pid" in ''|*[!0-9]*) printf 'dashboard: stopped (invalid health response)\n'; return 1 ;; esac
  url="http://127.0.0.1:$port"
  printf 'dashboard: running %s (pid %s)\n' "$url" "$pid"
}

stop_dashboard() {
  local port recorded probe actual attempt=0
  port=$(read_recorded_port) || { printf 'dashboard: already stopped\n'; return 0; }
  recorded=$(read_recorded_pid) || die "refusing stop: recorded pid is missing or invalid"
  probe=$(probe_port "$port") || {
    if ! kill -0 "$recorded" 2>/dev/null; then
      rm -f "$PID_FILE" "$PORT_FILE"
      printf 'dashboard: already stopped (cleared stale runtime artifacts)\n'
      return 0
    fi
    die "refusing stop: the recorded pid is live but same-home health could not be verified"
  }
  actual=${probe#pid=}
  [ "$actual" = "$recorded" ] || die "refusing stop: health pid does not match the recorded pid"
  kill -TERM "$recorded" 2>/dev/null || die "could not signal the verified dashboard process"
  while kill -0 "$recorded" 2>/dev/null && [ "$attempt" -lt 50 ]; do
    attempt=$((attempt + 1))
    sleep 0.1
  done
  if kill -0 "$recorded" 2>/dev/null; then
    die "verified dashboard process did not stop after SIGTERM"
  fi
  rm -f "$PID_FILE" "$PORT_FILE"
  printf 'dashboard: stopped\n'
}

open_dashboard() {
  local out url
  out=$(start_dashboard) || return 1
  printf '%s\n' "$out"
  url=${out##* }
  case "$url" in
    http://127.0.0.1:*) ;;
    *) return 0 ;;
  esac
  case "$(uname -s 2>/dev/null || true)" in
    Darwin) command -v open >/dev/null 2>&1 || die "open command not found"; open "$url" ;;
    *) command -v xdg-open >/dev/null 2>&1 || die "xdg-open command not found"; xdg-open "$url" ;;
  esac
}

command=${1:-}
case "$command" in
  start|ensure) start_dashboard ;;
  status) status_dashboard ;;
  url) running_url ;;
  stop) stop_dashboard ;;
  open) open_dashboard ;;
  '') usage >&2; exit 2 ;;
  *) usage >&2; exit 2 ;;
esac
