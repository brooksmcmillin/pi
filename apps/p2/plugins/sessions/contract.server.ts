// Sessions-owned lifecycle fences for caller-owned stopped-state publication.
import { type Context, type Ctx, defineRegistry, type Location } from "@p2/app/v1";

export type PreparedMove = {
	/** Inspect the fenced worker and return its actual generation. */
	inspect(ctx: Ctx): Promise<number>;
	/** Recheck caller-owned eligibility immediately before catalog mutation. */
	validate(): void;
	/** Publish caller-owned state while worker starts remain excluded. */
	publish(ctx: Ctx): Promise<void>;
};

type PreparedMoves = {
	withPreparedMove(target: Location & { id: string }, transition: PreparedMove, context: Context): Promise<void>;
};

export const PreparedSessionMoves = defineRegistry<PreparedMoves, PreparedMoves | undefined>(
	"p2.prepared-session-moves",
	{ version: 1 },
);

type ArchivedSessions = {
	/** Runs work after archival shutdown, excluding restore; returns false for an active or missing session. */
	whileArchived(id: string, work: () => Promise<void>, context: Context): Promise<boolean>;
};

export const ArchivedSessionChanges = defineRegistry<ArchivedSessions, ArchivedSessions | undefined>(
	"p2.archived-session-changes",
	{ version: 1 },
);
