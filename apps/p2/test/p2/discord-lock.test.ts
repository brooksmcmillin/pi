// Discord delivery must not overwrite the authoritative session-lock mirror.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { openStore, sqliteBackend } from "@earendil-works/chord";
import { filesFacet } from "@earendil-works/chord/app/files";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { type ConversationId, createRegistry, Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj } from "@earendil-works/pi-schema";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import {
	BACKGROUND_CONTEXT,
	defineFacet,
	type Facet,
	type Host,
	type SessionLock as Lock,
	Session,
	withAbortSignal,
} from "@p2/app/v1";
import { type HarnessParts, InputGates, SessionLockDoc } from "@p2/app/v1/worker";
import chatWorker from "../../plugins/chat/worker.ts";
import { DISCORD_BATCH, DiscordIngress } from "../../plugins/discord/contract.ts";
import { Relay, type RelayState, type SessionPort } from "../../plugins/discord/relay.ts";
import discordWorker, { DiscordLinkDoc } from "../../plugins/discord/worker.ts";
import { Attachments, FilesMirror } from "../../plugins/files/contract.ts";
import { createP2Models } from "../../plugins/models/models.ts";
import { SessionLocks } from "../../plugins/sessions/contract.ts";
import { serveLockMirror } from "../../plugins/sessions/lock-worker.ts";
import { serveLocks } from "../../plugins/sessions/locks.ts";
import { StatusReport } from "../../plugins/status/contract.ts";
import { durableContext } from "../../src/runtime/durable.ts";
import { SERVER } from "../../src/runtime/principals.ts";
import { guardTool, type P2Tool } from "../../src/runtime/tool-access.ts";
import { holdIn, memoryLinkPair, poll, testHost, workerFacet } from "./helpers.ts";

const RESTRICTED: Lock = { mcp: [], projectMcp: false, instructions: false, capabilities: [] };
const PERMISSIVE: Lock = { ...RESTRICTED, capabilities: ["ports"] };
const batch = (requestId: string) => ({
	generation: 1,
	requestId,
	author: { id: "u1", name: "User" },
	text: "hello",
	context: { channel: "general", guild: "Guild", messages: 1 },
	files: [],
});

async function fixture(
	t: TestContext,
	initial: Lock | null,
	beforeWorker?: (durable: Harness) => void,
	extraFacets: Facet[] = [],
) {
	const directory = mkdtempSync(join(tmpdir(), "p2-discord-lock-"));
	const cleanup: (() => Promise<void>)[] = [];
	t.after(async () => {
		for (const close of cleanup.reverse()) await close();
		rmSync(directory, { recursive: true, force: true });
	});
	const context = durableContext(BACKGROUND_CONTEXT);
	const durable = await Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{ models: createP2Models(true), registry: createRegistry() },
		context,
	);
	cleanup.push(() => durable.close(context));
	const store = async () => {
		const opened = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), BACKGROUND_CONTEXT);
		cleanup.push(() => opened.close(BACKGROUND_CONTEXT));
		return opened;
	};
	await durable.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: directory } });
	const server = await testHost({ store: await store(), facets: [defineFacet(serveLocks)] });
	cleanup.push(() => server.close());
	const locks = server.host.hold(SessionLocks, {}, BACKGROUND_CONTEXT);
	await locks.set({ session: "s1", lock: initial }, BACKGROUND_CONTEXT);
	let connection: ReturnType<typeof memoryLinkPair>[1];
	const connect = (host: Host) => {
		const [down, up] = memoryLinkPair();
		connection = up;
		server.host.accept(down, { principal: { kind: "worker", session: "s1", generation: 1 } }, BACKGROUND_CONTEXT);
		host.connect(up, { principal: SERVER }, BACKGROUND_CONTEXT);
	};
	beforeWorker?.(durable);
	const facets: Facet[] = [
		workerFacet({ harness: { durable, environments: {}, relocate: async () => {} } as unknown as HarnessParts }),
		filesFacet(join(directory, "files")),
		defineFacet(serveLockMirror),
		discordWorker,
		chatWorker,
		...extraFacets,
	];
	const telemetry = new InMemoryTelemetryContext();
	const worker = await testHost({
		telemetry,
		address: Session({ id: "s1" }),
		kind: "worker",
		store: await store(),
		beforeLoad: connect,
		facets,
		stubs: [
			[Attachments, { resolve: async () => [] }],
			[FilesMirror, { push: async () => null }],
			[StatusReport, { push: async () => null }],
		],
	});
	cleanup.push(() => worker.close());
	const ingress = await holdIn(worker.client(SERVER), DiscordIngress, { session: "s1" }, "server");
	const mirrored = async () => (await durable.snapshot(SessionLockDoc, context))?.lock ?? null;
	return {
		durable,
		context,
		locks,
		ingress,
		mirrored,
		worker,
		facets,
		server,
		admitted: () =>
			poll(() =>
				telemetry
					.getSpans()
					.some(
						(span) =>
							span.name === "chord.method" &&
							span.attributes.type === "p2.session-lock-mirror" &&
							span.attributes.member === "sync",
					),
			),
		disconnect: () => connection.close(),
		reconnect: () => connect(worker.host),
	};
}

test(
	"security:discord-unlink-leaves-relay-authorized: a late native admission resumes with cancellation",
	{ timeout: 5_000 },
	async (t) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<boolean>();
		const aborted = Promise.withResolvers<void>();
		const gate = defineFacet((_host, self) => {
			self.contribute(InputGates, {
				"test-unlink": async (ctx) => {
					ctx.abortSignal?.addEventListener("abort", () => aborted.resolve(), { once: true });
					entered.resolve();
					await release.promise;
					cancelled.resolve(ctx.abortSignal?.aborted ?? false);
				},
			});
		});
		const f = await fixture(t, RESTRICTED, undefined, [gate]);
		const sending = f.ingress.deliver(batch("native-admission"), BACKGROUND_CONTEXT);
		const settled = Promise.allSettled([sending]);
		await entered.promise;
		const unlinking = f.ingress.unlinked({ generation: 1 }, BACKGROUND_CONTEXT);
		try {
			await aborted.promise;
		} finally {
			release.resolve();
		}
		assert.equal(
			await cancelled.promise,
			true,
			"unlink cancels the actual native handler context, not just its RPC waiter",
		);
		await unlinking;
		assert.equal((await settled)[0]!.status, "rejected");
		// Drain the resumed native handler before examining its durable writes; the cancellation was observed above.
		await f.worker.close();
		const conversation = await f.durable.conversation(1 as ConversationId, f.context);
		const entries = await conversation!.entries({}, 100, undefined, f.context);
		assert.equal(
			entries.items.some((entry) => entry.kind === DISCORD_BATCH),
			false,
		);
		const link = await f.durable.snapshot(DiscordLinkDoc, f.context);
		assert.equal(link?.revokedThrough, 1);
		assert.equal(link?.link, null);
	},
);

for (const outcome of ["commit", "cancel", "fail"] as const) {
	test(`code:discord-delivery-restores-stale-lock: first input waits for initial mirror ${outcome}`, async (t) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let commits = 0;
		const f = await fixture(t, RESTRICTED, (durable) => {
			const commit = durable.commit.bind(durable);
			t.mock.method(durable, "commit", async (...args: Parameters<Harness["commit"]>) => {
				if (++commits === 1) {
					entered.resolve();
					await release.promise;
					if (outcome === "fail") throw new Error("injected initial mirror failure");
				}
				return commit(...args);
			});
		});
		await entered.promise;
		const controller = new AbortController();
		const sending = f.ingress.deliver(batch("initial"), withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
		const settled = Promise.allSettled([sending]);
		try {
			await f.admitted();
			assert.equal(commits, 1, "admission must not commit Discord state ahead of the initial lock");
			if (outcome === "cancel") {
				controller.abort();
				assert.equal(
					(await settled)[0]!.status,
					"rejected",
					"cancellation releases the caller before mirror completion",
				);
			}
		} finally {
			release.resolve();
			await settled;
		}
		assert.equal((await settled)[0]!.status, outcome === "commit" ? "fulfilled" : "rejected");
		if (outcome === "fail") assert.equal(await f.mirrored(), null);
		else await poll(async () => JSON.stringify(await f.mirrored()) === JSON.stringify(RESTRICTED));
		if (outcome !== "commit") assert.equal(commits, 1, "failed or cancelled synchronization cannot submit");
		if (outcome === "fail") {
			// PR #9: a later authoritative commit must recover an initially failed mirror without restarting.
			await assert.rejects(
				f.ingress.deliver(batch("still-failed"), BACKGROUND_CONTEXT),
				/injected initial mirror failure/,
			);
			await f.locks.set({ session: "s1", lock: PERMISSIVE }, BACKGROUND_CONTEXT);
			await poll(async () => JSON.stringify(await f.mirrored()) === JSON.stringify(PERMISSIVE));
			assert.ok((await f.ingress.deliver(batch("recovered-initial"), BACKGROUND_CONTEXT)).submissionId > 0);
		}
	});
}

test("code:discord-delivery-restores-stale-lock: failed update refuses admission until a fresh commit", async (t) => {
	const f = await fixture(t, PERMISSIVE);
	await poll(async () => JSON.stringify(await f.mirrored()) === JSON.stringify(PERMISSIVE));
	const failed = Promise.withResolvers<void>();
	const commit = f.durable.commit.bind(f.durable);
	let fail = true;
	t.mock.method(f.durable, "commit", async (...args: Parameters<Harness["commit"]>) => {
		if (fail) {
			fail = false;
			failed.resolve();
			throw new Error("injected mirror update failure");
		}
		return commit(...args);
	});
	await f.locks.set({ session: "s1", lock: RESTRICTED }, BACKGROUND_CONTEXT);
	await failed.promise;
	await assert.rejects(f.ingress.deliver(batch("failed"), BACKGROUND_CONTEXT), /injected mirror update failure/);
	const fresh = { ...RESTRICTED, instructions: true };
	await f.locks.set({ session: "s1", lock: fresh }, BACKGROUND_CONTEXT);
	await poll(async () => JSON.stringify(await f.mirrored()) === JSON.stringify(fresh));
	assert.ok((await f.ingress.deliver(batch("recovered"), BACKGROUND_CONTEXT)).submissionId > 0);
});

test("code:discord-delivery-restores-stale-lock: disconnected authority cannot admit using its last lock", async (t) => {
	const f = await fixture(t, PERMISSIVE);
	await poll(async () => JSON.stringify(await f.mirrored()) === JSON.stringify(PERMISSIVE));
	await f.server.close();
	let commits = 0;
	const commit = f.durable.commit.bind(f.durable);
	t.mock.method(f.durable, "commit", (...args: Parameters<Harness["commit"]>) => {
		commits++;
		return commit(...args);
	});
	const controller = new AbortController();
	const sending = f.ingress.deliver(batch("disconnected"), withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
	const settled = Promise.allSettled([sending]);
	try {
		await f.admitted();
		assert.equal(commits, 0);
	} finally {
		controller.abort();
		await settled;
	}
	assert.equal((await settled)[0]!.status, "rejected");
});

test("code:discord-delivery-restores-stale-lock: reconnect waits for the new authoritative lock", async (t) => {
	const f = await fixture(t, PERMISSIVE);
	await poll(async () => JSON.stringify(await f.mirrored()) === JSON.stringify(PERMISSIVE));
	f.disconnect();
	await f.locks.set({ session: "s1", lock: RESTRICTED }, BACKGROUND_CONTEXT);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let commits = 0;
	const commit = f.durable.commit.bind(f.durable);
	t.mock.method(f.durable, "commit", async (...args: Parameters<Harness["commit"]>) => {
		if (++commits === 1) {
			entered.resolve();
			await release.promise;
		}
		return commit(...args);
	});
	f.reconnect();
	await entered.promise;
	const sending = f.ingress.deliver(batch("reconnected"), BACKGROUND_CONTEXT);
	try {
		await f.admitted();
		assert.equal(commits, 1, "the new mirror commit must finish before admitting input");
	} finally {
		release.resolve();
		await sending;
	}
	assert.deepEqual(await f.mirrored(), RESTRICTED);
});

test("code:discord-delivery-restores-stale-lock: mirror reactivation replaces persisted stale policy", async (t) => {
	const f = await fixture(t, PERMISSIVE);
	await poll(async () => JSON.stringify(await f.mirrored()) === JSON.stringify(PERMISSIVE));
	await f.worker.reload([]);
	await f.locks.set({ session: "s1", lock: RESTRICTED }, BACKGROUND_CONTEXT);
	assert.deepEqual(await f.mirrored(), PERMISSIVE, "inactive mirror retains the old durable snapshot");
	await f.worker.reload(f.facets);
	assert.ok((await f.ingress.deliver(batch("reactivated"), BACKGROUND_CONTEXT)).submissionId > 0);
	assert.deepEqual(await f.mirrored(), RESTRICTED);
});

for (const update of ["restrict", "unlock"] as const) {
	test(`code:discord-delivery-restores-stale-lock: held relay input cannot undo ${update}`, async (t) => {
		const initial = update === "restrict" ? PERMISSIVE : RESTRICTED;
		const current = update === "restrict" ? RESTRICTED : null;
		const f = await fixture(t, initial);
		await poll(async () => JSON.stringify(await f.mirrored()) === JSON.stringify(initial));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const sessions = {
			usable: async () => undefined,
			// The old relay captures this snapshot; the repaired relay must not use it as authority.
			lock: () => initial,
			deliver: async (_session: string, input: Parameters<SessionPort["deliver"]>[1]) => {
				entered.resolve();
				await release.promise;
				return f.ingress.deliver(input, BACKGROUND_CONTEXT);
			},
			turn: async () => ({ state: "pending" as const }),
			thread: async () => ({ conversation: 1 }),
			read: async () => new Uint8Array(),
			command: async () => ({ text: "" }),
		};
		const state: RelayState = {
			bindings: {
				c1: {
					generation: 1,
					phase: "linked",
					botId: "b1",
					channelId: "c1",
					channelName: "general",
					guildId: "g1",
					guildName: "Guild",
					session: "s1",
					wake: { anyone: true, users: [], roles: [] },
					cursor: null,
					threads: {},
					createdAt: 1,
				},
			},
			pending: {},
		};
		const relay = new Relay(
			() => ({
				botId: "bot",
				channel: async () => {
					throw new Error("unused channel");
				},
				messages: async () => [],
				reply: async (_channel, _message, text) => {
					assert.fail(text);
				},
				uploadLimit: async () => 1024,
				typing: async () => {},
			}),
			sessions,
			{ value: () => state, change: async (change) => change(state) },
		);
		const delivering = relay.onMessage("b1", {
			id: "1",
			channelId: "c1",
			author: { id: "user", name: "User", bot: false },
			roles: [],
			text: "@Pi hello",
			mentionsBot: true,
			attachments: [],
		});
		await entered.promise;
		try {
			await f.locks.set({ session: "s1", lock: current }, BACKGROUND_CONTEXT);
			await poll(async () => JSON.stringify(await f.mirrored()) === JSON.stringify(current));
		} finally {
			release.resolve();
		}
		await delivering;
		assert.ok(
			await f.durable.submission(state.pending["1"]!.submissionId as SubmissionId, f.context),
			"real ingress reached submission, not merely argument rejection",
		);
		assert.deepEqual(await f.mirrored(), current, "a captured delivery cannot replace authoritative policy");
		if (update === "restrict") {
			let executed = false;
			const tool = guardTool({
				name: "probe",
				description: "probe",
				parameters: obj({}),
				origin: "owner",
				locked: "ports",
				execute: async () => {
					executed = true;
					return { output: [] };
				},
			});
			// This guard reads only the session-scoped lock; execute and other ToolAPI members are unreachable.
			const api = { snapshot: f.durable.snapshot.bind(f.durable) } as unknown as Parameters<P2Tool["execute"]>[1];
			assert.equal((await tool.execute({}, api, f.context)).isError, true);
			assert.equal(executed, false);
		}
	});
}
