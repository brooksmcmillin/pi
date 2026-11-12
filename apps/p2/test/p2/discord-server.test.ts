// Discord unlink settles worker revocation before unlocking, with retryable persisted cleanup.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { openStore, sqliteBackend } from "@earendil-works/chord";
import { withTelemetry } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT, defineFacet, type Facet, Session, withAbortSignal } from "@p2/app/v1";
import { Server } from "@p2/app/v1/server";
import { Client } from "discord.js";
import { Bot } from "../../plugins/discord/bot.ts";
import { DiscordIngress, DiscordStore } from "../../plugins/discord/contract.ts";
import discordServer from "../../plugins/discord/server.ts";
import { EnvService } from "../../plugins/envs/contract.ts";
import { ArchivedSessionChanges, PreparedSessionMoves } from "../../plugins/sessions/contract.server.ts";
import { Catalog, SessionLocks, SessionMoves, type Session as SessionRow } from "../../plugins/sessions/contract.ts";
import { serveLocks } from "../../plugins/sessions/locks.ts";
import { StatusStore } from "../../plugins/status/contract.ts";
import { serveNative } from "../../src/runtime/chord.ts";
import { HOST, SERVER } from "../../src/runtime/principals.ts";
import { memoryLinkPair, poll, type TestHost, testHost } from "./helpers.ts";

const LOCK = { mcp: [], projectMcp: false, instructions: false, capabilities: [] };

async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "p2-discord-server-"));
	const cleanup: (() => Promise<void>)[] = [];
	t.after(async () => {
		for (const close of cleanup.reverse()) await close();
		await rm(directory, { recursive: true, force: true });
	});
	const store = await openStore(
		sqliteBackend(await openNodeSqliteDatabase(join(directory, "state.sqlite"))),
		BACKGROUND_CONTEXT,
	);
	cleanup.push(() => store.close(BACKGROUND_CONTEXT));
	t.mock.method(Bot.prototype, "connect", async function (this: Bot) {
		this.client = new Client({ intents: [] });
		t.mock.method(this.client, "isReady", () => true);
		this.status = { state: "connected", user: "test", applicationId: "test", inviteUrl: "", guilds: [] };
		return this.status;
	});
	t.mock.method(Bot.prototype, "channel", async (id: string) => ({
		id,
		name: "general",
		guildId: "g1",
		guildName: "Guild",
		lastMessageId: null,
	}));
	const row: SessionRow = {
		id: "s1",
		env: "sandbox",
		cwd: "/root",
		title: "Test",
		createdAt: 1,
		updatedAt: 1,
		archivedAt: null,
		pinned: false,
		model: { provider: "faux", modelId: "faux-1" },
		thinkingLevel: "off",
		main: 1,
		branches: [],
	};
	let markArchived = () => {};
	const facets: Facet[] = [
		defineFacet(serveLocks),
		discordServer,
		defineFacet((host, self) => {
			serveNative(host, PreparedSessionMoves);
			serveNative(host, ArchivedSessionChanges);
			// This fixture's worker remains live even when the catalog is marked archived.
			self.contribute(ArchivedSessionChanges, { whileArchived: async () => false });
			// These tests isolate unlink settlement; real confinement is covered by discord-confinement.test.ts.
			self.contribute(PreparedSessionMoves, {
				withPreparedMove: (_target, transition, context) =>
					server.host.root(async (ctx) => {
						transition.validate();
						await transition.publish(ctx);
					}, context),
			});
		}),
	];
	let worker: TestHost;
	const telemetry = new InMemoryTelemetryContext();
	const server = await testHost({
		telemetry,
		store,
		facets,
		beforeLoad: (host) =>
			host.route(
				Session,
				{
					authorize: (principal, address) => principal.kind === "server" && address.params.id === "s1",
					resolve: async (_address, context) => {
						const [down, up] = memoryLinkPair();
						worker.host.accept(up, { principal: SERVER }, context);
						return { link: down, principal: HOST };
					},
				},
				BACKGROUND_CONTEXT,
			),
		stubs: [
			[
				Server,
				(_params, _principal, self) => ({
					info: self.state({ app: directory, dataDir: directory, fake: true, allowedHosts: [], port: 0 }),
					revokeOwners: async () => null,
					revokeGuests: async () => null,
				}),
			],
			[
				Catalog,
				(_params, _principal, self) => {
					const sessions = self.state([row]);
					markArchived = () => sessions.replace(BACKGROUND_CONTEXT, [{ ...row, archivedAt: 1 }]);
					return {
						sessions,
						get: async () => row,
						create: async () => row,
						update: async () => row,
						activity: async () => null,
					};
				},
			],
			[
				EnvService,
				(_params, _principal, self) => ({
					configs: self.state({ sandbox: { type: "gondolin", host: "local" } }),
					tests: self.state({}),
					failure: self.state(null),
					reload: async () => null,
					test: async () => ({ ok: false, testedAt: 0, error: "not needed" }),
				}),
			],
			[SessionMoves, { relocate: async () => ({ refused: null }) }],
			[StatusStore, (_params, _principal, self) => ({ statuses: self.state({}), report: async () => null })],
		],
	});
	cleanup.push(() => server.close());
	const revocations: number[] = [];
	let revoke = async (_generation: number): Promise<void> => {};
	worker = await testHost({
		address: Session({ id: "s1" }),
		kind: "worker",
		facets: [],
		stubs: [
			[
				DiscordIngress,
				{
					variant: "server",
					unlinked: async ({ generation }: { generation: number }) => {
						revocations.push(generation);
						await revoke(generation);
						return null;
					},
					deliver: async () => ({ conversation: 1, submissionId: 1 }),
					thread: async () => ({ conversation: 2 }),
					command: async () => ({ text: "" }),
					turn: async () => ({ state: "pending" }),
					read: async () => new Uint8Array(),
				},
			],
		],
	});
	cleanup.push(() => worker.close());
	const discord = server.host.hold(DiscordStore, {}, BACKGROUND_CONTEXT);
	const locks = server.host.hold(SessionLocks, {}, BACKGROUND_CONTEXT);
	const { id: bot } = await discord.addBot({ token: "disposable-test-token" }, BACKGROUND_CONTEXT);
	const link = {
		session: "s1",
		bot,
		guild: "g1",
		channel: "c1",
		wake: { anyone: true, users: [], roles: [] },
		sandbox: "sandbox",
		lock: LOCK,
	};
	await discord.link(link, BACKGROUND_CONTEXT);
	return {
		discord,
		locks,
		link,
		revocations,
		markArchived: () => markArchived(),
		telemetry,
		relinkAdmitted: () =>
			poll(() =>
				telemetry
					.getSpans()
					.some(
						(span) =>
							span.name === "chord.method" &&
							span.attributes.type === "p2.discord-store" &&
							span.attributes.member === "link",
					),
			),
		setRevoke: (fn: typeof revoke) => {
			revoke = fn;
		},
		restart: () => server.reload(facets),
		unload: () => server.reload([]),
	};
}

test(
	"security:discord-unlink-leaves-relay-authorized: worker acknowledgement precedes unlock and relink",
	{ timeout: 20_000 },
	async (t) => {
		const f = await fixture(t);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.setRevoke(async () => {
			entered.resolve();
			await release.promise;
		});
		const unlinking = f.discord.unlink({ session: "s1" }, BACKGROUND_CONTEXT);
		await entered.promise;
		let relinked = false;
		const relinking = f.telemetry.startSpan({ name: "relink-test" }, async (span) => {
			await f.discord.link(f.link, withTelemetry(span, BACKGROUND_CONTEXT));
			relinked = true;
		});
		try {
			await f.relinkAdmitted();
			assert.deepEqual(f.locks.locks.value.s1, LOCK);
			assert.equal(relinked, false);
		} finally {
			release.resolve();
			await Promise.allSettled([unlinking, relinking]);
		}
		await Promise.all([unlinking, relinking]);
		assert.deepEqual(f.locks.locks.value.s1, LOCK, "the replacement link is locked");
		assert.equal(f.discord.bindings.value.length, 1);
		assert.equal("generation" in f.discord.bindings.value[0]!, false, "public owner schema stays unchanged");
		await f.discord.unlink({ session: "s1" }, BACKGROUND_CONTEXT);
		assert.equal(f.revocations.length, 2);
		assert(f.revocations[1]! > f.revocations[0]!);
		assert.equal(f.locks.locks.value.s1, undefined);
	},
);

test(
	"security:discord-unlink-leaves-relay-authorized: archived catalog row does not prove worker revocation",
	{ timeout: 20_000 },
	async (t) => {
		const f = await fixture(t);
		// PR #9: archive marks the catalog before its hooks finish and the worker is suspended.
		f.markArchived();
		f.setRevoke(async () => {
			throw new Error("live worker has not acknowledged revocation");
		});
		await assert.rejects(
			f.discord.unlink({ session: "s1" }, BACKGROUND_CONTEXT),
			/live worker has not acknowledged revocation/,
		);
		assert.deepEqual(f.locks.locks.value.s1, LOCK);
		assert.equal(f.discord.bindings.value.length, 1);
		assert.deepEqual(f.revocations, [1]);
	},
);

test(
	"security:discord-unlink-leaves-relay-authorized: failed revocation keeps the lock and retries after reload",
	{ timeout: 20_000 },
	async (t) => {
		const f = await fixture(t);
		f.setRevoke(async () => {
			throw new Error("injected worker revocation failure");
		});
		await assert.rejects(
			f.discord.unlink({ session: "s1" }, BACKGROUND_CONTEXT),
			/injected worker revocation failure/,
		);
		assert.deepEqual(f.locks.locks.value.s1, LOCK);
		assert.equal(f.discord.bindings.value.length, 1);
		await f.unload();
		await f.restart();
		await assert.rejects(f.discord.link(f.link, BACKGROUND_CONTEXT), /linked already/);
		f.setRevoke(async () => {});
		await f.discord.unlink({ session: "s1" }, BACKGROUND_CONTEXT);
		assert.equal(f.locks.locks.value.s1, undefined);
		assert.deepEqual(f.discord.bindings.value, []);
		assert.deepEqual(f.revocations, [1, 1], "retry revokes the same incarnation");
	},
);

test(
	"security:discord-unlink-leaves-relay-authorized: accepted cleanup survives caller cancellation",
	{ timeout: 20_000 },
	async (t) => {
		const f = await fixture(t);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.setRevoke(async () => {
			entered.resolve();
			await release.promise;
		});
		const caller = new AbortController();
		const unlinking = f.discord.unlink({ session: "s1" }, withAbortSignal(caller.signal, BACKGROUND_CONTEXT));
		const settled = Promise.allSettled([unlinking]);
		await entered.promise;
		try {
			caller.abort();
			assert.equal((await settled)[0]!.status, "rejected");
			assert.deepEqual(f.locks.locks.value.s1, LOCK);
		} finally {
			release.resolve();
		}
		await poll(() => f.discord.bindings.value.length === 0);
		assert.equal(f.locks.locks.value.s1, undefined);
	},
);

test(
	"security:discord-unlink-leaves-relay-authorized: bot removal retries retained revocations",
	{ timeout: 20_000 },
	async (t) => {
		const f = await fixture(t);
		f.setRevoke(async () => {
			throw new Error("injected worker revocation failure");
		});
		await assert.rejects(
			f.discord.removeBot({ bot: f.link.bot }, BACKGROUND_CONTEXT),
			/injected worker revocation failure/,
		);
		assert.equal(f.discord.bots.value.length, 1);
		assert.deepEqual(f.locks.locks.value.s1, LOCK);
		f.setRevoke(async () => {});
		await f.discord.removeBot({ bot: f.link.bot }, BACKGROUND_CONTEXT);
		assert.deepEqual(f.discord.bots.value, []);
		assert.deepEqual(f.discord.bindings.value, []);
		assert.equal(f.locks.locks.value.s1, undefined);
	},
);
