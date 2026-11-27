# Fork-only path inventory

Companion to [the maintenance map](fork-maintenance.md). This is a snapshot, not a list of all files to test.

- Upstream: `v1.6.0`, `faac585884ae2c013a6b1400f3e9e77f10b34bac`.
- Fork: `a19f56333e1f6f6e327991a6a693b9a07b32449a` (merged PR #17).
- Direct tree comparison, **not** a three-dot PR comparison.
- 161 changed paths; 9,398 additions, 787 deletions.
- Roles: 17 build/config, 17 docs, 10 fixture, 49 runtime, 68 test. Role describes the file, not its risk or assertion coverage.
- Subsystems: 60 CLI/agent, 32 other, 69 p2.
- Shared files have multiple group IDs. A fixture-only edit does not imply a new production feature.
- This documentation change is intentionally outside the pinned snapshot; include it under DOCS at the next refresh.

Regenerate the input with `git diff --no-renames --name-status faac585884ae2c013a6b1400f3e9e77f10b34bac a19f56333e1f6f6e327991a6a693b9a07b32449a` and classify every path. Confirm counts with `git diff --numstat faac585884ae2c013a6b1400f3e9e77f10b34bac a19f56333e1f6f6e327991a6a693b9a07b32449a`. Group definitions and validation commands are in the maintenance map.

| Status | Path (repository-relative) | Group | Role | + / - |
| --- | --- | --- | --- | ---: |
| M | `.github/workflows/ci.yml` | BUILD | build/config | 15 / 8 |
| M | `.github/workflows/env.yml` | BUILD | build/config | 4 / 1 |
| M | `.github/workflows/nix.yml` | BUILD | build/config | 2 / 2 |
| M | `.github/workflows/p2-cloud-bundle.yml` | BUILD | build/config | 3 / 2 |
| M | `.github/workflows/p2-mac-nightly.yml` | BUILD | build/config | 1 / 0 |
| M | `.github/workflows/preview-packages.yml` | BUILD | build/config | 2 / 0 |
| M | `.github/workflows/publish-model-catalog.yml` | BUILD | build/config | 1 / 8 |
| M | `.husky/pre-commit` | SEARCH | build/config | 12 / 1 |
| M | `AGENTS.md` | DOCS | docs | 1 / 1 |
| M | `apps/p2/DEV.md` | HARNESS | docs | 66 / 0 |
| M | `apps/p2/docs/discord.md` | DISCORD | docs | 11 / 6 |
| M | `apps/p2/docs/p2-notes.md` | DISCORD, AUTH | docs | 13 / 9 |
| M | `apps/p2/docs/remote-envs.md` | DISCORD | docs | 6 / 0 |
| M | `apps/p2/package.json` | HARNESS | build/config | 1 / 1 |
| M | `apps/p2/plugins/devices/owner-access.ts` | AUTH | runtime | 6 / 1 |
| M | `apps/p2/plugins/devices/server.ts` | AUTH | runtime | 4 / 2 |
| M | `apps/p2/plugins/discord/contract.ts` | DISCORD | runtime | 36 / 12 |
| M | `apps/p2/plugins/discord/relay.ts` | DISCORD | runtime | 134 / 42 |
| M | `apps/p2/plugins/discord/server.ts` | DISCORD | runtime | 201 / 84 |
| M | `apps/p2/plugins/discord/worker.ts` | DISCORD | runtime | 239 / 150 |
| M | `apps/p2/plugins/locations/server.ts` | DISCORD | runtime | 1 / 1 |
| A | `apps/p2/plugins/sessions/contract.server.ts` | DISCORD | runtime | 30 / 0 |
| M | `apps/p2/plugins/sessions/contract.ts` | DISCORD | runtime | 19 / 15 |
| M | `apps/p2/plugins/sessions/lock-worker.ts` | DISCORD | runtime | 37 / 19 |
| M | `apps/p2/plugins/sessions/server.ts` | DISCORD | runtime | 105 / 19 |
| M | `apps/p2/plugins/terminals/detached.ts` | RUNTIME | runtime | 7 / 4 |
| M | `apps/p2/plugins/terminals/service.ts` | RUNTIME | runtime | 28 / 12 |
| M | `apps/p2/plugins/voice/web.tsx` | RUNTIME | runtime | 2 / 1 |
| A | `apps/p2/scripts/test-diagnose.mjs` | HARNESS | build/config | 82 / 0 |
| A | `apps/p2/scripts/test-phase.mjs` | HARNESS | build/config | 13 / 0 |
| M | `apps/p2/src/hosts/session-workers.ts` | DISCORD | runtime | 44 / 1 |
| M | `apps/p2/src/hosts/socket-limits.ts` | RUNTIME | runtime | 5 / 2 |
| M | `apps/p2/src/hosts/tui-local-preferences.ts` | RUNTIME | runtime | 2 / 0 |
| M | `apps/p2/src/runtime/principals.ts` | AUTH | runtime | 11 / 7 |
| M | `apps/p2/src/runtime/server.ts` | DISCORD, AUTH | runtime | 15 / 4 |
| M | `apps/p2/src/runtime/session-files.ts` | DISCORD, RUNTIME | runtime | 3 / 2 |
| A | `apps/p2/test/fixtures/delayed-voice-mode.ts` | RUNTIME | fixture | 24 / 0 |
| A | `apps/p2/test/fixtures/diagnostic-clock-jump.mjs` | HARNESS | fixture | 5 / 0 |
| A | `apps/p2/test/fixtures/diagnostic-hang.mjs` | HARNESS | fixture | 36 / 0 |
| A | `apps/p2/test/p2/archived-session-changes.test.ts` | DISCORD | test | 116 / 0 |
| A | `apps/p2/test/p2/browser-harness.test.ts` | HARNESS | test | 93 / 0 |
| M | `apps/p2/test/p2/browser.ts` | HARNESS | fixture | 84 / 18 |
| M | `apps/p2/test/p2/chat-mode.test.ts` | AUTH | test | 1 / 1 |
| A | `apps/p2/test/p2/checked-pause.test.ts` | DISCORD | test | 182 / 0 |
| M | `apps/p2/test/p2/dev.test.ts` | HARNESS | test | 14 / 4 |
| M | `apps/p2/test/p2/devices.test.ts` | AUTH | test | 88 / 1 |
| A | `apps/p2/test/p2/discord-confinement-contract.ts` | DISCORD | fixture | 35 / 0 |
| A | `apps/p2/test/p2/discord-confinement-worker.ts` | DISCORD | fixture | 228 / 0 |
| A | `apps/p2/test/p2/discord-confinement.test.ts` | DISCORD | test | 565 / 0 |
| A | `apps/p2/test/p2/discord-lock.test.ts` | DISCORD | test | 440 / 0 |
| A | `apps/p2/test/p2/discord-server.test.ts` | DISCORD | test | 337 / 0 |
| A | `apps/p2/test/p2/discord-state.test.ts` | DISCORD | test | 143 / 0 |
| M | `apps/p2/test/p2/discord.test.ts` | DISCORD | test | 483 / 36 |
| M | `apps/p2/test/p2/helpers.ts` | DISCORD, RUNTIME, HARNESS | fixture | 18 / 0 |
| M | `apps/p2/test/p2/login-owners.test.ts` | AUTH | test | 1 / 1 |
| M | `apps/p2/test/p2/mcp-sign-in.test.ts` | AUTH | test | 1 / 1 |
| M | `apps/p2/test/p2/mcp.test.ts` | AUTH | test | 1 / 1 |
| M | `apps/p2/test/p2/radius-fixture.ts` | RUNTIME | fixture | 13 / 2 |
| M | `apps/p2/test/p2/radius.test.ts` | HARNESS | test | 1 / 1 |
| M | `apps/p2/test/p2/relocate.test.ts` | AUTH | test | 1 / 1 |
| M | `apps/p2/test/p2/remote-login.test.ts` | AUTH | test | 5 / 1 |
| A | `apps/p2/test/p2/session-files.test.ts` | RUNTIME | test | 59 / 0 |
| M | `apps/p2/test/p2/sharing.test.ts` | AUTH | test | 1 / 1 |
| M | `apps/p2/test/p2/shell.test.ts` | AUTH | test | 1 / 1 |
| M | `apps/p2/test/p2/terminal-service.test.ts` | RUNTIME | test | 63 / 2 |
| M | `apps/p2/test/p2/terminal-tool.test.ts` | RUNTIME | test | 3 / 7 |
| A | `apps/p2/test/p2/test-diagnose.test.mjs` | HARNESS | test | 106 / 0 |
| M | `apps/p2/test/p2/test-host.test.ts` | AUTH | test | 1 / 1 |
| M | `apps/p2/test/p2/tool-ui-example.test.ts` | HARNESS | test | 2 / 5 |
| M | `apps/p2/test/p2/tui-fixture.ts` | AUTH | fixture | 1 / 1 |
| M | `apps/p2/test/p2/tui-theme.test.ts` | RUNTIME | test | 29 / 0 |
| M | `apps/p2/test/p2/ui-detail.test.ts` | HARNESS | test | 1 / 1 |
| M | `apps/p2/test/p2/ui-gestures-reload.test.ts` | HARNESS | test | 10 / 4 |
| M | `apps/p2/test/p2/ui-haptics.test.ts` | HARNESS | test | 2 / 0 |
| M | `apps/p2/test/p2/ui-incoming.test.ts` | HARNESS | test | 3 / 1 |
| M | `apps/p2/test/p2/ui-mobile-fixes.test.ts` | HARNESS | test | 3 / 4 |
| M | `apps/p2/test/p2/voice-ui.test.ts` | RUNTIME | test | 49 / 0 |
| M | `apps/p2/test/p2/voice.test.ts` | AUTH, RUNTIME | test | 7 / 2 |
| M | `apps/p3/docs/archive/base-inventory/base-inventory-sol.md` | COSMETIC | docs | 0 / 1 |
| M | `package-lock.json` | BRAND | build/config | 2 / 1 |
| M | `packages/agent/src/agent-loop.ts` | OWNER | runtime | 13 / 0 |
| M | `packages/agent/src/agent.ts` | OWNER | runtime | 16 / 3 |
| M | `packages/agent/src/types.ts` | OWNER | runtime | 13 / 2 |
| A | `packages/agent/test/prepare-next-turn-end.test.ts` | OWNER | test | 142 / 0 |
| M | `packages/ai/CHANGELOG.md` | MODELS | docs | 6 / 0 |
| M | `packages/ai/catalog/README.md` | BUILD | docs | 6 / 0 |
| M | `packages/ai/test/anthropic-empty-thinking-signature-compat.test.ts` | MODELS | test | 9 / 9 |
| M | `packages/ai/test/fireworks-model-generation.test.ts` | MODELS | test | 20 / 0 |
| M | `packages/ai/test/providers.test.ts` | MODELS | test | 3 / 3 |
| M | `packages/ai/test/together-models.test.ts` | MODELS | test | 43 / 6 |
| M | `packages/chord/src/node/surfaces/surface-build.ts` | CHORD | runtime | 1 / 1 |
| M | `packages/chord/src/surfaces/client.ts` | CHORD | runtime | 2 / 0 |
| M | `packages/chord/test/node/app/files.test.ts` | CHORD | test | 14 / 1 |
| M | `packages/chord/test/node/plugins/plugins.test.ts` | CHORD | test | 4 / 2 |
| M | `packages/chord/test/node/plugins/watcher.test.ts` | CHORD | test | 2 / 1 |
| M | `packages/chord/test/node/web/styles.test.ts` | CHORD | test | 6 / 0 |
| M | `packages/chord/test/surfaces/client.test.ts` | CHORD | test | 51 / 0 |
| M | `packages/chord/vitest.config.ts` | CHORD | build/config | 2 / 0 |
| M | `packages/coding-agent/CHANGELOG.md` | BRAND, OWNER, DOCS | docs | 11 / 0 |
| A | `packages/coding-agent/docs/doc-loading-benchmark.md` | DOCS | docs | 83 / 0 |
| M | `packages/coding-agent/docs/docs.json` | OWNER | docs | 4 / 0 |
| M | `packages/coding-agent/docs/extensions.md` | OWNER, STATUS | docs | 10 / 0 |
| M | `packages/coding-agent/docs/index.md` | DOCS | docs | 1 / 0 |
| A | `packages/coding-agent/docs/owner-admission.md` | OWNER | docs | 79 / 0 |
| M | `packages/coding-agent/docs/sdk.md` | OWNER | docs | 4 / 0 |
| M | `packages/coding-agent/docs/terminal-setup.md` | STATUS | docs | 4 / 2 |
| M | `packages/coding-agent/install-lock/package-lock.json` | BRAND | build/config | 2 / 1 |
| M | `packages/coding-agent/package.json` | BRAND | build/config | 2 / 1 |
| A | `packages/coding-agent/scripts/benchmark-doc-loading.mjs` | DOCS | build/config | 68 / 0 |
| M | `packages/coding-agent/src/config.ts` | BRAND | runtime | 2 / 1 |
| M | `packages/coding-agent/src/core/agent-session-runtime.ts` | OWNER | runtime | 36 / 0 |
| M | `packages/coding-agent/src/core/agent-session.ts` | OWNER | runtime | 316 / 31 |
| M | `packages/coding-agent/src/core/cache-warmer.ts` | OWNER | runtime | 31 / 2 |
| M | `packages/coding-agent/src/core/extensions/loader.ts` | OWNER | runtime | 8 / 1 |
| M | `packages/coding-agent/src/core/extensions/runner.ts` | OWNER, STATUS | runtime | 15 / 0 |
| M | `packages/coding-agent/src/core/extensions/types.ts` | OWNER, STATUS | runtime | 9 / 0 |
| A | `packages/coding-agent/src/core/guarded-owner.ts` | OWNER | runtime | 38 / 0 |
| A | `packages/coding-agent/src/core/managed-search-process.ts` | SEARCH | runtime | 72 / 0 |
| M | `packages/coding-agent/src/core/model-runtime.ts` | OWNER | runtime | 7 / 0 |
| A | `packages/coding-agent/src/core/owner-activity.ts` | OWNER | runtime | 292 / 0 |
| M | `packages/coding-agent/src/core/sdk.ts` | OWNER | runtime | 5 / 0 |
| M | `packages/coding-agent/src/core/system-prompt.ts` | DOCS | runtime | 3 / 1 |
| M | `packages/coding-agent/src/core/tools/find.ts` | SEARCH | runtime | 9 / 5 |
| M | `packages/coding-agent/src/core/tools/grep.ts` | SEARCH | runtime | 5 / 8 |
| M | `packages/coding-agent/src/index.ts` | OWNER | runtime | 6 / 0 |
| M | `packages/coding-agent/src/modes/interactive/components/footer.ts` | BRAND | runtime | 6 / 1 |
| M | `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | OWNER, STATUS | runtime | 71 / 37 |
| M | `packages/coding-agent/src/modes/interactive/program-status-reporter.ts` | STATUS | runtime | 24 / 1 |
| M | `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | OWNER | runtime | 9 / 2 |
| A | `packages/coding-agent/test/agent-session-managed-search.test.ts` | SEARCH | test | 150 / 0 |
| A | `packages/coding-agent/test/agent-session-owner-admission.test.ts` | OWNER | test | 922 / 0 |
| M | `packages/coding-agent/test/extensions-runner.test.ts` | STATUS | test | 25 / 0 |
| A | `packages/coding-agent/test/fixtures/settlement-process.cjs` | SEARCH | fixture | 33 / 0 |
| M | `packages/coding-agent/test/footer-width.test.ts` | BRAND | test | 14 / 0 |
| A | `packages/coding-agent/test/fork-branding.test.ts` | BRAND | test | 39 / 0 |
| A | `packages/coding-agent/test/guarded-owner.test.ts` | OWNER | test | 271 / 0 |
| M | `packages/coding-agent/test/interactive-mode-compaction.test.ts` | OWNER | test | 40 / 1 |
| M | `packages/coding-agent/test/interactive-mode-startup-input.test.ts` | OWNER | test | 21 / 0 |
| A | `packages/coding-agent/test/managed-search-process-live.test.ts` | SEARCH | test | 114 / 0 |
| A | `packages/coding-agent/test/managed-search-process.test.ts` | SEARCH | test | 236 / 0 |
| A | `packages/coding-agent/test/managed-search-tools.test.ts` | SEARCH | test | 147 / 0 |
| A | `packages/coding-agent/test/owner-activity.test.ts` | OWNER | test | 371 / 0 |
| A | `packages/coding-agent/test/owner-extension-exec.test.ts` | OWNER | test | 59 / 0 |
| M | `packages/coding-agent/test/program-status-reporter.test.ts` | STATUS | test | 74 / 2 |
| M | `packages/coding-agent/test/sdk-stream-options.test.ts` | OWNER | test | 256 / 4 |
| M | `packages/coding-agent/test/suite/agent-session-boundaries.test.ts` | OWNER, DOCS | test | 131 / 0 |
| M | `packages/coding-agent/test/suite/agent-session-compaction.test.ts` | DOCS | test | 4 / 0 |
| M | `packages/coding-agent/test/suite/regressions/11613-bash-timeout-after-shell-exit.test.ts` | FIXTURES | test | 48 / 11 |
| M | `packages/coding-agent/test/suite/regressions/5943-session-start-notify.test.ts` | STATUS | test | 85 / 57 |
| M | `packages/coding-agent/test/suite/regressions/9068-user-bash-fail-closed.test.ts` | OWNER | test | 93 / 0 |
| M | `packages/coding-agent/test/suite/regressions/startup-session-rebind-duplicate-subscription.test.ts` | STATUS | test | 9 / 10 |
| M | `packages/coding-agent/test/system-prompt-updates.test.ts` | DOCS | test | 3 / 0 |
| M | `packages/coding-agent/test/system-prompt.test.ts` | DOCS | test | 21 / 2 |
| M | `packages/coding-agent/test/tool-execution-component.test.ts` | FIXTURES | test | 4 / 2 |
| M | `packages/env/CHANGELOG.md` | ENV | docs | 6 / 0 |
| M | `packages/env/daemon/src/exec.rs` | ENV | runtime | 6 / 5 |
| M | `packages/env/daemon/src/process.rs` | ENV | runtime | 95 / 37 |
| M | `packages/env/daemon/src/sys/unix.rs` | ENV | runtime | 58 / 5 |
| M | `packages/env/daemon/src/sys/windows.rs` | ENV | runtime | 17 / 7 |
| M | `scripts/update-model-catalog-pin.mjs` | BUILD | build/config | 17 / 4 |
| M | `scripts/update-model-catalog-pin.test.mjs` | BUILD | test | 24 / 1 |
