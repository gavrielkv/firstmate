#!/usr/bin/env bash
# Behavior tests for the local read-only Fleet Dashboard.
# Covers lifecycle and idempotent reuse, deterministic collision fallback,
# explicit-home isolation regardless of cwd, visible inferred-home diagnostics,
# state classification, secondmate standing-by state, bounded escaping/redaction,
# GET-only HTTP behavior, idle-gated live polling, per-task timeout degradation,
# retained last-known-good recovery, and teardown that refuses an ambiguous pid.
set -u

# shellcheck source=tests/lib.sh
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DASHBOARD="$ROOT/bin/fm-dashboard.sh"
SERVER="$ROOT/bin/fm-dashboard-server.mjs"
TMP_ROOT=$(fm_test_tmproot fm-dashboard)
BASE_PORT=$((32000 + ($$ % 20000)))
LIVE_HOMES=''
EXTRA_PIDS=''

command -v node >/dev/null 2>&1 || { echo "skip: node not found"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }

cleanup() {
  local home pid
  for home in $LIVE_HOMES; do
    FM_HOME="$home" FM_DASHBOARD_PORT="$BASE_PORT" "$DASHBOARD" stop >/dev/null 2>&1 || true
  done
  for pid in $EXTRA_PIDS; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  fm_test_cleanup
}
trap cleanup EXIT

make_home() {  # <name>
  local home="$TMP_ROOT/$1"
  mkdir -p "$home/state" "$home/data" "$home/config" "$home/projects"
  printf '%s\n' "$home"
}

make_fakebin() {  # <home>
  local home=$1 fakebin real_find
  fakebin="$home/fakebin"
  real_find=$(command -v find)
  mkdir -p "$fakebin"
  cat > "$fakebin/no-mistakes" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  cat > "$fakebin/find" <<SH
#!/usr/bin/env bash
if [ -e "\${FM_DASHBOARD_TEST_MODE:-}/snapshot-hang" ]; then
  sleep 20
fi
exec "$real_find" "\$@"
SH
  cat > "$fakebin/tmux" <<'SH'
#!/usr/bin/env bash
set -u
target=''
previous=''
for argument in "$@"; do
  [ "$previous" = -t ] && target=$argument
  previous=$argument
done
case "${1:-}" in
  display-message)
    case "$*" in
      *pane_current_command*) printf 'codex\n' ;;
      *) printf '%%1\n' ;;
    esac
    ;;
  capture-pane)
    if [ -e "$FM_DASHBOARD_TEST_MODE/slow-all" ] || \
       { [ -e "$FM_DASHBOARD_TEST_MODE/slow-task" ] && printf '%s' "$target" | grep -q 'slow-task'; }; then
      sleep 8
    fi
    case "$target" in
      *working-task*|*ci-task*|*slow-task*) printf 'work in progress\nesc to interrupt\n' ;;
      *needs-task*)
        if [ -e "$FM_DASHBOARD_TEST_MODE/needs-busy" ]; then
          printf 'work resumed\nesc to interrupt\n'
        else
          printf 'idle\n> \n'
        fi
        ;;
      *) printf 'idle\n> \n' ;;
    esac
    ;;
esac
exit 0
SH
  chmod +x "$fakebin/find" "$fakebin/no-mistakes" "$fakebin/tmux"
  printf '%s\n' "$fakebin"
}

write_fixture() {  # <home>
  local home=$1 mate
  mate="$TMP_ROOT/$(basename "$home")-mate-home"
  mkdir -p \
    "$home/projects/working" "$home/projects/needs" "$home/projects/ci" \
    "$home/projects/paused" "$home/projects/failed" "$home/projects/done" \
    "$mate/state" "$mate/data" "$mate/config" "$mate/projects" "$mate/bin"
  printf '# Firstmate fixture\n' > "$mate/AGENTS.md"
  printf 'domain-mate\n' > "$mate/.fm-secondmate-home"
  printf -- '- domain-mate - Fixture domain (home: %s; scope: fixture work; projects: alpha; added 2026-07-15)\n' \
    "$mate" > "$home/data/secondmates.md"
  cat > "$mate/data/backlog.md" <<'EOF'
## In flight

## Queued

## Done
EOF
  cat > "$home/data/backlog.md" <<'EOF'
## In flight
- [ ] needs-task - Choose <img src=x onerror=alert(1)> behavior (repo: alpha) (kind: ship) (since 2026-07-15)
- [ ] working-task - Build the dashboard (repo: alpha) (kind: ship) (since 2026-07-15)
- [ ] ci-task - Validate dashboard CI (repo: alpha) (kind: ship) (since 2026-07-15)
- [ ] paused-task - Wait for upstream release (repo: beta) (kind: scout) (since 2026-07-15)
- [ ] failed-task - Failed delivery (repo: beta) (kind: ship) (since 2026-07-15)
- [ ] unknown-task - Missing runtime truth (repo: gamma) (kind: ship) (since 2026-07-15)
- [ ] done-live - Recently completed live task (repo: alpha) (kind: scout) (since 2026-07-15)

## Queued

## Done
- [x] landed-task - Landed dashboard https://github.com/kunchenguid/firstmate/pull/321 (repo: alpha) (kind: ship) (merged 2026-07-14)
EOF
  fm_write_meta "$home/state/needs-task.meta" \
    "window=firstmate:fm-needs-task" "worktree=$home/projects/needs" "project=$home/projects/needs" \
    "harness=codex" "model=gpt-test" "effort=high" "kind=ship" "mode=no-mistakes" \
    "pr=https://github.com/kunchenguid/firstmate/pull/321"
  printf 'needs-decision [key=choice]: choose A or B token=supersecret http://127.0.0.1:4387/session/review\n' > "$home/state/needs-task.status"
  fm_write_meta "$home/state/working-task.meta" \
    "window=firstmate:fm-working-task" "worktree=$home/projects/working" "project=alpha" \
    "harness=codex" "model=default" "effort=xhigh" "kind=ship" "mode=no-mistakes"
  printf 'working: implementing the compact fleet surface\n' > "$home/state/working-task.status"
  fm_write_meta "$home/state/ci-task.meta" \
    "window=firstmate:fm-ci-task" "worktree=$home/projects/ci" "project=alpha" \
    "harness=claude" "model=default" "effort=high" "kind=ship" "mode=no-mistakes"
  printf 'working: CI checks running\n' > "$home/state/ci-task.status"
  fm_write_meta "$home/state/paused-task.meta" \
    "window=firstmate:fm-paused-task" "worktree=$home/projects/paused" "project=beta" \
    "harness=pi" "model=default" "effort=medium" "kind=scout" "mode=scout"
  printf 'paused: waiting for upstream release\n' > "$home/state/paused-task.status"
  fm_write_meta "$home/state/failed-task.meta" \
    "window=firstmate:fm-failed-task" "worktree=$home/projects/failed" "project=beta" \
    "harness=grok" "model=default" "effort=high" "kind=ship" "mode=direct-PR"
  printf 'failed: test suite stopped with a reproducible error\n' > "$home/state/failed-task.status"
  fm_write_meta "$home/state/unknown-task.meta" \
    "backend=cmux" "window=workspace:surface" "worktree=$home/projects/missing" "project=gamma" \
    "harness=codex" "model=default" "effort=high" "kind=ship" "mode=no-mistakes"
  fm_write_meta "$home/state/done-live.meta" \
    "window=firstmate:fm-done-live" "worktree=$home/projects/done" "project=alpha" \
    "harness=codex" "model=default" "effort=high" "kind=scout" "mode=scout"
  printf 'done: report ready\n' > "$home/state/done-live.status"
  fm_write_meta "$home/state/domain-mate.meta" \
    "window=firstmate:fm-domain-mate" "worktree=$mate" "project=$mate" \
    "harness=codex" "model=default" "effort=high" "kind=secondmate" "mode=secondmate" \
    "home=$mate" "projects=alpha"
  printf 'working: old parent event should not override structured idle state\n' > "$home/state/domain-mate.status"
}

http_get() {  # <url> [host]
  node - "$1" "${2:-}" <<'NODE'
const http = require('http');
const url = new URL(process.argv[2]);
const headers = process.argv[3] ? { Host: process.argv[3] } : {};
const request = http.get(url, { headers, timeout: 3000 }, (response) => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', (chunk) => { body += chunk; });
  response.on('end', () => {
    if (response.statusCode < 200 || response.statusCode >= 300) process.exitCode = 1;
    process.stdout.write(body);
  });
});
request.on('timeout', () => request.destroy());
request.on('error', () => { process.exitCode = 1; });
NODE
}

http_status() {  # <method> <url> [host]
  node - "$1" "$2" "${3:-}" <<'NODE'
const http = require('http');
const method = process.argv[2];
const url = new URL(process.argv[3]);
const headers = process.argv[4] ? { Host: process.argv[4] } : {};
const request = http.request(url, { method, headers, timeout: 3000 }, (response) => {
  response.resume();
  response.on('end', () => process.stdout.write(String(response.statusCode)));
});
request.on('timeout', () => request.destroy());
request.on('error', () => { process.exitCode = 1; });
request.end();
NODE
}

wait_for_api() {  # <url> <jq-expression>
  local url=$1 expression=$2 attempt=0 body=''
  while [ "$attempt" -lt 60 ]; do
    body=$(http_get "$url/api/v1/fleet" 2>/dev/null || true)
    if printf '%s' "$body" | jq -e "$expression" >/dev/null 2>&1; then
      printf '%s' "$body"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.2
  done
  printf 'last API body: %s\n' "$body" >&2
  return 1
}

start_fixture_dashboard() {  # <home> <fakebin> <base-port>
  local home=$1 fakebin=$2 port=$3
  PATH="$fakebin:$PATH" FM_HOME="$home" FM_DASHBOARD_PORT="$port" FM_DASHBOARD_PORT_SPAN=8 \
    FM_DASHBOARD_REFRESH_MS="${FM_DASHBOARD_REFRESH_MS:-500}" \
    FM_DASHBOARD_IDLE_MS="${FM_DASHBOARD_IDLE_MS:-30000}" \
    FM_DASHBOARD_TASK_TIMEOUT="${FM_DASHBOARD_TASK_TIMEOUT:-2}" \
    FM_DASHBOARD_SNAPSHOT_TIMEOUT_MS="${FM_DASHBOARD_SNAPSHOT_TIMEOUT_MS:-30000}" \
    FM_DASHBOARD_STALE_MS="${FM_DASHBOARD_STALE_MS:-3000}" \
    FM_DASHBOARD_EXPIRE_MS="${FM_DASHBOARD_EXPIRE_MS:-8000}" \
    FM_DASHBOARD_TEST_MODE="$home" "$DASHBOARD" start
}

test_help_and_internal_contract() {
  local help
  help=$($DASHBOARD --help)
  assert_contains "$help" "start" "help omitted start"
  assert_contains "$help" "status" "help omitted status"
  assert_contains "$help" "stop" "help omitted stop"
  assert_contains "$help" "open" "help omitted open"
  assert_contains "$help" "always binds 127.0.0.1" "help omitted loopback boundary"
  assert_contains "$help" "FM_DASHBOARD_TASK_TIMEOUT" "help omitted per-task read bound"
  assert_contains "$help" "FM_DASHBOARD_SNAPSHOT_TIMEOUT_MS" "help omitted whole-snapshot bound"
  node --check "$SERVER" || fail "dashboard server failed node syntax check"
  pass "dashboard help and internal server contract are available"
}

test_lifecycle_projection_isolation_and_live_update() {
  local home other fakebin out url pid_before pid_after api isolated html method_status missing_status host_status
  home=$(make_home main-home)
  other=$(make_home other-home)
  write_fixture "$home"
  mkdir -p "$other/projects/other"
  fm_write_meta "$other/state/other-only.meta" \
    "window=firstmate:fm-other-only" "worktree=$other/projects/other" "project=other" \
    "harness=codex" "kind=ship" "mode=no-mistakes"
  fakebin=$(make_fakebin "$home")
  out=$(cd "$other" && start_fixture_dashboard "$home" "$fakebin" "$BASE_PORT") \
    || fail "dashboard start from an unrelated cwd failed: $out"
  assert_contains "$out" "dashboard: started http://127.0.0.1:" "start did not print the URL"
  url=${out##* }
  LIVE_HOMES="$LIVE_HOMES $home"
  pid_before=$(cat "$home/state/.dashboard.pid")
  out=$(start_fixture_dashboard "$home" "$fakebin" "$BASE_PORT") || fail "dashboard reuse failed: $out"
  assert_contains "$out" "dashboard: reused $url" "second start did not reuse the same URL"
  pid_after=$(cat "$home/state/.dashboard.pid")
  [ "$pid_before" = "$pid_after" ] || fail "idempotent reuse changed pid: $pid_before -> $pid_after"

  api=$(wait_for_api "$url" '.connection.state == "live" and (.tasks | length) >= 9') \
    || fail "dashboard API did not become live"
  printf '%s' "$api" | jq -e '
    .schema == "fm-fleet-dashboard.v1"
      and .home.label == "main-home"
      and .home.selection == "explicit"
      and .home.diagnostic == null
      and .counts.needs_captain == 1
      and .counts.working == 1
      and .counts.waiting == 2
      and .counts.blocked == 1
      and .counts.unknown == 1
      and .counts.standby == 1
      and .counts.done == 2
      and .tasks[0].id == "needs-task"
      and (.tasks[] | select(.id == "needs-task")
        | .state.key == "needs_captain"
          and .harness == "codex" and .model == "gpt-test" and .effort == "high"
          and .project == "needs"
          and .decisions[0].question == "choose A or B token=[REDACTED] http://127.0.0.1:4387/session/review"
          and (.links | any(.kind == "pr"))
          and (.links | any(.kind == "lavish")))
      and (.tasks[] | select(.id == "domain-mate") | .state.key == "standby")
      and (.tasks[] | select(.id == "landed-task") | .recently_landed == true and .state.key == "done")
  ' >/dev/null || fail "state mapping, pinned decision, runtime fields, links, or landed projection was wrong: $api"
  assert_not_contains "$api" "$home" "API leaked the active home path"
  assert_not_contains "$api" "$other" "API leaked another home path"
  assert_not_contains "$api" "supersecret" "API leaked an unredacted secret"
  assert_not_contains "$api" "workspace:surface" "API leaked a raw backend target"

  isolated=$(http_get "$url/api/v1/fleet?home=$(printf '%s' "$other" | sed 's#/#%2F#g')") \
    || fail "query-bearing API request failed"
  assert_contains "$isolated" '"needs-task"' "home query displaced the active home"
  assert_not_contains "$isolated" '"other-only"' "home query crossed into another home"

  html=$(http_get "$url/") || fail "dashboard HTML failed"
  assert_contains "$html" "FIRSTMATE" "dashboard HTML omitted product identity"
  assert_contains "$html" '<table class="fleet-table">' "shared-field records are not rendered as a semantic table"
  assert_contains "$html" '<th scope="col">Status</th>' "dashboard table omitted scoped column headers"
  assert_contains "$html" 'id="fleet-alert"' "dashboard HTML omitted the prominent stale/error banner"
  assert_contains "$html" "textContent" "browser renderer is not using textContent"
  assert_not_contains "$html" "innerHTML" "browser renderer uses unsafe dynamic innerHTML"
  assert_not_contains "$html" "<img src=x onerror=alert(1)>" "fixture HTML was server-rendered without escaping"
  method_status=$(http_status POST "$url/api/v1/fleet")
  [ "$method_status" = 405 ] || fail "POST route was not rejected with 405: $method_status"
  missing_status=$(http_status GET "$url/../../etc/passwd")
  [ "$missing_status" = 404 ] || fail "unknown/traversal route was not rejected with 404: $missing_status"
  host_status=$(http_status GET "$url/" "dashboard.attacker.invalid")
  [ "$host_status" = 421 ] || fail "unexpected Host was not rejected with 421: $host_status"

  printf 'resolved [key=choice]: use A\nworking [key=choice]: preparing the release\n' >> "$home/state/needs-task.status"
  : > "$home/needs-busy"
  api=$(wait_for_api "$url" '(.tasks[] | select(.id == "needs-task") | .state.key == "working") and .counts.needs_captain == 0') \
    || fail "live status transition did not appear without a server restart"
  printf '%s' "$api" | jq -e '.connection.state == "live"' >/dev/null \
    || fail "connection stopped being live after status transition"

  rm -f "$home/state/working-task.meta"
  api=$(wait_for_api "$url" '([.tasks[].id] | index("working-task")) == null') \
    || fail "a disappeared task metadata file remained cached"
  printf '%s' "$api" | jq -e '.connection.state == "live"' >/dev/null \
    || fail "dashboard crashed or went stale when a task disappeared"

  PATH="$fakebin:$PATH" FM_HOME="$home" FM_DASHBOARD_PORT="$BASE_PORT" "$DASHBOARD" stop >/dev/null \
    || fail "verified dashboard stop failed"
  ! kill -0 "$pid_before" 2>/dev/null || fail "dashboard pid survived verified stop"

  out=$(cd "$other" && env -u FM_HOME FM_ROOT_OVERRIDE="$home" PATH="$fakebin:$PATH" \
    FM_DASHBOARD_PORT="$BASE_PORT" FM_DASHBOARD_REFRESH_MS=500 FM_DASHBOARD_TEST_MODE="$home" \
    "$DASHBOARD" start) || fail "root-override dashboard start failed: $out"
  url=${out##* }
  api=$(wait_for_api "$url" '.connection.state == "live" and .home.selection == "root-override"') \
    || fail "inferred-home dashboard did not become live"
  printf '%s' "$api" | jq -e '.home.diagnostic | contains("FM_HOME is unset")' >/dev/null \
    || fail "inferred home did not produce a visible mismatch diagnostic: $api"
  PATH="$fakebin:$PATH" FM_HOME="$home" FM_DASHBOARD_PORT="$BASE_PORT" "$DASHBOARD" stop >/dev/null \
    || fail "inferred-home dashboard did not stop cleanly"
  LIVE_HOMES=$(printf '%s' "$LIVE_HOMES" | sed "s# $home##")
  pass "dashboard lifecycle, projection, isolation, GET-only API, and live update are correct"
}

test_collision_fallback_and_safe_ambiguous_stop() {
  local home fakebin occupied out url selected unrelated stop_out status
  home=$(make_home collision-home)
  fakebin=$(make_fakebin "$home")
  occupied=$((BASE_PORT + 30))
  node - "$occupied" <<'NODE' &
const http = require('http');
const port = Number(process.argv[2]);
http.createServer((_request, response) => { response.writeHead(200); response.end('not a dashboard'); }).listen(port, '127.0.0.1');
NODE
  unrelated=$!
  EXTRA_PIDS="$EXTRA_PIDS $unrelated"
  sleep 0.3
  out=$(start_fixture_dashboard "$home" "$fakebin" "$occupied") || fail "collision fallback failed: $out"
  url=${out##* }
  selected=${url##*:}
  [ "$selected" -ne "$occupied" ] || fail "dashboard did not move off an occupied port"
  LIVE_HOMES="$LIVE_HOMES $home"
  PATH="$fakebin:$PATH" FM_HOME="$home" FM_DASHBOARD_PORT="$occupied" "$DASHBOARD" stop >/dev/null \
    || fail "collision-selected dashboard did not stop"
  LIVE_HOMES=$(printf '%s' "$LIVE_HOMES" | sed "s# $home##")

  printf '%s\n' "$unrelated" > "$home/state/.dashboard.pid"
  printf '%s\n' "$occupied" > "$home/state/.dashboard.port"
  status=0
  stop_out=$(PATH="$fakebin:$PATH" FM_HOME="$home" FM_DASHBOARD_PORT="$occupied" "$DASHBOARD" stop 2>&1) || status=$?
  [ "$status" -ne 0 ] || fail "ambiguous stop unexpectedly succeeded: $stop_out"
  assert_contains "$stop_out" "refusing stop" "ambiguous stop did not explain its refusal"
  kill -0 "$unrelated" 2>/dev/null || fail "ambiguous stop killed the unrelated process"
  rm -f "$home/state/.dashboard.pid" "$home/state/.dashboard.port"
  pass "port collision falls back deterministically and ambiguous teardown is safe"
}

test_slow_task_retained_cache_idle_reconnect_and_disabled_open() {
  local home fakebin out url api baseline_total stale reconnect first_after_idle marker open_out
  home=$(make_home five-task-real-home-regression)
  mkdir -p "$home/projects/working" "$home/projects/needs" "$home/projects/ci" \
    "$home/projects/paused" "$home/projects/slow"
  cat > "$home/data/backlog.md" <<'EOF'
## In flight
- [ ] needs-task - Choose fixture behavior (repo: alpha) (kind: ship) (since 2026-07-15)
- [ ] working-task - Build the dashboard (repo: alpha) (kind: ship) (since 2026-07-15)
- [ ] ci-task - Validate dashboard CI (repo: alpha) (kind: ship) (since 2026-07-15)
- [ ] paused-task - Wait for upstream release (repo: beta) (kind: scout) (since 2026-07-15)
- [ ] slow-task - Exercise bounded task reads (repo: alpha) (kind: ship) (since 2026-07-15)

## Queued

## Done
EOF
  fm_write_meta "$home/state/needs-task.meta" \
    "window=firstmate:fm-needs-task" "worktree=$home/projects/needs" "project=alpha" \
    "harness=codex" "model=default" "effort=high" "kind=ship" "mode=no-mistakes"
  printf 'needs-decision [key=choice]: choose A or B\n' > "$home/state/needs-task.status"
  fm_write_meta "$home/state/working-task.meta" \
    "window=firstmate:fm-working-task" "worktree=$home/projects/working" "project=alpha" \
    "harness=codex" "model=default" "effort=high" "kind=ship" "mode=no-mistakes"
  printf 'working: healthy sibling task\n' > "$home/state/working-task.status"
  fm_write_meta "$home/state/ci-task.meta" \
    "window=firstmate:fm-ci-task" "worktree=$home/projects/ci" "project=alpha" \
    "harness=claude" "model=default" "effort=high" "kind=ship" "mode=no-mistakes"
  printf 'working: CI checks running\n' > "$home/state/ci-task.status"
  fm_write_meta "$home/state/paused-task.meta" \
    "window=firstmate:fm-paused-task" "worktree=$home/projects/paused" "project=beta" \
    "harness=pi" "model=default" "effort=medium" "kind=scout" "mode=scout"
  printf 'paused: waiting for upstream release\n' > "$home/state/paused-task.status"
  fm_write_meta "$home/state/slow-task.meta" \
    "window=firstmate:fm-slow-task" "worktree=$home/projects/slow" "project=alpha" \
    "harness=codex" "model=default" "effort=high" "kind=ship" "mode=no-mistakes"
  printf 'working: bounded backend read fixture\n' > "$home/state/slow-task.status"
  fakebin=$(make_fakebin "$home")
  out=$(FM_DASHBOARD_IDLE_MS=1000 FM_DASHBOARD_TASK_TIMEOUT=1 \
    FM_DASHBOARD_SNAPSHOT_TIMEOUT_MS=8000 FM_DASHBOARD_STALE_MS=1000 \
    FM_DASHBOARD_EXPIRE_MS=2500 start_fixture_dashboard "$home" "$fakebin" "$((BASE_PORT + 60))") \
    || fail "slow-task fixture dashboard start failed: $out"
  url=${out##* }
  LIVE_HOMES="$LIVE_HOMES $home"

  api=$(wait_for_api "$url" '.connection.state == "live" and (.tasks | length) == 5') \
    || fail "five-task-sized regression home did not become live"
  baseline_total=$(printf '%s' "$api" | jq -r '.counts.total')
  : > "$home/slow-task"
  api=$(wait_for_api "$url" '
    .connection.state == "live"
      and (.tasks[] | select(.id == "slow-task") | .state.key == "unknown" and .state.source == "timeout")
      and (.tasks[] | select(.id == "working-task") | .state.key == "working")') \
    || fail "one slow task did not degrade independently while healthy siblings stayed live"
  rm -f "$home/slow-task"
  api=$(wait_for_api "$url" '(.tasks[] | select(.id == "slow-task") | .state.key == "working")') \
    || fail "bounded slow task did not recover on a healthy refresh"

  : > "$home/snapshot-hang"
  stale=$(wait_for_api "$url" "
    .connection.state == \"error\"
      and .connection.error == \"snapshot timed out\"
      and (.connection.error_age_seconds | type) == \"number\"
      and .connection.age_seconds >= 2
      and .counts.total == $baseline_total
      and (.tasks | length) == $baseline_total
      and ([.tasks[].state.key] | all(. == \"unknown\"))
      and ([.tasks[].state.source] | all(. == \"expired last-known-good snapshot\"))
      and ([.tasks[].decisions] | all(length == 0))
      and ([.tasks[].links] | all(length == 0))") \
    || fail "failed refresh blanked or trusted expired last-known-good task truth"
  assert_contains "$stale" '"snapshot timed out"' "timeout error was not exposed"
  rm -f "$home/snapshot-hang"
  api=$(wait_for_api "$url" "
    .connection.state == \"live\" and .connection.error == null
      and .counts.total == $baseline_total
      and (.tasks[] | select(.id == \"working-task\") | .state.key == \"working\")") \
    || fail "dashboard did not immediately recover stale last-known-good truth"

  sleep 1.7
  mkdir -p "$home/projects/reconnect"
  fm_write_meta "$home/state/reconnect-task.meta" \
    "window=firstmate:fm-reconnect-task" "worktree=$home/projects/reconnect" "project=alpha" \
    "harness=codex" "model=default" "effort=high" "kind=ship" "mode=no-mistakes"
  printf 'working: appeared while the browser was away\n' > "$home/state/reconnect-task.status"
  sleep 1.2
  first_after_idle=$(http_get "$url/api/v1/fleet") || fail "idle reconnect request failed"
  printf '%s' "$first_after_idle" | jq -e '([.tasks[].id] | index("reconnect-task")) == null' >/dev/null \
    || fail "snapshot refresh did not idle after recent client activity expired"
  reconnect=$(wait_for_api "$url" '(.tasks[] | select(.id == "reconnect-task") | .state.key == "working")') \
    || fail "reconnect did not trigger an immediate fresh fleet snapshot"
  printf '%s' "$reconnect" | jq -e '.connection.state == "live" and .connection.error == null' >/dev/null \
    || fail "stale truth persisted after reconnect recovery"

  marker="$home/open-called"
  cat > "$fakebin/open" <<SH
#!/usr/bin/env bash
touch "$marker"
SH
  chmod +x "$fakebin/open"
  open_out=$(PATH="$fakebin:$PATH" FM_HOME="$home" FM_DASHBOARD_DISABLE=1 "$DASHBOARD" open) \
    || fail "disabled open command failed: $open_out"
  assert_contains "$open_out" "disabled by FM_DASHBOARD_DISABLE" "disabled open omitted its diagnostic"
  [ ! -e "$marker" ] || fail "open command launched a browser while dashboard start was disabled"

  PATH="$fakebin:$PATH" FM_HOME="$home" "$DASHBOARD" stop >/dev/null \
    || fail "slow-task fixture dashboard did not stop cleanly"
  LIVE_HOMES=$(printf '%s' "$LIVE_HOMES" | sed "s# $home##")
  pass "slow tasks degrade independently, last-known-good truth survives timeout, reconnect refreshes, and disabled open is inert"
}

test_help_and_internal_contract
test_lifecycle_projection_isolation_and_live_update
test_collision_fallback_and_safe_ambiguous_stop
test_slow_task_retained_cache_idle_reconnect_and_disabled_open
