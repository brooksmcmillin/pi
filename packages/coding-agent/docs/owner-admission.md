# Guarded owner admission

This is a cooperative runtime primitive, not an enabled Autopilot feature. It does not grant consent, budgets or publication authority.

## Extension and SDK capability

`session.guardedOwner` and `ctx.guardedOwner` expose the same version-1 in-process contract. They are absent by default. An SDK host must explicitly supply `guardedOwner: { isSupported() { ... } }` when creating the session, attesting the backend boundary below. This callback is host code, not a wire flag, persisted setting or extension-controlled opt-in. The CLI does not enable it. Session restoration never reconstructs this attestation.

Capture `capability.snapshot()` and pass it to `capability.submit({ requestId, expected, text, authorize })`. The snapshot binds the live owner symbol and generation, session ID/file and working directory. `authorize` synchronously checks current caller permission and shared writer claims without performing work; it is rechecked with host support after asynchronous preparation. The runtime still independently rejects unknown stream backends and unsupported subprocess paths.

A `rejected` result guarantees the prompt never entered executable hooks. A `running` result includes the caller's `requestId`, execution `completion`, separate `settlement`, and `cancel()`. Completion rejection after admission is not a safe pre-dispatch rejection: an input hook may already have had effects. Completion resolution means the prompt pipeline finished, not that every model/tool action succeeded. Inspect its transcript for those outcomes. Release writer claims only on explicit `settled` acknowledgement, even after cancellation or execution failure. `uncertain` can arrive while completion remains pending and must retain claims.

`cancel()` requests cancellation only while its own prompt is active. It cannot abort a later human prompt, and it does not acknowledge settlement. It preserves accepted human handoff work. Captured capabilities become stale on reload, tree navigation, disposal or replacement; their handles may still report outcomes. Request IDs correlate a live handle, not an idempotent retry service: lost acceptance is uncertain, and consumers must not blindly resubmit. No RPC takeover, terminal injection, replacement runner or automatic workflow entry is provided.

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
