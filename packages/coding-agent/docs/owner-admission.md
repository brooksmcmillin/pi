# Internal owner admission

This is a core integration primitive, not an enabled Autopilot feature or an extension capability advertisement. It does not grant consent, budgets or publication authority.

`AgentSession.ownerSnapshot` identifies the live owner and its generation. A snapshot is not authorization. `submitGuardedPrompt(text, snapshot, authorize, supported)` synchronously reserves that owner or returns `busy`, `stale`, `revoked`, or `unsupported`. Rejected requests are never steered or queued. `authorize` is a synchronous, side-effect-free check of host-owned authority; it is checked again before dispatch. `supported` defaults to false and must come from trusted host validation of the participating backend, never a wire argument or model-authored tool input.

The supported request path uses the session's registered ModelRuntime stream function. Its dispatch fence is immediately before invoking the physical provider, after virtual routing, credential resolution, and header transforms. This does not mean a remote request has completed or even reached the network. Unknown stream functions reject admission. Custom providers and tools remain trusted cooperating code, not a sandbox.

## Lifetimes and invalidation

The registry starts with extension loading, before enrollment. Prompt preparation, tools and nested tools, `pi.exec`, SDK shells, and the TUI/RPC user-shell hook-to-execution interval contribute activity. Normal submitted TUI input also retains activity while waiting outside the session queue. These registrations do not serialize ordinary user operations or change their existing steering and cancellation behavior.

An admitted request inherits its reservation through registered nested work rather than acquiring a second owner. Its completion joins registered children, including children the caller did not await. Its separate `settlement` promise reports `settled` only after those lifetimes join, regardless of operation success or failure. It reports `uncertain` immediately on lost supervision, even if the execution `completion` promise is still pending. Uncertainty retains the owner claim and fences further autonomous dispatch, including within the current request. Reload, replacement, cancellation and a later exit do not clear it; this version has no automatic reconciliation or recovery API.

The guarantee covers registered cooperative work, not arbitrary timers, unmanaged asynchronous work, or escaped processes. `agent_settled`, a tool result and a resolved execution promise are not subprocess settlement evidence.

Human submission/interruption fences pending admission but does not forcibly abort an already-dispatched mutation. Explicit abort retains ordinary cancellation semantics. Reload, tree navigation, disposal and runtime replacement invalidate old lifecycle contexts. Replacement preserves outstanding outgoing activity and incoming extension-startup activity, so changing sessions cannot make existing work disappear from admission accounting.

Host entrypoints must notify human intervention before asynchronous routing and track the entire executable routing span. Merely tracking the eventual shell or tool call leaves an admission gap. The owner registry is internal; do not replace these entrypoint spans with extension-maintained busy counters.

## Managed subprocess boundary

Only the built-in local `grep` and `find` implementations support autonomous subprocess execution. The host's `supported` attestation must cover genuine, already-provisioned `rg`/`fd` binaries in Pi's bin directory and their execution environment. Wrappers, substituted executables and binaries that launch child work are not supported. This is a trusted cooperative backend contract, not binary authentication or filesystem isolation. Guarded search never probes PATH, downloads a tool or runs extraction commands. The fixed search arguments disable ripgrep configuration and do not expose preprocessing or command-execution options.

The runtime registers each leaf process synchronously at spawn, rechecks ownership and cancellation immediately before dispatch, and joins its exit acknowledgement plus stdio closure independently of the tool's returned promise. A failed spawn with no PID is acknowledged separately. A signal sent, an error after spawn or a close without exit acknowledgement cannot certify termination. Failed signalling or a five-second cancellation acknowledgement deadline reports uncertainty, never successful cleanup. No PID scanning, process-group signalling or command-text blacklist supplies settlement evidence. This deliberately does not duplicate upstream #11854's process-tree termination abstraction.

Autonomous SDK shells, `pi.exec`, `bash`, `powershell`, custom/remote search replacements and extension slash commands still fail closed before launch. Ordinary interactive execution remains available. Human-started managed searches also retain activity until acknowledgement, so early tool cancellation does not open an autonomous admission window. Arbitrary detached processes and non-cooperating backends remain excluded.

## Pre-review interaction matrix

Before the first independent review of an owner-admission change, map each affected row below to the current implementation and run its deterministic tests. Reuse existing coverage; add only missing cases. Keep the inspected base/candidate revision, test names, commands, outcomes and remaining gaps in the implementation contract. A passing matrix does not replace independent review or authorize activation.

Test paths below are relative to `packages/coding-agent/test/`, except the explicitly named agent-core test.

| Interaction | Deterministic test | Required assertions |
| --- | --- | --- |
| Human handoff × steering/follow-up × one-at-a-time/all, before and after dispatch | `agent-session-owner-admission.test.ts`: `preserves handoff batching` | Accepted input drains in order with the configured batches; no pending messages remain. |
| Human steering × session-level continuation × queue mode | Same file: `prioritizes human steering over continuation` (response and deferred `agent_before_settle` boundaries) | Human input wins the next request, each message is delivered once, batching is preserved, and the human tool executes in ordinary authority. |
| Completed handoff → first cache refresh | `sdk-stream-options.test.ts`: `warms the human request after a fenced autonomous auth handoff`; `refreshes idle cache after a completed ... prompt` | The human request runs and its first refresh succeeds after the old reservation closes; exactly one cache usage entry is recorded. Fake timers preserve AsyncLocalStorage with `AsyncResource.bind`. |
| Maintenance callback × turn-producing entrypoint | Same file: `fences maintenance custom-message turns while streaming` | `prompt`, `sendUserMessage`, `steer`, `followUp`, and custom-message steering/follow-up (explicit and implicit turn requests) reject without another provider call or queued work. `triggerTurn: false` remains context-only. Raw Agent methods are not a sandboxed extension boundary. |
| Intervention after physical refresh dispatch × usage accounting | Same file: `records billed refresh usage after intervention without rescheduling stale work` | Already-billed work records usage exactly once; intervention prevents another scheduled refresh, rather than erasing usage. |
| Selected steering/follow-up batch × one-at-a-time/all × preparation handoff | `packages/agent/test/prepare-next-turn-end.test.ts`: `restores selected ... messages ... before settlement` | Already-accepted selected input is restored ahead of later arrivals, delivered exactly once in original order, with configured batching and empty final queues. Ignored preparation `messages` are not accepted input and must not be replayed. |
| Selected extension input × compaction handoff × human tool authority | `agent-session-owner-admission.test.ts`: `preserves selected extension steering when human input hands off during compaction` | The real session restores selected extension input once in both transcript and persistence; human input runs first with normal tool authority. The agent-core matrix above supplies the queue/mode cross-product, not an assertion that every combination has a separate full-session fixture. |

Run the bounded matrix from a prepared checkout (install dependencies, hydrate pinned model data, and build workspace exports first):

```sh
# From packages/agent
node ../../node_modules/vitest/dist/cli.js --run test/prepare-next-turn-end.test.ts
# From packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/agent-session-owner-admission.test.ts test/sdk-stream-options.test.ts
```

Use deferred promises at the named boundaries, not sleeps or live providers. Preserve failures and distinguish fixture setup failures from executed regression failures. Repeat affected coverage after repairs before review; do not reset review budgets or treat these tests as permission to repair another owner's branch.

## Offline coverage

- `owner-activity.test.ts`: simultaneous attempts, pre-existing activity, generation/lifecycle fences, nested registered lifetimes and replacement accounting.
- `agent-session-owner-admission.test.ts`: real session/runtime routing, auth and header-transform races, backend rejection, nested tool execution, reload and replacement fences.
- `owner-extension-exec.test.ts`: factory-started exec accounting and rejection before subprocess dispatch, using a deferred executor fixture.
- `suite/regressions/9068-user-bash-fail-closed.test.ts`: actual TUI/RPC shell handlers stay busy across asynchronous hooks, handoff and execution.
- `interactive-mode-startup-input.test.ts`: submitted human input remains accounted for before the main input consumer starts.

- `managed-search-process.test.ts`: process acknowledgements, cancellation, failed cleanup, uncertainty retention and pre-dispatch rejection.
- `managed-search-process-live.test.ts`: disposable marker writer cancellation and a negative Unix/macOS fixture whose descendant survives direct-parent exit; group signalling does not clear uncertainty. This does not certify arbitrary descendant containment.
- `agent-session-managed-search.test.ts`: faux-provider sessions using actual local rg/fd when installed, missing-binary rejection and custom-backend rejection.
- `managed-search-tools.test.ts`: actual tool promises, early find cancellation, and cancellation/generation fencing during asynchronous preparation.

These tests do not certify terminal rendering, installation or deployed capability availability. The separate installed-host verification task remains required.
