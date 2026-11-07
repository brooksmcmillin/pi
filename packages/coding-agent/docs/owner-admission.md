# Internal owner admission

This is a core integration primitive, not an enabled Autopilot feature or an extension capability advertisement. It does not grant consent, budgets, publication authority, or subprocess supervision.

`AgentSession.ownerSnapshot` identifies the live owner and its generation. A snapshot is not authorization. `submitGuardedPrompt(text, snapshot, authorize, supported)` synchronously reserves that owner or returns `busy`, `stale`, `revoked`, or `unsupported`. Rejected requests are never steered or queued. `authorize` is a synchronous, side-effect-free check of host-owned authority; it is checked again before dispatch. `supported` defaults to false and must come from trusted host validation of the participating backend, never a wire argument or model-authored tool input.

The supported request path uses the session's registered ModelRuntime stream function. Its dispatch fence is immediately before invoking the physical provider, after virtual routing, credential resolution, and header transforms. This does not mean a remote request has completed or even reached the network. Unknown stream functions reject admission. Custom providers and tools remain trusted cooperating code, not a sandbox.

## Lifetimes and invalidation

The registry starts with extension loading, before enrollment. Prompt preparation, tools and nested tools, `pi.exec`, SDK shells, and the TUI/RPC user-shell hook-to-execution interval contribute activity. Normal submitted TUI input also retains activity while waiting outside the session queue. These registrations do not serialize ordinary user operations or change their existing steering and cancellation behavior.

An admitted request inherits its reservation through registered nested work rather than acquiring a second owner. Its completion joins registered children, including children the caller did not await. It does not claim to join arbitrary timers, unmanaged asynchronous work, or escaped processes.

Human submission/interruption fences pending admission but does not forcibly abort an already-dispatched mutation. Explicit abort retains ordinary cancellation semantics. Reload, tree navigation, disposal and runtime replacement invalidate old lifecycle contexts. Replacement preserves outstanding outgoing activity and incoming extension-startup activity, so changing sessions cannot make existing work disappear from admission accounting.

Host entrypoints must notify human intervention before asynchronous routing and track the entire executable routing span. Merely tracking the eventual shell or tool call leaves an admission gap. The owner registry is internal; do not replace these entrypoint spans with extension-maintained busy counters.

## Unsupported subprocess boundary

Autonomous SDK shells, `pi.exec`, and subprocess-capable built-in tools (`bash`, `powershell`, `grep`, `find`) currently fail closed before starting. Extension slash commands are also unsupported for guarded submission. Their existing normal user behavior is unchanged.

The follow-up subprocess-settlement work must supply and validate cooperative joined-lifetime supervision before enabling autonomous subprocess paths. Cancellation is not proof of process settlement. Arbitrary detached processes and non-cooperating custom backends are outside this primitive's guarantee and must not be declared supported by a host.

## Offline coverage

- `owner-activity.test.ts`: simultaneous attempts, pre-existing activity, generation/lifecycle fences, nested registered lifetimes and replacement accounting.
- `agent-session-owner-admission.test.ts`: real session/runtime routing, auth and header-transform races, backend rejection, nested tool execution, reload and replacement fences.
- `owner-extension-exec.test.ts`: factory-started exec accounting and rejection before subprocess dispatch, using a deferred executor fixture.
- `suite/regressions/9068-user-bash-fail-closed.test.ts`: actual TUI/RPC shell handlers stay busy across asynchronous hooks, handoff and execution.
- `interactive-mode-startup-input.test.ts`: submitted human input remains accounted for before the main input consumer starts.

These tests do not certify subprocess settlement, terminal rendering, installation, or deployed capability availability.
