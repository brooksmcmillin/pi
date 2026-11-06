import { AsyncLocalStorage } from "node:async_hooks";

/** A live owner snapshot, not authority to submit work. */
export interface OwnerSnapshot {
	readonly owner: symbol;
	readonly generation: number;
}

export type AdmissionRejection = "busy" | "stale" | "revoked" | "unsupported";

interface Reservation {
	generation: number;
	lifecycle: number;
	authorize: () => boolean;
	dispatched: boolean;
	closed: boolean;
	children: Set<Promise<unknown>>;
}

export type AdmissionResult<T> =
	| { status: "rejected"; reason: AdmissionRejection }
	| { status: "running"; completion: Promise<T> };

const requestOwner = new AsyncLocalStorage<OwnerActivity>();

/** Registers cooperating JavaScript lifetimes; it does not certify subprocess settlement. */
export class OwnerActivity {
	/** Called by the runtime immediately before invoking a physical provider, after auth and routing. */
	static dispatchRequest(): void {
		requestOwner.getStore()?.dispatch();
	}

	private state: {
		owner: symbol;
		generation: number;
		lifecycle: number;
		active: number;
		reservation?: Reservation;
		context: AsyncLocalStorage<Reservation>;
	} = {
		owner: Symbol("owner"),
		generation: 0,
		lifecycle: 0,
		active: 0,
		context: new AsyncLocalStorage<Reservation>(),
	};

	/** Preserve both incoming startup work and outgoing work across session replacement. */
	inherit(previous: OwnerActivity): void {
		if (this.state === previous.state) return;
		if (this.state.reservation) throw new Error("Cannot transfer an admitted autonomous owner");
		previous.state.active += this.state.active;
		this.state = previous.state;
	}

	get snapshot(): OwnerSnapshot {
		return { owner: this.state.owner, generation: this.state.generation };
	}

	get busy(): boolean {
		return this.state.active > 0 || this.state.reservation !== undefined;
	}

	get guarded(): boolean {
		return this.state.context.getStore() !== undefined;
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
		if (reservation) reservation.dispatched = true;
	}

	/** Track before invoking executable hooks. Nested work inherits its reservation. */
	async track<T>(operation: () => Promise<T>): Promise<T> {
		this.assertCurrent();
		const reservation = this.state.context.getStore();
		if (!reservation && this.state.reservation && !this.state.reservation.dispatched) this.intervene();
		this.state.active++;
		let work: Promise<T> | undefined;
		try {
			work = operation();
			reservation?.children.add(work);
			return await work;
		} finally {
			if (work) reservation?.children.delete(work);
			this.state.active--;
		}
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
		const reservation: Reservation = {
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
					this.state.reservation = undefined;
				}
			}),
		);
		return { status: "running", completion };
	}
}
