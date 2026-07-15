# Fleet Dashboard

The Fleet Dashboard is a local, read-only operational view for one Firstmate home.
A lock-owning `bin/fm-session-start.sh` run starts or reuses it and prints its loopback URL.
Keep that URL open on a second screen to see live direct reports, open captain decisions, external or CI waits, failures, stale state, and recent landed work.

## Operating boundary

`bin/fm-dashboard.sh` is the single owner of dashboard process lifecycle, port selection, same-home reuse, and safe stop behavior.
Its `--help` output is the command reference for `start`, `ensure`, `status`, `url`, `stop`, and `open`, plus the supported environment settings.
The default port candidate is `7331`, collision handling is bounded, and the selected healthy port is persisted under the active home's ignored `state/` directory.
The server binds only `127.0.0.1`.

`bin/fm-dashboard-server.mjs` is the single owner of the browser surface, `fm-fleet-dashboard.v1` JSON projection, state labels, snippet bounds, redaction, cache aging, and HTTP route policy.
It consumes the existing read-only `bin/fm-fleet-snapshot.sh` contract so backend and secondmate truth stay centralized instead of being reimplemented for the UI.
The primary agent never rereads fleet files to feed the page because the dashboard process refreshes independently.

## Read-only HTTP surface

The only successful routes are `GET` or `HEAD` for `/`, `/api/v1/fleet`, and `/healthz`.
There are no browser routes for spawning, steering, merging, retrying, interrupting, stopping, executing commands, reading files, or choosing another home.
Unknown paths return `404`, non-read methods return `405`, and unexpected `Host` values return `421` to limit loopback DNS-rebinding exposure.
The API omits filesystem paths and raw backend targets.

Every refresh supplies one canonical `FM_HOME` explicitly and removes ambient operational-directory overrides before taking a bounded fleet snapshot.
The page shows a bounded home basename, stable home identity, and whether `FM_HOME` was selected explicitly.
When `FM_HOME` was inferred or only a legacy root override selected the home, the page shows a prominent diagnostic so an empty wrong-home fleet cannot look authoritative.
The returned snapshot must identify that same canonical home before any data is projected.
Task ids are validated before the dashboard performs fixed `state/<id>.meta` or `state/<id>.status` metadata reads, and symbolic links are rejected for those fixed local files.
Registered secondmate summaries still use the fleet snapshot's existing validated-home boundary and expose no secondmate home path to the browser.

## State and freshness

The dashboard presents `Needs Captain`, `Working`, `Waiting on CI / external`, `Blocked / failed`, `Done / landed`, `Standing by`, and `Unknown / stale`.
An unresolved keyed `needs-decision` event takes precedence and pins the task to the top with its bounded question.
Secondmate rows use validated structured state from the registered secondmate home when available, with the parent event remaining historical evidence only.
Recent structured `Done` backlog entries stay visible after their direct-report metadata is safely torn down.

The browser polls every three seconds while the server refreshes the read-only snapshot on its own cadence.
If refreshes fail, cached active states age to `Unknown / stale` and open decisions are suppressed until truth is fresh again.
If the failure continues, cached rows expire entirely instead of remaining stale indefinitely.

## Data safety

The API exposes a whitelist of bounded task fields and never emits `.env`, environment values, credentials, raw prompts, full reports, pane captures, full status logs, filesystem paths, or backend target identifiers.
Absolute project and worktree-derived names are reduced to safe basenames before projection.
Human-readable snippets are normalized, length-bounded, and conservatively redact common credential assignments, bearer authorization, known token prefixes, secret-bearing URL parameters, and private-key headers.
PR links are limited to GitHub pull-request URLs, while local preview links are limited to explicit `http://127.0.0.1:<port>` or `http://localhost:<port>` URLs.
The browser creates every dynamic node with `textContent` or text nodes and revalidates every link before assigning `href`.
Responses also set a restrictive content security policy, disable framing, prevent MIME sniffing, and disable caching and referrer transmission.

## Runtime files

The lifecycle writes `.dashboard.pid`, `.dashboard.port`, `.dashboard.log`, and a transient `.dashboard-start.lock/` under the active home's ignored `state/` directory.
Repeated starts reuse a responsive process only when `/healthz` proves the same hashed home identity.
Stop refuses to signal an ambiguous or mismatched pid, so stale runtime files cannot kill an unrelated process.
The dashboard log is local diagnostic state and is never served over HTTP.
