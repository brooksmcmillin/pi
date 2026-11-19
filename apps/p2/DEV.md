# p2 development

See [p2 notes](docs/p2-notes.md) for architecture, reloads and testing; [README](README.md#tui-isolation) defines
the TUI threat model. Production/data directories must not be used for tests. Commit nothing without approval.

## Server and TUI

The server supports Node 22.19+. The launcher requires Node >=26.5.1; slayer has Node 26.11.1 at
`~/.local/bin/node26`. This wrapper supplies the libraries required by that binary. From `apps/p2`:

```sh
~/.local/bin/node26 --import ./src/source.ts src/hosts/tui.ts
~/.local/bin/node26 --import ./src/source.ts src/hosts/tui.ts https://your-domain
npm run check
~/.local/bin/node26 --import ./src/source.ts --test --test-concurrency=1 test/p2/tui*.test.ts
```

To use `npm run tui`/`npm test` with this Node, put its binary directory first in PATH and supply its library path:

```sh
PATH="$HOME/node-v26.11.1-linux-x64/bin:$PATH" LD_LIBRARY_PATH="$HOME/node26-lib" npm run tui
PATH="$HOME/node-v26.11.1-linux-x64/bin:$PATH" LD_LIBRARY_PATH="$HOME/node26-lib" npm test
```

The server builds one ESM bundle through esbuild and serves it only to web-admitted owners/share guests. Facets
are never imported from the visitor's checkout. Successful server plugin reloads rebuild/publish the bundle;
the launcher swaps to a fresh worker only after readiness and terminates its predecessor. TUI-only source/import
changes count as dirty plugins. TUI imports gate facet inclusion without expanding server/worker selection.
Keybindings, theme and display settings are guest-local: the launcher reads pi's `~/.pi/agent` files
(`PI_CODING_AGENT_DIR`) and `~/.pi/p2-tui/prefs.json`, validates them and posts data to the worker, watching for
changes; `<P2_DATA_DIR>/tui.json` (`TuiPreferences`) holds only server defaults below them. Launcher `config.json`
holds only per-origin cookies.

## First test hang

After the first timeout, preserve the exact command, commit/diff, Node version, elapsed time and output.
Do not immediately rerun the same suite or infer a hook failure from an empty log. Confirm the previous
runner and its children have stopped before another attempt. Never kill unrelated Node processes.

For a permitted diagnostic attempt on macOS/Linux, use the existing Node runner under the watchdog below.
Run from `apps/p2`; the artifact directory must not already exist. Keep the original loader, selectors and
concurrency. The wall-time budget (1 hour maximum) is checked at least once per second while awake,
followed by a one-second TERM-to-KILL grace. No process can enforce a deadline during system sleep;
the watchdog checks elapsed wall time again after wake:

```sh
node scripts/test-diagnose.mjs /tmp/p2-hang-attempt-1 100 \
  --import ./src/source.ts --test --test-concurrency=1 --test-reporter=spec \
  test/p2/discord.test.ts
```

Verify selectors exist in the current checkout first; the example is not evidence that this particular
file still exists or is the failing test. Use fresh artifact directories for subsequent attempts.
`events.jsonl` records launch arguments, runtime/cwd, runner PID/process-group ID, deadline or normal exit,
cleanup and terminal status. `stdout.log`/`stderr.log` retain runner output. `phases.jsonl` is a synchronous
side channel independent of runner buffering; `node-preload` identifies each test process before source loading.
An absent preload bounds the failure to before that marker, not to a proven root cause. Logs may contain
local paths or test data: retain privately, inspect before sharing, and remove when no longer needed.

For the suspected fixture, temporarily import `phase` from `../../scripts/test-phase.mjs` (adjust the path)
and call it at module-body entry and immediately before/after setup, test body and teardown awaits:

```js
phase("setup:start");
await fixture.start();
phase("setup:end");
```

Use static labels, not credentials, prompts or payloads. Markers are inert outside the watchdog. An unmatched
start is the last observed boundary, not proof that the awaited operation caused the hang. Static imports
run before a module-body marker. Preserve the instrumentation diff with the evidence; remove temporary
markers before delivery unless deliberately retained as test diagnostics.

The watchdog returns 124 on deadline, 130/143 on interruption, or the runner's exit code. It sends TERM then
KILL to its dedicated process group even when the runner exits first. This covers ordinary inherited child
processes, not descendants that deliberately detach into another group. Do not use detached fixtures here;
if a fixture requires them, establish explicit PID ownership and cleanup before running it. Do not put a
shorter outer tool timeout around the watchdog: allow its budget plus grace and scheduler margin to finish.
Verify recorded PIDs are gone; a missing terminal event or surviving process is unresolved cleanup, not a
license to rerun. SIGKILL of the watchdog itself cannot perform cleanup.

Only rerun after a concrete change or a narrower diagnostic hypothesis informed by the retained phase
trace. If evidence still cannot distinguish startup, setup, body or teardown, stop repeated attempts and
escalate with the artifacts, exact source state and missing boundary. Never increase timeouts merely to
obtain a pass. Focused passes do not replace the original combined/full-suite validation, remove selectors,
or waive browser/TUI prerequisites. Keep full-suite validation explicitly unresolved until it actually passes
with the required authorization, runtime and fixtures. These diagnostics send no production test traffic.

Offline watchdog regression (no provider, server or browser required):

```sh
node --test test/p2/test-diagnose.test.mjs
```

It exercises silent setup/body/teardown hangs, including a blocked event loop and a TERM-resistant child,
checks bounded termination and absence of recorded processes, verifies expiry after a forward wall-clock
jump, and preserves passing/failing exit codes.
It is also included in `npm test`; it does not diagnose the historical Discord hang by itself.

## Security boundary

Do not move authentication, sockets, raw terminal management or machine access into downloaded code. The launcher
recognizes a small message protocol; unknown capabilities are denied. Only opaque chord frames use its fixed-origin
socket. Download manifests/paths, byte bounds and version hashes are validated; redirects are refused.

The trusted Worker bootstrap must drop `fs.read`, `fs.write`, `worker`, `net`, `child`, `addon`, `wasi` and `inspector`
before ANY downloaded module evaluation. Node's permission-mode workers have implicit module-read grants until
explicitly dropped. Bundle import is from an in-memory data URL. Empty env, captured/discarded stdout/stderr,
V8 limits and cheap process/V8/worker-surface taming are required. Never expose parentPort or the Worker handle.
Disable the entire fs/fs-promises function facade too: inherited numeric descriptors can bypass path-based
permission checks, including raw fd reads/writes. BroadcastChannel and environment-data APIs must not communicate
with other host workers. These restrictions precede the bundle import and are tested through built-in aliases.

All downloaded output is untrusted: it must pass the launcher's bounded, complete-sequence terminal allowlist.
Never forward raw worker output, logs, exceptions, OSC/clipboard/title/hyperlinks or image protocols. Local file,
clipboard, browser, editor and job-control capabilities exist only as launcher actions (`src/hosts/tui-actions.ts`):
each needs an explicit, launcher-owned user grant (the visitor's own key, or a confirmation in the launcher-drawn
consent screen of the exact data) with validated data, never a server-provided path, a credentialed URL or a
simulated prompt. Adding one follows p2-tui-port.md sections 3.1-3.5.

Denial of service is owner-accepted. The watchdog samples RSS/ArrayBuffers and terminates the worker over its caps,
but sampling/V8 limits cannot enforce a hard native-memory quota; memory exhaustion can affect the host. There is
no OS sandbox. Runtime vulnerabilities remain out of scope. Keep Node patched and rerun the escape tests after
runtime changes. Tests use fake providers, disposable directories and port 0; no production or paid provider calls.
