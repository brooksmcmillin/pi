# Targeted documentation selection comparison

Task: https://nexus.brooksmcmillin.com/task/8039

## Scope and ownership

The maintained instruction is `src/core/system-prompt.ts`, not personal
`pi-config` instructions or installed release files. `buildSystemPromptSections`
supplies the default docs section to `buildSystemPromptState`, the rendered
`buildSystemPrompt`, and `AgentSession`'s transcript/provider prompt. Unit tests
cover these consumers, including a faux-provider session. Explicit custom or
forced prompts still replace the defaults. No installed release was patched or
rolled out.

The new instruction selects API/topic sections and matching examples, keeps
applicable safety constraints and required cross-references, and permits reuse
only when previously read content and documentation version are unchanged.
Missing prior coverage, changed sources, missing contracts, uncertainty and broad
changes require more reading, potentially the whole document. This is not a hard
context cap or permission to omit relevant contracts.

## Reproduce

From the repository root, with Node.js (no dependencies or provider calls):

```sh
node packages/coding-agent/scripts/benchmark-doc-loading.mjs
```

Scenario: implement a local TUI `/ask` command using `pi.sendUserMessage`, starting
from the complete linked `examples/extensions/send-user-message.ts`. No package
distribution, RPC integration, custom TUI components or live installation is in
this example's scope. Those changes would require their own linked contracts.

The old selection is the full extensions manual plus that complete example. The
revised selection keeps the same example and complete relevant heading ranges.
The script prints each range and source hash, counts Unicode characters in the
joined selections (one newline between excerpts), and estimates tokens as
`ceil(characters / 4)`. This is a rough size estimate, not an actual model
tokenizer measurement.

## Observed result

Observed 2026-11-13 against base `0813f0672` in the task worktree:

| Selection | Characters | Estimated tokens |
| --- | ---: | ---: |
| Old: full manual + full example | 161,350 | 40,338 |
| Revised: relevant sections + same full example | 14,924 | 3,731 |

The revised selection is about **90.8% smaller** in characters.

Source SHA-256 values:

- `docs/extensions.md`: `098f0271121e7f2803c4d7e2bcd25c3fb9722aa711de233d482eb92a0018c930`
- `examples/extensions/send-user-message.ts`: `9261e433c782f354530105e1c9723a19798868f72fd1f5d68af3a4624ad7e446`

The revised manual ranges are:

| Heading/range | Retained contract |
| --- | --- |
| Introduction, lines 3–32; Extension Locations, 123–153 | Full process/credential access, trusted sources, project trust and loading |
| Available Imports, 155–170; Writing an Extension, 186–213 | Host imports, typed factory, initialization ordering |
| Long-lived resources and shutdown, 252–256 | No background resources in factories; session cleanup |
| ExtensionContext through ctx.hasUI, 1163–1177 | Context type, UI/mode availability and guards |
| ctx.isIdle, 1259–1261; ExtensionCommandContext, 1324–1326 | Busy state and command-only methods' deadlock constraint |
| pi.sendUserMessage, 1655–1685 | New-turn effects, streaming delivery modes, rejection without deliverAs and linked example |
| pi.registerCommand, 1741–1774 | Registration, collision suffixes, handler and completion example |
| Dialogs, 2825–2842 | Notification signature and levels |
| Error Handling and Mode Behavior, 3254–3275 | Failure behavior and non-TUI limits |

The script checks for the relevant API, complete example and key safety markers.
The retained ranges were also inspected for relevance; marker checks alone do
not prove semantic completeness. Linked package-distribution, RPC and custom-TUI
contracts are outside this bounded scenario, not generally optional.

## Proof limits

This measures a deliberate document selection, not automatic model compliance,
implementation correctness on every task, provider latency, or live rollout.
No paid model run was performed. Broader work must expand its selection as the
new instruction requires; these ranges are evidence for this example, not a
permanent reading allowlist.
