import { AsyncLocalStorage } from "node:async_hooks";

/** A live owner snapshot, not authority to submit work. */
export interface OwnerSnapshot {
	readonly owner: symbol;
	readonly generation: number;
}

export type AdmissionRejection = "busy" | "stale" | "revoked" | "unsupported";
export type Settlement = "settled" | "uncertain";

interface Reservation {
	kind: "autonomous";
	reportSettlement: (outcome: Settlement) => void;
	generation: number;
	lifecycle: number;
	authorize: () => boolean;
	dispatched: boolean;
	closed: boolean;
	children: Set<Promise<unknown>>;
}

interface Maintenance {
	kind: "maintenance";
	generation: number;
	lifecycle: number;
	closed: boolean;
	children: Set<Promise<unknown>>;
	isCurrent: () => boolean;
	beforeDispatch: () => boolean;
}

type ExecutionScope = Reservation | Maintenance;

export type AdmissionResult<T> =
	| { status: "rejected"; reason: AdmissionRejection }
	| { status: "running"; completion: Promise<T>; settlement: Promise<Settlement> };

const requestOwner = new AsyncLocalStorage<OwnerActivity>();

/** Joins registered cooperative lifetimes, retaining ownership after lost supervision. */
export class OwnerActivity {
	/** Called by the runtime immediately before invoking a physical provider, after auth and routing. */
	static dispatchRequest(): void {
		requestOwner.getStore()?.dispatch();
	}

	/** Internal runtime context, not an extension capability or permission grant. */
	static get current(): OwnerActivity | undefined {
		return requestOwner.getStore();
	}

	private state: {
		uncertain: boolean;
		owner: symbol;
		generation: number;
		lifecycle: number;
		active: number;
		reservation?: Reservation;
		context: AsyncLocalStorage<ExecutionScope>;
	} = {
		uncertain: false,
		owner: Symbol("owner"),
		generation: 0,
		lifecycle: 0,
		active: 0,
		context: new AsyncLocalStorage<ExecutionScope>(),
	};

	/** Preserve both incoming startup work and outgoing work across session replacement. */
	inherit(previous: OwnerActivity): void {
		if (this.state === previous.state) return;
		if (this.state.reservation) throw new Error("Cannot transfer an admitted autonomous owner");
		previous.state.active += this.state.active;
		previous.state.uncertain ||= this.state.uncertain;
		this.state = previous.state;
		if (this.state.uncertain) this.markUncertain();
	}

	get snapshot(): OwnerSnapshot {
		return { owner: this.state.owner, generation: this.state.generation };
	}

	get busy(): boolean {
		return this.state.uncertain || this.state.active > 0 || this.state.reservation !== undefined;
	}

	get guarded(): boolean {
		return this.state.context.getStore() !== undefined;
	}

	get maintenance(): boolean {
		return this.state.context.getStore()?.kind === "maintenance";
	}

	/** Fence pending autonomous dispatch without aborting an already-running mutation. */
	intervene(): void {
		this.state.generation++;
	}

	/** Fence old-session callbacks without forgetting their outstanding activity. */
	invalidate(): void {
		this.state.generation++;
		this.state.lifecycle++;
	}

	/** Revalidate immediately after asynchronous preparation and before its next side effect. */
	assertCurrent(): void {
		const reservation = this.state.context.getStore();
		if (!reservation) return;
		if (this.state.uncertain) throw new Error("Subprocess settlement is uncertain");
		if (reservation.kind === "maintenance") {
			if (
				reservation.closed ||
				reservation.lifecycle !== this.state.lifecycle ||
				reservation.generation !== this.state.generation ||
				!reservation.isCurrent()
			) {
				throw new Error("Cache maintenance is stale");
			}
			return;
		}
		if (
			reservation.closed ||
			reservation.lifecycle !== this.state.lifecycle ||
			(!reservation.dispatched && reservation.generation !== this.state.generation)
		) {
			throw new Error("Autonomous request is stale");
		}
		if (!reservation.dispatched) {
			if (!reservation.authorize()) throw new Error("Autonomous request authorization was revoked");
			if (reservation.generation !== this.state.generation) throw new Error("Autonomous request is stale");
		}
	}

	/** Mark the first dispatch only after its final synchronous authorization check. */
	dispatch(): void {
		this.assertCurrent();
		const reservation = this.state.context.getStore();
		if (reservation?.kind === "maintenance" && !reservation.beforeDispatch()) {
			throw new Error("Cache maintenance dispatch expired");
		}
		if (reservation?.kind === "autonomous") reservation.dispatched = true;
	}

	/** Track before invoking executable hooks. Nested work inherits its reservation. */
	async track<T>(operation: () => Promise<T>): Promise<T> {
		this.assertCurrent();
		const reservation = this.state.context.getStore();
		if (!reservation && this.state.reservation && !this.state.reservation.dispatched) this.intervene();
		this.state.active++;
		let work: Promise<T> | undefined;
		try {
			work = requestOwner.run(this, operation);
			reservation?.children.add(work);
			return await work;
		} finally {
			if (work) reservation?.children.delete(work);
			this.state.active--;
		}
	}

	/** Register the terminal acknowledgement separately from the tool's returned promise. */
	joinSubprocess(acknowledgement: Promise<Settlement>): void {
		const scope = this.state.context.getStore();
		this.state.active++;
		const work = acknowledgement
			.then(
				(outcome) => {
					if (outcome === "uncertain") this.markUncertain();
				},
				() => this.markUncertain(),
			)
			.finally(() => {
				scope?.children.delete(work);
				this.state.active--;
			});
		scope?.children.add(work);
	}

	/** Unknown work is absorbing: reload, cancellation and later exit cannot release the claim. */
	markUncertain(): void {
		this.state.uncertain = true;
		this.state.reservation?.reportSettlement("uncertain");
	}

	/** Execute an accepted human handoff without changing the outgoing reservation or its children. */
	runHumanInput<T>(operation: () => Promise<T>): Promise<T> {
		if (this.state.context.getStore()?.kind !== "autonomous") {
			throw new Error("Human handoff requires an outgoing autonomous run");
		}
		return this.state.context.exit(() => this.track(operation));
	}

	/** Capture the originating lifetime without retaining prompt consent for later cache maintenance. */
	captureMaintenance(): (
		isCurrent: () => boolean,
		beforeDispatch: () => boolean,
		operation: () => Promise<void>,
	) => Promise<void> {
		const { generation, lifecycle, reservation: capturedReservation } = this.state;
		const origin = this.state.context.getStore();
		return async (isCurrent, beforeDispatch, operation) => {
			const scope: Maintenance = {
				kind: "maintenance",
				generation,
				lifecycle,
				closed: false,
				children: new Set(),
				isCurrent,
				beforeDispatch,
			};
			if (
				(origin?.kind === "autonomous" && !origin.dispatched) ||
				(this.state.reservation && this.state.reservation !== capturedReservation)
			) {
				throw new Error("Cache maintenance owner changed");
			}
			await requestOwner.run(this, () =>
				this.state.context.run(scope, async () => {
					this.assertCurrent();
					this.state.active++;
					try {
						await operation();
					} finally {
						while (scope.children.size > 0) await Promise.allSettled([...scope.children]);
						scope.closed = true;
						this.state.active--;
					}
				}),
			);
		};
	}

	/** Reserve synchronously; busy submissions never enter a later-turn queue. */
	submit<T>(
		expected: OwnerSnapshot,
		authorize: () => boolean,
		supported: boolean,
		operation: () => Promise<T>,
	): AdmissionResult<T> {
		if (expected.owner !== this.state.owner || expected.generation !== this.state.generation) {
			return { status: "rejected", reason: "stale" };
		}
		if (this.busy) return { status: "rejected", reason: "busy" };
		if (!supported) return { status: "rejected", reason: "unsupported" };
		const { promise: settlement, resolve: reportSettlement } = Promise.withResolvers<Settlement>();
		const reservation: Reservation = {
			kind: "autonomous",
			reportSettlement,
			generation: this.state.generation,
			lifecycle: this.state.lifecycle,
			authorize,
			dispatched: false,
			closed: false,
			children: new Set(),
		};
		this.state.reservation = reservation;
		try {
			if (!authorize()) {
				this.state.reservation = undefined;
				return { status: "rejected", reason: "revoked" };
			}
			if (reservation.generation !== this.state.generation) {
				this.state.reservation = undefined;
				return { status: "rejected", reason: "stale" };
			}
		} catch (error) {
			this.state.reservation = undefined;
			throw error;
		}
		const completion = requestOwner.run(this, () =>
			this.state.context.run(reservation, async () => {
				try {
					this.assertCurrent();
					return await operation();
				} finally {
					// Unawaited registered children must not open a second admission window.
					while (reservation.children.size > 0) {
						await Promise.allSettled([...reservation.children]);
					}
					reservation.closed = true;
					if (!this.state.uncertain) {
						this.state.reservation = undefined;
						reportSettlement("settled");
					}
				}
			}),
		);
		return { status: "running", completion, settlement };
	}
}
