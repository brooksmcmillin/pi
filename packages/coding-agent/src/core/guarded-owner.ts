import type { AdmissionRejection, OwnerSnapshot, Settlement } from "./owner-activity.ts";

/** Host-owned attestation of the cooperative backend; never restore it from session data. */
export interface GuardedOwnerSupport {
	isSupported(): boolean;
}

/** Observation bound to a live owner, its persisted conversation and working directory. */
export interface GuardedOwnerSnapshot extends OwnerSnapshot {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly cwd: string;
}

export type GuardedPromptResult =
	| { status: "rejected"; reason: AdmissionRejection }
	| {
			status: "running";
			/** Execution success/failure is independent of settlement. */
			completion: Promise<void>;
			settlement: Promise<Settlement>;
			/** Request cancellation of this prompt only. This is not a settlement acknowledgement. */
			cancel(): void;
	  };

/** In-process capability, not serializable authorization or a retry protocol. */
export interface GuardedOwnerCapability {
	readonly version: 1;
	readonly boundary: "cooperative-managed-search";
	snapshot(): GuardedOwnerSnapshot;
	submit(request: {
		requestId: string;
		expected: GuardedOwnerSnapshot;
		text: string;
		/** Synchronous side-effect-free check of current caller consent and writer claims. */
		authorize(): boolean;
	}): GuardedPromptResult & { requestId: string };
}
