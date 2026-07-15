#!/usr/bin/env node
// fm-dashboard-server.mjs - read-only Fleet Dashboard HTTP and data owner.
//
// This file is the single owner of the dashboard's HTTP surface, public JSON
// schema, state projection, bounded snippets, redaction, and browser UI.
// bin/fm-dashboard.sh owns only process lifecycle and runtime artifacts.
// docs/fleet-dashboard.md is the human guide and points here for the contract.
//
// Public HTTP surface (GET and HEAD only):
//   /                 fixed self-contained dashboard UI
//   /api/v1/fleet     fm-fleet-dashboard.v1, with no filesystem paths
//   /healthz          bounded process identity for same-home lifecycle reuse
// Every other path is 404. Every non-GET/HEAD method is 405. There is no
// mutation, command, file, or user-selected-home endpoint.
//
// The server consumes bin/fm-fleet-snapshot.sh's read-only v1 contract in a
// bounded child process. It always supplies one canonical FM_HOME explicitly,
// removes ambient operational-directory overrides, validates the snapshot's
// home identity, and exposes only a redacted whitelist. A failed refresh ages
// to Unknown/stale and expires instead of serving cached truth indefinitely.

import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const LOOPBACK = '127.0.0.1';
const SERVER_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SERVER_FILE);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_SNAPSHOT = path.join(SCRIPT_DIR, 'fm-fleet-snapshot.sh');

function usage(stream = process.stdout) {
  stream.write(`usage: fm-dashboard-server.mjs --serve --home <path> --port <port> --home-id <id> --home-selection <kind> [--snapshot <path>]\n`);
  stream.write(`       fm-dashboard-server.mjs --daemonize --home <path> --port <port> --home-id <id> --home-selection <kind> --log <path> [--snapshot <path>]\n`);
  stream.write(`       fm-dashboard-server.mjs --probe <port> <home-id>\n`);
  stream.write(`       fm-dashboard-server.mjs --home-id <path>\n`);
  stream.write(`\nInternal server used by bin/fm-dashboard.sh. Bind address is always ${LOOPBACK}.\n`);
}

function canonicalHome(home) {
  const resolved = fs.realpathSync(home);
  if (!fs.statSync(resolved).isDirectory()) throw new Error('FM_HOME is not a directory');
  return resolved;
}

function homeId(home) {
  return crypto.createHash('sha256').update(home).digest('hex').slice(0, 12);
}

function parsePositiveInt(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) return { mode: 'help' };
  if (argv[0] === '--home-id' && argv[1] && argv.length === 2) return { mode: 'home-id', home: argv[1] };
  if (argv[0] === '--probe' && argv[1] && argv[2] && argv.length === 3) {
    return { mode: 'probe', port: parsePositiveInt(argv[1], 0, 1, 65535), homeId: argv[2] };
  }
  if (!['--serve', '--daemonize'].includes(argv[0])) return { mode: 'invalid' };
  const mode = argv[0] === '--serve' ? 'serve' : 'daemonize';
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !['--home', '--port', '--home-id', '--home-selection', '--snapshot', '--log'].includes(flag)) return { mode: 'invalid' };
    values[flag.slice(2)] = value;
  }
  return {
    mode,
    home: values.home,
    port: parsePositiveInt(values.port, 0, 1, 65535),
    homeId: values['home-id'],
    homeSelection: values['home-selection'],
    snapshot: values.snapshot || DEFAULT_SNAPSHOT,
    log: values.log,
  };
}

function probe(port, expectedHomeId) {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const request = http.get({ host: LOOPBACK, port, path: '/healthz', timeout: 700 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) request.destroy();
      });
      response.on('end', () => {
        try {
          const health = JSON.parse(body);
          if (response.statusCode === 200 && health.home_id === expectedHomeId && Number.isInteger(health.pid)) {
            process.stdout.write(`pid=${health.pid}\n`);
            resolve(true);
            return;
          }
        } catch {
          // A non-dashboard service on the port is simply not a match.
        }
        resolve(false);
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

function boundedText(value, limit = 240) {
  const normalized = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function safeProjectName(value, fallback = 'unknown') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const trimmed = raw.replace(/[\\/]+$/, '');
  const display = path.win32.isAbsolute(raw)
    ? path.win32.basename(trimmed) || fallback
    : path.isAbsolute(raw)
      ? path.basename(trimmed) || fallback
      : raw;
  return redactText(display, 100);
}

function homeIdentity(home, id, selection) {
  const isolated = home.split(path.sep).includes('.treehouse');
  const label = `${safeProjectName(path.basename(home), 'Firstmate')}${isolated ? ' · isolated worktree' : ''}`;
  let diagnostic = null;
  if (selection === 'implicit') {
    diagnostic = isolated
      ? 'Wrong home may be selected: this dashboard inferred an isolated worktree. Set FM_HOME to the operational Firstmate home.'
      : 'This dashboard inferred its home from the launcher checkout. Set FM_HOME explicitly if this is not the operational fleet.';
  } else if (selection === 'root-override') {
    diagnostic = 'FM_HOME is unset; this dashboard is using the legacy root override. Set FM_HOME explicitly to confirm the operational fleet.';
  }
  return { label, id, selection, isolated, diagnostic };
}

function redactText(value, limit = 240) {
  let text = boundedText(value, Math.max(limit * 3, 720));
  text = text
    .replace(/\b(authorization|proxy-authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1: [REDACTED]')
    .replace(/\b(api[_-]?key|token|access[_-]?token|refresh[_-]?token|pairing[_-]?token|password|passwd|secret|client[_-]?secret|cookie|session)\s*[:=]\s*(["']?)[^\s,;"']+\2/gi, '$1=[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|phx_[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED]')
    .replace(/([?&](?:token|access_token|api_key|key|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  return boundedText(text, limit);
}

function safeId(value) {
  const id = String(value ?? '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ? id : null;
}

function scopedRegularFile(root, filename, optional = false) {
  const candidate = path.join(root, filename);
  if (!candidate.startsWith(`${root}${path.sep}`)) return { safe: false, stat: null };
  try {
    const stat = fs.lstatSync(candidate);
    return { safe: stat.isFile() && !stat.isSymbolicLink(), stat };
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return { safe: true, stat: null };
    return { safe: false, stat: null };
  }
}

function parseDate(value) {
  if (!value) return null;
  const text = String(value);
  const instant = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : Date.parse(text);
  return Number.isFinite(instant) ? instant : null;
}

function secondsSince(instant, now) {
  if (!Number.isFinite(instant)) return null;
  return Math.max(0, Math.floor((now - instant) / 1000));
}

function usableInstant(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function safeLink(url, preferredKind = null) {
  if (!url) return null;
  try {
    const parsed = new URL(String(url));
    if (parsed.username || parsed.password) return null;
    for (const key of parsed.searchParams.keys()) {
      if (/^(?:token|access_token|api_key|key|secret|password)$/i.test(key)) return null;
    }
    if (parsed.protocol === 'https:' && parsed.hostname === 'github.com' && /\/pull\/\d+(?:$|[/?#])/.test(parsed.pathname)) {
      return { kind: 'pr', label: 'PR', url: parsed.href };
    }
    if (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.port) {
      return { kind: preferredKind || 'local', label: preferredKind === 'lavish' ? 'Lavish' : 'Local preview', url: parsed.href };
    }
  } catch {
    return null;
  }
  return null;
}

function linksFromText(text) {
  const matches = String(text ?? '').match(/https?:\/\/[^\s<>()"']+/g) || [];
  return matches.slice(0, 8).map((url) => safeLink(url, /\/session\//.test(url) ? 'lavish' : null)).filter(Boolean);
}

function uniqueLinks(links) {
  const seen = new Set();
  return links.filter((link) => {
    if (!link || seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  }).slice(0, 4);
}

const STATE_LABELS = Object.freeze({
  needs_captain: 'Needs Captain',
  working: 'Working',
  waiting: 'Waiting on CI / external',
  blocked: 'Blocked / failed',
  done: 'Done / landed',
  standby: 'Standing by',
  unknown: 'Unknown / stale',
});

function classifyTask(task, mate, decisions) {
  if (decisions.some((decision) => decision.verb === 'needs-decision')) return 'needs_captain';
  if (mate) {
    if (mate.current?.state === 'captain_decision') return 'needs_captain';
    if (mate.current?.state === 'active_child_work') return 'working';
    if (mate.current?.state === 'externally_held') return 'waiting';
    if (mate.current?.state === 'no_active_work') return 'standby';
    return 'unknown';
  }
  const current = task.current_state?.state || 'unknown';
  const detail = `${task.current_state?.detail || ''} ${task.hints?.last_event_text || ''}`;
  if (current === 'failed' || current === 'blocked' || decisions.some((decision) => decision.verb === 'blocked')) return 'blocked';
  if (current === 'done') return 'done';
  if (current === 'paused') return 'waiting';
  if (current === 'working' && /\b(ci|external|rate.?limit|waiting|awaiting)\b/i.test(detail)) return 'waiting';
  if (current === 'working' || current === 'parked') return 'working';
  return 'unknown';
}

function projectionDetail(task, mate, stateKey) {
  if (mate) {
    if (stateKey === 'needs_captain') return mate.decisions_open?.[0]?.summary || 'A decision is required.';
    if (stateKey === 'working') {
      const child = mate.active_children?.[0];
      return child ? `${child.id}: ${child.doing || 'work in progress'}` : 'Routed work is in progress.';
    }
    if (stateKey === 'waiting') return mate.holds?.[0]?.reason || 'Routed work is waiting on a known dependency.';
    if (stateKey === 'standby') return 'No active routed work.';
    return mate.current?.reason || 'Structured secondmate state is unavailable.';
  }
  return task.paths?.status_log?.last_event?.note
    || task.current_state?.detail
    || task.hints?.last_event_text
    || task.backlog?.title
    || 'No meaningful update is available.';
}

function projectionSource(task, mate) {
  if (mate) return mate.provenance?.selected === 'structured-home' ? 'structured secondmate home' : 'secondmate state unavailable';
  const source = task.current_state?.source || 'none';
  return source === 'none' ? 'no current source' : source;
}

function projectTask(task, snapshot, home, now) {
  const id = safeId(task.id);
  if (!id) return null;
  const stateRoot = path.join(home, 'state');
  const meta = scopedRegularFile(stateRoot, `${id}.meta`);
  const status = scopedRegularFile(stateRoot, `${id}.status`, true);
  const scopeSafe = meta.safe && status.safe;
  const mate = task.kind === 'secondmate'
    ? (snapshot.secondmate_current?.records || []).find((record) => record.id === id) || null
    : null;
  const sourceDecisions = mate?.decisions_open || task.hints?.open_decisions || [];
  const decisions = scopeSafe
    ? sourceDecisions.slice(0, 3).map((decision) => ({
      key: boundedText(decision.key || 'default', 80),
      verb: decision.verb === 'blocked' ? 'blocked' : 'needs-decision',
      question: redactText(decision.summary || '', 220),
    })).filter((decision) => decision.question)
    : [];
  let stateKey = scopeSafe ? classifyTask(task, mate, decisions) : 'unknown';
  if (task.kind === 'secondmate' && task.endpoint?.agent_alive === 'dead') stateKey = 'blocked';
  const backlog = task.backlog?.structured ? task.backlog : null;
  const started = parseDate(backlog?.since) ?? usableInstant(meta.stat?.birthtimeMs) ?? usableInstant(meta.stat?.mtimeMs);
  const updated = usableInstant(status.stat?.mtimeMs) ?? usableInstant(meta.stat?.mtimeMs);
  const detail = scopeSafe
    ? redactText(projectionDetail(task, mate, stateKey), 240)
    : 'Local task files failed the dashboard scope check.';
  const links = scopeSafe ? uniqueLinks([
    safeLink(task.pr?.url),
    ...(backlog?.links || []).map((url) => safeLink(url)),
    ...linksFromText(task.hints?.last_event_text),
    ...linksFromText(task.current_state?.detail),
    ...linksFromText(backlog?.body_excerpt),
  ]) : [];
  const project = task.kind === 'secondmate'
    ? (task.secondmate_projects || []).map((value) => safeProjectName(value, '')).filter(Boolean).join(', ') || 'fleet'
    : safeProjectName(task.project || backlog?.repo || 'unknown');
  return {
    id,
    title: redactText(backlog?.title || id, 140),
    project: redactText(project, 100),
    kind: ['ship', 'scout', 'secondmate'].includes(task.kind) ? task.kind : 'crew',
    harness: redactText(task.harness || '', 40),
    model: redactText(task.model || '', 60),
    effort: redactText(task.effort || '', 20),
    backend: redactText(task.backend || 'unknown', 24),
    age_seconds: secondsSince(started, now),
    updated_at: Number.isFinite(updated) ? new Date(updated).toISOString() : null,
    state: {
      key: stateKey,
      label: STATE_LABELS[stateKey],
      source: projectionSource(task, mate),
      detail,
      stale: false,
    },
    decisions,
    links,
    endpoint: {
      status: task.endpoint?.status === 'alive' || task.endpoint?.exists === true ? 'alive'
        : task.endpoint?.status === 'dead' || task.endpoint?.exists === false ? 'dead'
          : 'unknown',
    },
    recently_landed: false,
  };
}

function projectLanded(record, liveIds, now) {
  const id = safeId(record.id);
  if (!id || liveIds.has(id) || !record.structured || record.state !== 'done') return null;
  const completed = parseDate(record.completion?.date || record.merged || record.reported || record.done);
  const links = uniqueLinks([
    safeLink(record.pr_url),
    ...(record.links || []).map((url) => safeLink(url)),
  ]);
  return {
    id,
    title: redactText(record.title || id, 140),
    project: safeProjectName(record.repo || 'unknown'),
    kind: ['ship', 'scout'].includes(record.kind) ? record.kind : 'work',
    harness: '',
    model: '',
    effort: '',
    backend: '',
    age_seconds: secondsSince(completed, now),
    updated_at: Number.isFinite(completed) ? new Date(completed).toISOString() : null,
    state: {
      key: 'done',
      label: STATE_LABELS.done,
      source: 'backlog',
      detail: redactText(record.completion?.verb ? `${record.completion.verb} ${record.completion.date || ''}` : 'Landed.', 120),
      stale: false,
    },
    decisions: [],
    links,
    endpoint: { status: 'not_applicable' },
    recently_landed: true,
  };
}

function sortTasks(tasks) {
  const rank = { needs_captain: 0, blocked: 1, working: 2, waiting: 3, standby: 4, unknown: 5, done: 6 };
  return tasks.sort((left, right) => {
    const stateOrder = (rank[left.state.key] ?? 99) - (rank[right.state.key] ?? 99);
    if (stateOrder !== 0) return stateOrder;
    if (left.recently_landed !== right.recently_landed) return left.recently_landed ? 1 : -1;
    return left.id.localeCompare(right.id);
  });
}

function countsFor(tasks) {
  const counts = { total: tasks.length, needs_captain: 0, working: 0, waiting: 0, blocked: 0, done: 0, standby: 0, unknown: 0 };
  for (const task of tasks) counts[task.state.key] = (counts[task.state.key] || 0) + 1;
  return counts;
}

function projectSnapshot(snapshot, home, id, selection, now = Date.now()) {
  if (snapshot?.schema !== 'fm-fleet-snapshot.v1') throw new Error('unexpected snapshot schema');
  if (canonicalHome(snapshot.fm_home) !== home) throw new Error('snapshot home mismatch');
  const backlogFile = scopedRegularFile(path.join(home, 'data'), 'backlog.md', true);
  const live = (snapshot.tasks || []).map((task) => projectTask(task, snapshot, home, now)).filter(Boolean);
  const liveIds = new Set(live.map((task) => task.id));
  const landed = backlogFile.safe
    ? (snapshot.backlog?.records || []).map((record) => projectLanded(record, liveIds, now)).filter(Boolean).slice(0, 10)
    : [];
  const tasks = sortTasks([...live, ...landed]);
  return {
    schema: 'fm-fleet-dashboard.v1',
    generated_at: new Date(now).toISOString(),
    home_id: id,
    home: homeIdentity(home, id, selection),
    counts: countsFor(tasks),
    tasks,
  };
}

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>Firstmate Fleet</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0d10; --panel:#111419; --line:#252a31; --line-strong:#363d47; --text:#f0f2f5; --muted:#9199a5; --faint:#636b76; --blue:#78a9ff; --amber:#e5b567; --red:#ef7777; --green:#6ec39c; --violet:#aa95e8; --row:#0f1216; }
    * { box-sizing:border-box; }
    html, body { margin:0; min-height:100%; background:var(--bg); color:var(--text); font-family:Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { min-width:280px; }
    a { color:var(--text); text-decoration:none; }
    a:hover { color:#fff; text-decoration:underline; text-underline-offset:3px; }
    a:focus-visible { outline:2px solid var(--blue); outline-offset:3px; border-radius:2px; }
    .shell { width:min(1680px, 100%); margin:0 auto; padding:0 28px 36px; }
    header { min-height:64px; display:flex; align-items:center; justify-content:space-between; gap:24px; border-bottom:1px solid var(--line); }
    .brand { display:flex; align-items:baseline; gap:12px; min-width:0; }
    .brand strong { font-size:14px; letter-spacing:.14em; font-weight:750; }
    .brand span { color:var(--muted); font-size:12px; letter-spacing:.08em; text-transform:uppercase; }
    .connection { display:flex; align-items:center; justify-content:flex-end; gap:9px; color:var(--muted); font:12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; min-width:0; text-align:right; }
    .connection-dot { width:7px; height:7px; background:var(--faint); border-radius:50%; flex:0 0 auto; }
    .connection-dot.live { background:var(--green); box-shadow:0 0 0 3px color-mix(in srgb, var(--green) 14%, transparent); }
    .connection-dot.stale, .connection-dot.error { background:var(--red); }
    .home-context { min-width:0; min-height:40px; display:flex; align-items:center; justify-content:space-between; gap:20px; padding:9px 0; border-bottom:1px solid var(--line); }
    .home-context.warning { border-bottom-color:color-mix(in srgb, var(--amber) 55%, var(--line)); background:#13120f; box-shadow:0 0 0 100vmax #13120f; clip-path:inset(0 -100vmax); }
    .home-name { display:flex; align-items:baseline; gap:9px; min-width:0; }
    .home-name span { color:var(--faint); font-size:10px; letter-spacing:.09em; text-transform:uppercase; }
    .home-name strong { min-width:0; font:600 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap:anywhere; }
    .home-code { color:var(--faint); font:10px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .home-warning { max-width:760px; color:var(--amber); font-size:11px; line-height:1.4; text-align:right; overflow-wrap:anywhere; }
    .home-warning[hidden] { display:none; }
    .summary { display:grid; grid-template-columns:repeat(7, minmax(0, 1fr)); border-bottom:1px solid var(--line); }
    .metric { min-width:0; padding:18px 16px 16px; border-right:1px solid var(--line); }
    .metric:first-child { padding-left:0; }
    .metric:last-child { border-right:0; }
    .metric-value { display:block; font:600 24px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:-.04em; }
    .metric-label { display:block; margin-top:8px; color:var(--muted); font-size:11px; letter-spacing:.065em; text-transform:uppercase; white-space:normal; }
    .metric[data-state="needs_captain"] .metric-value { color:var(--amber); }
    .metric[data-state="blocked"] .metric-value { color:var(--red); }
    .metric[data-state="working"] .metric-value { color:var(--blue); }
    .metric[data-state="waiting"] .metric-value { color:var(--amber); }
    .metric[data-state="done"] .metric-value { color:var(--green); }
    .captain-panel { margin-top:22px; border:1px solid color-mix(in srgb, var(--amber) 52%, var(--line)); background:#15130f; }
    .captain-panel[hidden] { display:none; }
    .section-head { min-width:0; min-height:43px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:0 14px; border-bottom:1px solid var(--line); overflow:hidden; }
    .section-head > * { min-width:0; }
    .section-head h2 { margin:0; font-size:11px; letter-spacing:.105em; text-transform:uppercase; }
    .section-head span { color:var(--muted); font-size:11px; text-align:right; overflow-wrap:anywhere; }
    .decision-list { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 360px), 1fr)); }
    .decision { min-width:0; padding:14px; border-right:1px solid var(--line); border-bottom:1px solid var(--line); }
    .decision-id { color:var(--amber); font:600 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .decision-question { margin-top:7px; font-size:14px; line-height:1.45; overflow-wrap:anywhere; }
    main { margin-top:22px; border-top:1px solid var(--line-strong); }
    .fleet-table { width:100%; table-layout:fixed; border-collapse:collapse; }
    .fleet-table caption { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
    .fleet-table .col-status { width:14%; } .fleet-table .col-task { width:20%; } .fleet-table .col-project { width:14%; }
    .fleet-table .col-runtime { width:12%; } .fleet-table .col-elapsed { width:8%; } .fleet-table .col-update { width:23%; } .fleet-table .col-links { width:9%; }
    .fleet-table th { padding:10px 12px; color:var(--muted); font-size:10px; font-weight:500; letter-spacing:.09em; text-align:left; text-transform:uppercase; border-bottom:1px solid var(--line); }
    .fleet-table th:first-child, .task-row > td:first-child { padding-left:0; }
    .task-row { background:var(--row); border-bottom:1px solid var(--line); transition:background-color 120ms ease; overflow:hidden; }
    .task-row:hover { background:#14181d; }
    .task-row.needs_captain { box-shadow:inset 2px 0 0 var(--amber); }
    .task-row > td { min-width:0; padding:14px 12px; vertical-align:middle; overflow:hidden; }
    .task-row > td::before { display:none; }
    .state { display:flex; align-items:flex-start; gap:8px; font-size:11px; font-weight:650; line-height:1.35; text-transform:uppercase; letter-spacing:.055em; }
    .state-dot { width:7px; height:7px; margin-top:4px; border-radius:50%; background:var(--faint); flex:0 0 auto; }
    .state.needs_captain { color:var(--amber); } .state.needs_captain .state-dot { background:var(--amber); }
    .state.working { color:var(--blue); } .state.working .state-dot { background:var(--blue); }
    .state.waiting { color:var(--amber); } .state.waiting .state-dot { background:var(--amber); }
    .state.blocked { color:var(--red); } .state.blocked .state-dot { background:var(--red); }
    .state.done { color:var(--green); } .state.done .state-dot { background:var(--green); }
    .state.standby { color:var(--violet); } .state.standby .state-dot { background:var(--violet); }
    .task-title { font-size:14px; font-weight:650; line-height:1.35; overflow-wrap:anywhere; }
    .task-id, .secondary, .source { margin-top:5px; color:var(--muted); font-size:11px; line-height:1.4; overflow-wrap:anywhere; }
    .task-id, .runtime, .elapsed { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
    .project { font-size:12px; line-height:1.4; overflow-wrap:anywhere; }
    .kind { color:var(--muted); text-transform:uppercase; font-size:10px; letter-spacing:.07em; margin-top:5px; }
    .runtime, .elapsed { color:#c6cbd2; font-size:11px; line-height:1.45; overflow-wrap:anywhere; }
    .update { color:#d8dce2; font-size:12px; line-height:1.45; overflow-wrap:anywhere; }
    .link-list { display:flex; flex-wrap:wrap; gap:7px 11px; min-width:0; }
    .link-list a { max-width:100%; overflow-wrap:anywhere; font-size:11px; font-weight:600; border-bottom:1px solid var(--line-strong); padding-bottom:2px; }
    .empty { padding:56px 0; text-align:center; color:var(--muted); border-bottom:1px solid var(--line); }
    footer { display:flex; justify-content:space-between; gap:20px; padding-top:12px; color:var(--faint); font:10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
    @media (max-width:1050px) {
      .summary { grid-template-columns:repeat(4,minmax(0,1fr)); }
      .metric:nth-child(4) { border-right:0; }
      .metric:nth-child(n+5) { border-top:1px solid var(--line); }
      .fleet-table th, .task-row > td { padding-left:9px; padding-right:9px; }
      .fleet-table th:first-child, .task-row > td:first-child { padding-left:0; }
      .fleet-table .col-status { width:15%; } .fleet-table .col-task { width:20%; } .fleet-table .col-project { width:13%; }
      .fleet-table .col-runtime { width:12%; } .fleet-table .col-elapsed { width:8%; } .fleet-table .col-update { width:24%; } .fleet-table .col-links { width:8%; }
    }
    @media (max-width:720px) {
      .shell { padding:0 16px 24px; }
      header { align-items:flex-start; padding:16px 0; flex-direction:column; gap:10px; }
      .connection { text-align:left; }
      .home-context { align-items:flex-start; flex-direction:column; gap:5px; padding:10px 0; }
      .home-warning { text-align:left; }
      .summary { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .metric, .metric:first-child { padding:14px 10px 13px; border-right:1px solid var(--line); border-top:1px solid var(--line); }
      .metric:nth-child(2n) { border-right:0; }
      .metric:nth-child(-n+2) { border-top:0; }
      .metric:last-child { grid-column:1 / -1; border-right:0; }
      .metric-value { font-size:21px; }
      main { border-top:0; }
      .fleet-table, .fleet-table tbody { display:block; width:100%; }
      .fleet-table thead { display:none; }
      .task-row { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr); padding:13px 0; }
      .task-row > td, .task-row > td:first-child { display:block; width:auto; padding:7px 12px; overflow:hidden; }
      .task-row > td::before { content:attr(data-label); display:block; margin-bottom:5px; color:var(--faint); font-size:9px; font-weight:550; letter-spacing:.09em; line-height:1.2; text-transform:uppercase; }
      .task-row > td:nth-child(1)::before, .task-row > td:nth-child(2)::before { display:none; }
      .task-row > td:nth-child(1), .task-row > td:nth-child(2), .task-row > td:nth-child(3), .task-row > td:nth-child(6), .task-row > td:nth-child(7) { grid-column:1 / -1; }
      .task-row > td:nth-child(7) { padding-top:6px; }
      .empty-row { display:block; }
      .empty-row .empty { display:block; width:100%; }
      footer { flex-direction:column; gap:3px; }
    }
    @media (prefers-reduced-motion: reduce) { .task-row { transition:none; } }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand"><strong>FIRSTMATE</strong><span>Fleet / live operations</span></div>
      <div class="connection" aria-live="polite"><span id="connection-dot" class="connection-dot"></span><span id="connection-text">Connecting…</span></div>
    </header>
    <section id="home-context" class="home-context" aria-label="Dashboard home">
      <div class="home-name"><span>Operational home</span><strong id="home-label">Resolving…</strong><code id="home-code"></code></div>
      <div id="home-warning" class="home-warning" role="status" hidden></div>
    </section>
    <section id="summary" class="summary" aria-label="Fleet summary"></section>
    <section id="captain-panel" class="captain-panel" hidden>
      <div class="section-head"><h2>Needs Captain</h2><span id="decision-count"></span></div>
      <div id="decision-list" class="decision-list"></div>
    </section>
    <main>
      <div class="section-head"><h2>Fleet activity</h2><span id="fleet-note">Live direct reports and recent landed work</span></div>
      <table class="fleet-table">
        <caption>Current Firstmate direct reports and recently landed work</caption>
        <colgroup><col class="col-status"><col class="col-task"><col class="col-project"><col class="col-runtime"><col class="col-elapsed"><col class="col-update"><col class="col-links"></colgroup>
        <thead><tr><th scope="col">Status</th><th scope="col">Task</th><th scope="col">Project / kind</th><th scope="col">Runtime</th><th scope="col">Elapsed</th><th scope="col">Last meaningful update</th><th scope="col">Links</th></tr></thead>
        <tbody id="tasks"></tbody>
      </table>
    </main>
    <footer><span id="home-id">Home —</span><span>Read-only · updates every 3 seconds</span></footer>
  </div>
  <script>
    const POLL_MS = 3000;
    const summaryOrder = [
      ['needs_captain', 'Needs Captain'], ['working', 'Working'], ['waiting', 'Waiting'],
      ['blocked', 'Blocked / failed'], ['done', 'Done / landed'], ['standby', 'Standing by'], ['unknown', 'Unknown / stale']
    ];
    const tasksRoot = document.getElementById('tasks');
    const captainPanel = document.getElementById('captain-panel');
    const decisionList = document.getElementById('decision-list');
    const connectionText = document.getElementById('connection-text');
    const connectionDot = document.getElementById('connection-dot');
    const text = (value) => document.createTextNode(String(value ?? ''));
    function el(tag, className, value) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (value !== undefined) node.append(text(value));
      return node;
    }
    function formatDuration(seconds) {
      if (!Number.isFinite(seconds)) return '—';
      if (seconds < 60) return '<1m';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
      if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
      return Math.floor(seconds / 86400) + 'd ' + Math.floor((seconds % 86400) / 3600) + 'h';
    }
    function safeHref(value) {
      try {
        const url = new URL(value);
        if (url.username || url.password) return null;
        if (url.protocol === 'https:' && url.hostname === 'github.com' && /\/pull\/\d+/.test(url.pathname)) return url.href;
        if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port) return url.href;
      } catch {}
      return null;
    }
    function renderSummary(counts) {
      const nodes = summaryOrder.map(([key, label]) => {
        const metric = el('div', 'metric');
        metric.dataset.state = key;
        metric.append(el('span', 'metric-value', counts?.[key] ?? 0), el('span', 'metric-label', label));
        return metric;
      });
      document.getElementById('summary').replaceChildren(...nodes);
    }
    function renderDecisions(tasks) {
      const decisions = tasks.flatMap((task) => (task.decisions || []).filter((item) => item.verb === 'needs-decision').map((item) => ({ task, item })));
      captainPanel.hidden = decisions.length === 0;
      document.getElementById('decision-count').textContent = decisions.length ? decisions.length + (decisions.length === 1 ? ' open decision' : ' open decisions') : '';
      decisionList.replaceChildren(...decisions.map(({ task, item }) => {
        const card = el('div', 'decision');
        card.append(el('div', 'decision-id', task.id + ' · ' + task.project), el('div', 'decision-question', item.question));
        return card;
      }));
    }
    function renderTask(task) {
      const row = el('tr', 'task-row ' + task.state.key);
      const stateCell = el('td');
      const state = el('div', 'state ' + task.state.key);
      state.append(el('span', 'state-dot'), el('span', '', task.state.label));
      stateCell.append(state, el('div', 'source', task.state.source));
      const taskCell = el('td');
      taskCell.append(el('div', 'task-title', task.title), el('div', 'task-id', task.id));
      const projectCell = el('td');
      projectCell.append(el('div', 'project', task.project), el('div', 'kind', task.kind + (task.recently_landed ? ' · recent' : '')));
      const runtimeBits = [task.harness, task.model && task.model !== 'default' ? task.model : '', task.effort && task.effort !== 'default' ? task.effort : '', task.backend].filter(Boolean);
      const runtimeCell = el('td', 'runtime', runtimeBits.length ? runtimeBits.join(' / ') : '—');
      const elapsedCell = el('td', 'elapsed', formatDuration(task.age_seconds));
      const updateCell = el('td', 'update', task.state.detail);
      const linksCell = el('td');
      const linksList = el('div', 'link-list');
      [stateCell, taskCell, projectCell, runtimeCell, elapsedCell, updateCell, linksCell].forEach((cell, index) => {
        cell.dataset.label = ['Status', 'Task', 'Project / kind', 'Runtime', 'Elapsed', 'Last meaningful update', 'Links'][index];
      });
      (task.links || []).forEach((link) => {
        const href = safeHref(link.url);
        if (!href) return;
        const anchor = el('a', '', link.label);
        anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noreferrer noopener';
        linksList.append(anchor);
      });
      if (!linksList.childNodes.length) linksList.append(el('span', 'secondary', '—'));
      linksCell.append(linksList);
      row.append(stateCell, taskCell, projectCell, runtimeCell, elapsedCell, updateCell, linksCell);
      return row;
    }
    function render(payload) {
      renderSummary(payload.counts || {});
      renderDecisions(payload.tasks || []);
      const rows = (payload.tasks || []).map(renderTask);
      if (rows.length) {
        tasksRoot.replaceChildren(...rows);
      } else {
        const emptyRow = el('tr', 'empty-row');
        const emptyCell = el('td', 'empty', 'No current direct reports or recent landed work.');
        emptyCell.colSpan = 7;
        emptyRow.append(emptyCell);
        tasksRoot.replaceChildren(emptyRow);
      }
      const home = payload.home || { label: 'Unknown home', id: payload.home_id || '—', diagnostic: 'Dashboard home identity is unavailable.' };
      document.getElementById('home-label').textContent = home.label || 'Unknown home';
      document.getElementById('home-code').textContent = home.id ? '· ' + home.id : '';
      const homeContext = document.getElementById('home-context');
      const homeWarning = document.getElementById('home-warning');
      homeWarning.hidden = !home.diagnostic;
      homeWarning.textContent = home.diagnostic || '';
      homeContext.classList.toggle('warning', Boolean(home.diagnostic));
      document.getElementById('home-id').textContent = 'Home ' + (home.label || '—') + (home.id ? ' · ' + home.id : '');
      const connection = payload.connection || { state: 'error' };
      connectionDot.className = 'connection-dot ' + connection.state;
      const age = Number.isFinite(connection.age_seconds) ? formatDuration(connection.age_seconds) + ' ago' : 'not yet';
      connectionText.textContent = connection.state === 'live' ? 'Live · refreshed ' + age : (connection.state === 'starting' ? 'Connecting…' : 'State ' + connection.state + ' · last good refresh ' + age);
    }
    async function poll() {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await fetch('/api/v1/fleet', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        render(await response.json());
      } catch {
        connectionDot.className = 'connection-dot error';
        connectionText.textContent = 'Connection lost · retrying';
      } finally {
        clearTimeout(timeout);
      }
    }
    poll();
    setInterval(poll, POLL_MS);
  </script>
</body>
</html>`;

function securityHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, max-age=0',
    'Content-Security-Policy': "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };
}

function daemonize(config) {
  const expectedLog = path.join(config.home, 'state', '.dashboard.log');
  if (!config.log || path.resolve(config.log) !== expectedLog) throw new Error('invalid daemon log');
  fs.mkdirSync(path.dirname(expectedLog), { recursive: true });
  const logFd = fs.openSync(expectedLog, 'a', 0o600);
  const child = childProcess.spawn(process.execPath, [
    SERVER_FILE,
    '--serve',
    '--home', config.home,
    '--port', String(config.port),
    '--home-id', config.homeId,
    '--home-selection', config.homeSelection,
    '--snapshot', config.snapshot,
  ], {
    cwd: REPO_ROOT,
    env: process.env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);
  process.stdout.write(`${child.pid}\n`);
}

function serve(config) {
  const refreshMs = parsePositiveInt(process.env.FM_DASHBOARD_REFRESH_MS, 2500, 500, 30000);
  const staleMs = parsePositiveInt(process.env.FM_DASHBOARD_STALE_MS, Math.max(12000, refreshMs * 4), refreshMs * 2, 300000);
  const expireMs = parsePositiveInt(process.env.FM_DASHBOARD_EXPIRE_MS, Math.max(60000, staleMs * 4), staleMs * 2, 900000);
  const timeoutMs = parsePositiveInt(process.env.FM_DASHBOARD_SNAPSHOT_TIMEOUT_MS, 10000, 1000, 60000);
  const maxBuffer = parsePositiveInt(process.env.FM_DASHBOARD_SNAPSHOT_MAX_BYTES, 2 * 1024 * 1024, 65536, 8 * 1024 * 1024);
  const idleMs = parsePositiveInt(process.env.FM_DASHBOARD_IDLE_MS, Math.max(30000, refreshMs * 6), refreshMs, 600000);
  const expectedHost = `${LOOPBACK}:${config.port}`;
  let refreshing = false;
  let stopped = false;
  let lastSuccess = 0;
  let lastError = null;
  let projected = null;
  let activeChild = null;
  let lastClientActivity = Date.now();

  function refresh() {
    if (refreshing || stopped) return;
    refreshing = true;
    const environment = { ...process.env };
    for (const key of ['FM_ROOT_OVERRIDE', 'FM_STATE_OVERRIDE', 'FM_DATA_OVERRIDE', 'FM_CONFIG_OVERRIDE', 'FM_PROJECTS_OVERRIDE']) delete environment[key];
    Object.assign(environment, {
      FM_HOME: config.home,
      FM_CREW_STATE_NM_TIMEOUT: environment.FM_DASHBOARD_CREW_STATE_TIMEOUT || '1',
      FM_SNAPSHOT_SECONDMATE_TIMEOUT: environment.FM_DASHBOARD_SECONDMATE_TIMEOUT || '2',
      FM_SNAPSHOT_SECONDMATE_MAX_BYTES: environment.FM_DASHBOARD_SECONDMATE_MAX_BYTES || '131072',
      FM_SNAPSHOT_TERMINAL_LINES: environment.FM_DASHBOARD_TERMINAL_LINES || '4',
      FM_SNAPSHOT_TERMINAL_BYTES: environment.FM_DASHBOARD_TERMINAL_BYTES || '2048',
      FM_SNAPSHOT_PARENT_ACTIVITY_LINES: environment.FM_DASHBOARD_STATUS_LINES || '256',
      FM_SNAPSHOT_PARENT_ACTIVITY_BYTES: environment.FM_DASHBOARD_STATUS_BYTES || '65536',
      LC_ALL: 'C',
    });
    activeChild = childProcess.execFile(config.snapshot, ['--json'], {
      cwd: REPO_ROOT,
      env: environment,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer,
      windowsHide: true,
    }, (error, stdout) => {
      activeChild = null;
      refreshing = false;
      if (stopped) return;
      if (error) {
        lastError = error.killed ? 'snapshot timed out' : 'snapshot unavailable';
        return;
      }
      try {
        const snapshot = JSON.parse(stdout);
        projected = projectSnapshot(snapshot, config.home, config.homeId, config.homeSelection);
        lastSuccess = Date.now();
        lastError = null;
      } catch {
        lastError = 'snapshot was invalid';
      }
    });
  }

  function responsePayload() {
    const now = Date.now();
    const age = lastSuccess ? Math.max(0, Math.floor((now - lastSuccess) / 1000)) : null;
    const ageMs = lastSuccess ? now - lastSuccess : Number.POSITIVE_INFINITY;
    if (!projected) {
      return {
        schema: 'fm-fleet-dashboard.v1',
        generated_at: new Date(now).toISOString(),
        home_id: config.homeId,
        home: homeIdentity(config.home, config.homeId, config.homeSelection),
        connection: { state: lastError ? 'error' : 'starting', age_seconds: age, error: lastError },
        counts: countsFor([]),
        tasks: [],
      };
    }
    if (ageMs >= expireMs) {
      return {
        ...projected,
        generated_at: new Date(now).toISOString(),
        connection: { state: 'error', age_seconds: age, error: lastError || 'snapshot expired' },
        counts: countsFor([]),
        tasks: [],
      };
    }
    const stale = ageMs >= staleMs;
    const tasks = stale ? projected.tasks.map((task) => ({
      ...task,
      state: {
        key: 'unknown', label: STATE_LABELS.unknown, source: 'expired dashboard snapshot',
        detail: `Last reliable snapshot was ${age} seconds ago.`, stale: true,
      },
      decisions: [],
    })) : projected.tasks;
    return {
      ...projected,
      generated_at: new Date(now).toISOString(),
      connection: { state: stale ? 'stale' : 'live', age_seconds: age, error: stale ? lastError : null },
      counts: countsFor(tasks),
      tasks,
    };
  }

  const server = http.createServer((request, response) => {
    const method = request.method || 'GET';
    if (!['GET', 'HEAD'].includes(method)) {
      response.writeHead(405, { ...securityHeaders('text/plain; charset=utf-8'), Allow: 'GET, HEAD' });
      response.end(method === 'HEAD' ? undefined : 'Method not allowed\n');
      return;
    }
    const host = String(request.headers.host || '').toLowerCase();
    if (![expectedHost, `localhost:${config.port}`].includes(host)) {
      response.writeHead(421, securityHeaders('text/plain; charset=utf-8'));
      response.end(method === 'HEAD' ? undefined : 'Misdirected request\n');
      return;
    }
    let pathname;
    try {
      pathname = new URL(request.url || '/', `http://${expectedHost}`).pathname;
    } catch {
      response.writeHead(400, securityHeaders('text/plain; charset=utf-8'));
      response.end(method === 'HEAD' ? undefined : 'Bad request\n');
      return;
    }
    if (pathname === '/') {
      response.writeHead(200, securityHeaders('text/html; charset=utf-8'));
      response.end(method === 'HEAD' ? undefined : HTML);
      return;
    }
    if (pathname === '/healthz') {
      const body = JSON.stringify({ schema: 'fm-dashboard-health.v1', home_id: config.homeId, pid: process.pid, ready: Boolean(projected) });
      response.writeHead(200, securityHeaders('application/json; charset=utf-8'));
      response.end(method === 'HEAD' ? undefined : body);
      return;
    }
    if (pathname === '/api/v1/fleet') {
      lastClientActivity = Date.now();
      if (!refreshing && (!lastSuccess || Date.now() - lastSuccess >= refreshMs)) refresh();
      const body = JSON.stringify(responsePayload());
      response.writeHead(200, securityHeaders('application/json; charset=utf-8'));
      response.end(method === 'HEAD' ? undefined : body);
      return;
    }
    response.writeHead(404, securityHeaders('text/plain; charset=utf-8'));
    response.end(method === 'HEAD' ? undefined : 'Not found\n');
  });

  function shutdown() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (activeChild) activeChild.kill('SIGTERM');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  }

  server.on('error', (error) => {
    process.stderr.write(`fm-dashboard-server: ${error.code === 'EADDRINUSE' ? 'port unavailable' : 'server failed'}\n`);
    process.exit(1);
  });
  server.listen(config.port, LOOPBACK, () => refresh());
  const timer = setInterval(() => {
    if (Date.now() - lastClientActivity > idleMs) return;
    refresh();
  }, refreshMs);
  timer.unref();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const args = parseArgs(process.argv.slice(2));
if (args.mode === 'help') {
  usage();
} else if (args.mode === 'invalid') {
  usage(process.stderr);
  process.exitCode = 2;
} else if (args.mode === 'home-id') {
  try {
    process.stdout.write(`${homeId(canonicalHome(args.home))}\n`);
  } catch {
    process.stderr.write('fm-dashboard-server: invalid home\n');
    process.exitCode = 2;
  }
} else if (args.mode === 'probe') {
  const matched = await probe(args.port, args.homeId);
  if (!matched) process.exitCode = 1;
} else {
  try {
    if (!args.home || !args.port || !args.homeId || !['explicit', 'root-override', 'implicit'].includes(args.homeSelection)) {
      throw new Error('missing serve argument');
    }
    const home = canonicalHome(args.home);
    if (homeId(home) !== args.homeId) throw new Error('home identity mismatch');
    const snapshot = fs.realpathSync(args.snapshot);
    if (!snapshot.startsWith(`${SCRIPT_DIR}${path.sep}`) || path.basename(snapshot) !== 'fm-fleet-snapshot.sh') {
      throw new Error('snapshot command is outside the Firstmate toolbelt');
    }
    const config = { ...args, home, snapshot };
    if (args.mode === 'daemonize') daemonize(config);
    else serve(config);
  } catch {
    process.stderr.write('fm-dashboard-server: invalid configuration\n');
    process.exitCode = 2;
  }
}
