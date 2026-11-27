# Fork maintenance map

Use this map to preserve fork behavior when importing upstream releases, without treating every imported application as a new fork feature. It records existing changes and test entry points; it does **not** change repository checks, declare products unsupported, authorize feature removal, or certify the tests passed.

## Baseline and scope

| Item | Pinned revision |
| --- | --- |
| Incorporated upstream release | `v1.6.0` — `faac585884ae2c013a6b1400f3e9e77f10b34bac` |
| Fork snapshot | `a19f56333e1f6f6e327991a6a693b9a07b32449a` — merge of PR #17 |
| Comparison | Direct upstream-to-fork tree diff, not the release PR's three-dot diff |

The [complete path inventory](fork-patch-inventory.md) accounts for **161 paths**, **9,398 additions**, and **787 deletions**: 49 runtime files, 68 test files, 10 fixtures, 17 documentation files, and 17 build/configuration files. There are 60 CLI/agent paths, **69 p2 paths**, and 32 other paths. Shared files appear once with multiple feature IDs; counts are not estimates of complexity or test coverage.

```sh
# From the repository root; these two commits are the inventory's source of truth.
UPSTREAM=faac585884ae2c013a6b1400f3e9e77f10b34bac
FORK=a19f56333e1f6f6e327991a6a693b9a07b32449a
git merge-base --is-ancestor "$UPSTREAM" "$FORK"
git diff --no-renames --name-status "$UPSTREAM" "$FORK"
git diff --numstat "$UPSTREAM" "$FORK"
git log --no-merges --oneline "$UPSTREAM..$FORK"
```

Evidence level: diff inventory and existing test/contract mapping, **not a fresh full-file security audit or test run**. No conclusion here supersedes the incomplete PR #17 audit or its accepted unresolved defects. The historical p2 browser batch had an unresolved archive/ResizeObserver failure; a smaller passing selection must not erase it. Test presence is not proof that assertions are sufficient or that a test runs on every platform.

### Maintenance boundaries

- **CLI adoption:** packaged coding agent, SDK, agent core, runtime dependencies, host integration and fork automation. These are the user's current installation target.
- **Existing p2 maintenance:** this fork already changes Discord authority, local logout, worker lifecycle, terminal cleanup and UI readiness. Do not label those changes “upstream-only” or silently stop testing them. Whether to continue shipping/supporting p2 is a separate user decision.
- **Other imported apps:** p3 has only a trailing-blank-line difference; p2-mac has no application-source difference in this snapshot. Neither app's complete suite is proof of CLI behavior. Their executable workflows, dependencies and shared libraries still require impact review.
- **External extensions:** personal extensions and consumers outside this repository are not inventoried here. Repository tests cannot certify their compatibility or enable the guarded-owner capability in a host that does not attest support.

## Feature inventory

Paths below are repository-relative; the companion inventory lists every supporting file. “Keep” means preserve the existing behavior during updates, not that this is the final architecture.

| ID | Maintained behavior and owning boundary | Existing regression map | Maintenance direction / limit |
| --- | --- | --- | --- |
| BUILD | Fork publishing/branch-write guards in `.github/workflows/`; pinned catalog hydration in `scripts/update-model-catalog-pin.mjs`; branch CI offline builds and matching-release changelog baseline. | Catalog script tests; static workflow/job/trigger inspection; package/build checks. | Keep fork guards. No dedicated comprehensive fork-guard test identified. `publish-model-catalog.yml` also removes the upstream release-compatibility step and full-history checkout: not merely a guard. Revisit that difference before ever enabling publication. |
| BRAND | `packages/coding-agent/package.json`, `src/config.ts`, default footer: distinct launcher/title while preserving `.pi`, `PI_*` configuration and storage. Lockfiles reflect the extra bin entry. | `fork-branding.test.ts`, `footer-width.test.ts`; installed CLI smoke. | Keep small. An extension footer alone is not equivalent to a packaged launcher and default title. |
| OWNER | Agent/session/runtime own atomic admission, human intervention, lifecycle generations, queued handoff and cache-maintenance separation. `guardedOwner` is a host-attested, default-disabled SDK/extension capability. | Owner matrix and entrypoint tests below, spanning `packages/agent` and `packages/coding-agent`. | Keep core mechanism; keep consent, workflow policy and writer claims in consumers. An extension `isIdle()` check is not an atomic replacement. No upstream replacement established. |
| SEARCH | `managed-search-process.ts` and built-in `grep`/`find` join independent process acknowledgements; uncertainty retains ownership even after tool completion. `.husky/pre-commit` adds the live settlement test for selected paths. | Four managed-search test files plus OWNER tests; readiness fixture. | Keep coupled to OWNER. Leaf rg/fd only: not a shell sandbox or arbitrary descendant containment. Do not merge this with pi-env process-tree cleanup merely because both stop processes. |
| STATUS | `program-status-reporter.ts`, interactive binding and extension context: keyed background work defers terminal `done`; prompts and errors remain visible; stale owners cannot keep status alive. | Reporter, runner, startup/rebind regressions. | Small general extension API is an upstream candidate. Terminal reporting stays in core; extensions own their work keys and delivery failures. |
| DOCS | Default system-prompt documentation selection, owner API navigation, and verified source-read reuse in `AGENTS.md`. | Prompt construction/provider transcript tests; documentation-selection benchmark. | Keep distinct from product behavior. Benchmark is a bounded selection-size comparison, not proof that models obey the instruction. Moving the default policy to a personal extension would change its scope and needs a decision. |
| MODELS | AI test fixtures preserve Fireworks unsigned/budget thinking and Together mapping despite catalog churn; provider test rejects undefined models. No AI runtime/catalog-definition patch in this snapshot. | Four AI test files below. | Good upstream contribution candidates. Retain semantic assertions; retire only when equivalent upstream tests exist. |
| ENV | Rust `process` output collection and Unix/Windows pipe readers drain buffered output after child exit instead of mistaking delayed delivery for idle pipes. | Two inline Rust regressions plus existing `packages/env/test/process.test.ts`. | Shared-library correctness candidate for upstream. Native platform coverage is distinct from TypeScript build success. |
| CHORD | Surface client ignores the unbuilt empty-base snapshot on reconnect; file-order/watcher/browser fixture stabilization and a two-worker test limit. | Surface client, file summary, plugin/watcher and stylesheet tests. | Small reconnect fix is an upstream candidate. Test stabilization is not a new product feature; retain deterministic assertions and actual browser coverage. |
| DISCORD | p2 server owns link generations and revocation; worker owns lock-mirror admission; sessions own checked pause, archive/restore exclusion and worker-generation movement fences. Uploads reuse session-files cleanup. | Relay, state migration, server, lock, confinement, checked-pause and archive tests. | Existing p2 security maintenance, not a coding-agent extension candidate. Keep implementation and tests together pending an explicit support decision. |
| AUTH | p2 local owners are keyed/revoked per session; logout covers already-issued cookie renewals and live capabilities without revoking other sessions. | `devices.test.ts`; principal-shape fixture updates across affected p2 tests. | Security fix suitable for upstream. Do not revert to a shared local principal to shrink the diff. |
| RUNTIME | p2 terminal attach/close joins; aborted upload cancellation; delayed voice-switch readiness; preference-watcher startup reconciliation; WebSocket protocol-close preservation. | Per-mechanism tests below; socket test is unchanged upstream coverage. | Separate, small correctness fixes are upstream candidates. None is made safe by omitting p2 tests. |
| HARNESS | p2 POSIX watchdog/phase evidence, Chrome startup and request timeouts, fixture cleanup, authenticated dev probes and UI expectation/readiness repairs. | Watchdog/browser harness regressions plus the affected callers. | Keep until equivalent upstream fixtures land. Browser harness changes affect more tests than their own unit test. |
| FIXTURES | Coding-agent shell-timeout metadata uses controlled events; tool rendering uses sufficient width for absolute paths. | Existing regression files below. | Test-only portability changes; not a reason to alter production behavior. |
| COSMETIC | One trailing blank line removed from `apps/p3/docs/archive/base-inventory/base-inventory-sol.md`. | Diff inspection only. | Low-value noise; candidate to restore to upstream in a separately authorized cleanup. No functionality removed here. |

## Runnable validation map

These are **selection recipes**, not a replacement CI workflow, permission to skip existing checks, or passing receipts. Run from the named package with a prepared checkout. Run the complete indicated test files, not only matching test names; include unchanged callers when upstream changes their shared mechanism.

### Preparation and existing gates

From the repository root:

```sh
npm ci --ignore-scripts
node scripts/update-model-catalog-pin.mjs --hydrate
npm run build:offline
# Required after code changes; this command can format files, so inspect status afterward.
npm run check
```

Pinned hydration requires fetching the committed catalog revision. `build:offline` means it does not regenerate against the live catalog, not that dependency installation or hydration is network-free. CI tag builds still use live generation; `env.yml` uses pinned hydration. Preserve the distinction.

- The full non-e2e package run is `./test.sh`, **when authorized**. It isolates credentials and invokes package/script tests; it does not run apps/p2. Do not substitute an unrestricted full Vitest run or invoke `npm test` without authorization.
- After p2 code changes also run `cd apps/p2 && npm run check`. Broad p2 tests require separate authorization. Use Node 26 for p2 TUI fixtures and a recorded `CHROMIUM_BIN` for browser fixtures.
- Build workspace exports before tests that import `dist/` or spawn/bundle workspace consumers. For macOS capture actual Node executable, temporary root, browser version and supported concurrency; do not hide failures with new timeouts or shared fixture directories.

### OWNER and SEARCH: existing interaction coverage

Reuse [owner-admission.md](../packages/coding-agent/docs/owner-admission.md), especially its pre-review interaction matrix; do not create a second competing matrix.

```sh
# From packages/agent
node ../../node_modules/vitest/dist/cli.js --run test/prepare-next-turn-end.test.ts

# From packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run \
  test/owner-activity.test.ts test/guarded-owner.test.ts \
  test/agent-session-owner-admission.test.ts test/sdk-stream-options.test.ts \
  test/owner-extension-exec.test.ts test/interactive-mode-startup-input.test.ts \
  test/interactive-mode-compaction.test.ts test/suite/agent-session-boundaries.test.ts \
  test/suite/regressions/9068-user-bash-fail-closed.test.ts

node ../../node_modules/vitest/dist/cli.js --run \
  test/managed-search-process.test.ts test/managed-search-process-live.test.ts \
  test/managed-search-tools.test.ts test/agent-session-managed-search.test.ts
```

Preserve these assertions: rejected work never enters hooks/queues; intervention during routing/auth/headers fences dispatch; accepted human messages survive preparation/compaction exactly once with original batching; cache maintenance cannot create turns; cancellation cannot abort a later human prompt; execution completion cannot release an unsettled process claim. Use the existing matrix to select affected interactions for changes to session entrypoints, replacement/reload, provider dispatch, extension execution or search, even if `owner-activity.ts` itself is unchanged. The commands above collect the available coverage; they do not add a new blanket test gate.

Gaps: actual-rg/fd cases can skip when binaries are unavailable; live descendant tests skip Windows. A green mocked run is not binary provisioning, host attestation, deployed extension compatibility or universal process containment. The CLI does not enable guarded ownership by default.

### BRAND, STATUS, DOCS and FIXTURES

From `packages/coding-agent`, choose the affected complete rows using `node ../../node_modules/vitest/dist/cli.js --run` followed by the listed paths:

| Group | Test paths relative to packages/coding-agent | Assertions / expansion trigger |
| --- | --- | --- |
| BRAND | `test/fork-branding.test.ts`, `test/footer-width.test.ts` | Extra launcher, title/config separation, footer sizing. Expand to package/install smoke for manifest/bin changes. |
| STATUS | `test/program-status-reporter.test.ts`, `test/extensions-runner.test.ts`, `test/suite/regressions/5943-session-start-notify.test.ts`, `test/suite/regressions/startup-session-rebind-duplicate-subscription.test.ts` | Background-key lifetime, blocked/error precedence, stale UI owner, startup and replacement subscription ordering. |
| DOCS | `test/system-prompt.test.ts`, `test/system-prompt-updates.test.ts`, `test/suite/agent-session-boundaries.test.ts`, `test/suite/agent-session-compaction.test.ts` | Default/custom prompt behavior, transcript/provider propagation, threshold fixture independent of default prompt length. |
| FIXTURES | `test/suite/regressions/11613-bash-timeout-after-shell-exit.test.ts`, `test/tool-execution-component.test.ts` | Post-exit timeout metadata, rendered compact/expanded resources. The timeout regression is Unix-only. |

From root, `node packages/coding-agent/scripts/benchmark-doc-loading.mjs` checks its selected headings and safety markers. It estimates tokens from characters; it is not a model evaluation. Terminal OSC behavior and installed extension integration still need an isolated interactive smoke when affected; follow `.pi/skills/interactive-testing.md` rather than using a personal live session.

### BUILD and MODELS

```sh
# From root
node --test scripts/update-model-catalog-pin.test.mjs
npm run check:install-lock:coding-agent
# The checker selects the newest local release tag; it has no --base option.
test "$(git tag --list 'v*.*.*' --sort=-v:refname | head -n 1)" = v1.6.0
npm run check:released-changelogs

# From packages/ai
node ../../node_modules/vitest/dist/cli.js --run \
  test/anthropic-empty-thinking-signature-compat.test.ts \
  test/fireworks-model-generation.test.ts test/providers.test.ts test/together-models.test.ts
```

Use the **new matching upstream tag** instead of `v1.6.0` on the next sync. If newer local tags make this assertion fail, use an isolated validation clone with the intended tag rather than deleting shared tags or running against an unintended baseline. These AI selections use synthetic data or payload interception, not paid provider probes. Retain nonempty Fireworks coverage, the synthetic toggle-only thinking-budget assertion, and Together source-mapping assertions.

For automation changes inspect every changed workflow's triggers, permissions, secrets, publishing and branch writes, including workflows newly added upstream. Existing guards in Nix, previews, model publishing, p2-cloud and p2-mac are not evidence that all future workflows are safe. The script tests check immutable pinned hydration and hash rejection, not GitHub event evaluation. Packaging checks do not authorize publication.

### ENV and CHORD

```sh
# From packages/env: inline Rust tests, then actual daemon/client integration
cargo test --manifest-path daemon/Cargo.toml --locked waits_for_delayed_reader_delivery_after_exit
cargo test --manifest-path daemon/Cargo.toml --locked drain_reads_buffered_bytes_before_ending_an_idle_open_pipe
node ../../node_modules/vitest/dist/cli.js --run test/process.test.ts

# From packages/chord, after building workspace exports
node ../../node_modules/vitest/dist/cli.js --run \
  test/surfaces/client.test.ts test/node/app/files.test.ts \
  test/node/plugins/plugins.test.ts test/node/plugins/watcher.test.ts \
  test/node/web/styles.test.ts
```

ENV's Vitest setup builds the daemon unless `PI_ENV_DAEMON` overrides it: unset that override or prove it names the candidate binary. The pipe-idle Rust test is Unix-only; a Windows run must exercise its own changed overlapped-I/O path. CHORD's stylesheet suite uses `CHROMIUM_BIN` or `chromium-docker` on PATH and skips if neither is available; record actual test/skip counts and retain its configured two-worker limit. Read Chord's required design/spec documents before implementation or architectural review; this inventory is not such a review.

### Existing p2 changes

From `apps/p2`, use the existing runner with selected files:

```sh
node --import ./src/source.ts --test --test-concurrency=1 \
  test/p2/discord.test.ts test/p2/discord-state.test.ts \
  test/p2/discord-server.test.ts test/p2/discord-lock.test.ts \
  test/p2/discord-confinement.test.ts test/p2/checked-pause.test.ts \
  test/p2/archived-session-changes.test.ts
```

The DISCORD set maps to: generations cannot survive unlink/relink; migration grants no new authority; unlink cleanup precedes unlocking; archived cleanup excludes restore; lock synchronization fails closed; cold/nested/archived placements are checked; stale queued worker moves cannot escape confinement. These are local fixtures, not a live Discord deployment certification. Read `apps/p2/docs/plugin-practices.md` before changing their contracts or implementations.

Use the same runner with the following additional selections when affected:

| Group / mechanism | Test paths relative to apps/p2 | Assertions and limits |
| --- | --- | --- |
| AUTH | `test/p2/devices.test.ts` | Old-cookie logout covers newer renewals across restart; repeated logout cannot shorten revocation; only the logged-out local session loses live authority. Principal-type changes also require the AUTH fixture consumers in the path inventory. |
| RUNTIME terminal lifecycle | `test/p2/terminal-service.test.ts`, `test/p2/terminal-tool.test.ts` | Close joins attachment setup and fences late opens/calls; test teardown stops disposable hosts, while production detach preserves persistent hosts. Include Radius consumers when shared teardown changes. |
| RUNTIME upload cleanup | `test/p2/session-files.test.ts`, `test/p2/discord.test.ts` | Cancellation/failure releases real upload slots; bounded attachments survive; oversize files are not published. |
| RUNTIME voice readiness | `test/p2/voice-ui.test.ts`, `test/p2/voice.test.ts` | Remote switch must be ready before microphone activation; delayed-voice fixture. Browser coverage requires Chrome. |
| RUNTIME preferences | `test/p2/tui-theme.test.ts` | Startup writes reconcile even without native watcher events; stopping cancels reconciliation. |
| RUNTIME socket close | `test/p2/socket-limits.test.ts` | Existing upstream regression checks oversized-frame close code 1009 rather than losing the protocol close. This unchanged test is intentionally absent from the fork-only path inventory. |
| HARNESS | `test/p2/browser-harness.test.ts`, `test/p2/dev.test.ts`, `test/p2/radius.test.ts`, `test/p2/tool-ui-example.test.ts`, and affected `ui-*.test.ts` paths in the inventory | Complete DevTools port/page readiness, failed-start cleanup, bounded commands, authenticated probes and upstream UI expectations. Expand to all affected browser consumers; a harness-only pass is insufficient. |

The standalone watchdog regression is `node --test test/p2/test-diagnose.test.mjs` from `apps/p2` (POSIX). Follow `apps/p2/DEV.md` after a hang: retain the failing population and process evidence, diagnose before retrying, and do not treat a narrower pass as clearance of the original failure.

## Packaged CLI adoption

Build the candidate, then use existing scripts, not a new installer:

1. `node scripts/pack-packages.mjs --skip-build --out .artifacts/<unique-candidate-name>`; check manifest commit, dirty flag, package versions and integrity.
2. Wire a **disposable external npm consumer** with `scripts/use-local-packages.mjs`, then install with `npm install --ignore-scripts`. See each script's `--help` for required manifest/consumer/package arguments.
3. Run `smokeTestNpmConsumer` from `scripts/local-package-install.mjs` for `@earendil-works/pi-coding-agent`; it checks SDK imports, exports, versions and local transitive resolutions.
4. From outside the repository, check `--version`, `--help`, `--list-models`, and an isolated interactive startup with the affected extensions. Offline checks are not proof of provider authentication or successful paid inference.
5. Only when local installation is authorized, back up the live consumer manifests and update `pi-fork`. Preserve managed `pi`, check alias resolution, and retain the previous artifact set for rollback.

The local installer and package-artifact scripts are **unchanged upstream code** in this snapshot. They belong in validation, not in the maintained-patch count. Do not run release/version/publish scripts for this procedure.

## Reducing the next update's work

1. **First upstream candidates:** bounded correctness fixes (surface reconnect, pipe draining, model test fixtures, watcher/terminal cleanup) and the small background-work API. Verify upstream's current implementation before proposing or retiring anything; no newer-upstream equivalence is claimed here.
2. **Keep the OWNER/SEARCH boundary explicit:** it spans provider dispatch, human input, session replacement and subprocess lifetime. Moving policy into extensions is useful; replacing atomic core admission with extension polling is not equivalent. Reuse the existing matrix rather than expanding every update into a whole-monorepo audit.
3. **Resolve p2 support deliberately:** its 69 changed paths include security fixes and their fixtures. Either maintain that lane when impacted or separately decide its future. Do not delete it, disable tests, or call it unsupported based on CLI-only usage alone.
4. **Trim noise separately:** the p3 blank line is a low-risk cleanup candidate. Consolidate documentation where it duplicates existing contracts, not tests that establish distinct failure boundaries.
5. **Keep receipts out of this map:** each update records exact head, selected tests, runtime/browser/daemon identities, outcomes, skips and outstanding failures in its task/PR evidence. This document remains the durable selection guide, not a growing execution log.

### Refresh on every upstream sync

- Pin the new upstream tag's commit and candidate commit; verify ancestry. Keep the previous pair for explaining what changed.
- Recompute the **direct tree diff** and account for every changed path, including tests, workflows and lockfiles. Do not equate the previous-main-to-candidate release diff with fork maintenance.
- For each group inspect upstream changes to its owners **and unchanged callers**; select the relevant tests above. A changed shared fixture, dependency, public contract or lifecycle entrypoint expands the selection beyond filenames.
- For a proposed retirement, demonstrate equivalent upstream behavior with the retained regression before removing the patch; get approval for intentional functionality changes.
- Preserve repository-required checks and CI protections. Product-support or validation-policy changes require a separate explicit decision; this map makes no such change.
