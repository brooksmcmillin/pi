// Persisted Discord state migrations give live links authority and discard orphaned replies.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openStore, sqliteBackend } from "@earendil-works/chord";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, unknown } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT, defineFacet, defineState, local, method, propertiesOf, record } from "@p2/app/v1";
import { BindingSchema, PendingSchema } from "../../plugins/discord/contract.ts";
import { FIRST_BOT } from "../../plugins/discord/fleet.ts";
import { DiscordState } from "../../plugins/discord/server.ts";
import { DiscordLinkDoc } from "../../plugins/discord/worker.ts";
import { createP2Models } from "../../plugins/models/models.ts";
import { durableContext } from "../../src/runtime/durable.ts";
import { testHost } from "./helpers.ts";

const Probe = local("test.discord-state", {
	version: 1,
	params: {},
	members: { seed: method(), read: method(undefined, unknown()) },
});

for (const version of [1, 2]) {
	test(`security:discord-unlink-leaves-relay-authorized: state v${version} migrates only authorized pending replies`, async (t) => {
		const { botId: _bindingBot, ...singleBotBinding } = propertiesOf(BindingSchema);
		const { generation: _generation, ...pendingV2 } = propertiesOf(PendingSchema);
		const { botId: _pendingBot, ...pendingV1 } = pendingV2;
		const legacy = defineState("p2.discord-bindings", {
			version,
			schema: obj({
				bindings: record(version === 1 ? obj(singleBotBinding) : BindingSchema),
				pending: record(obj(version === 1 ? pendingV1 : pendingV2)),
			}),
			initial: () => ({ bindings: {}, pending: {} }),
			persist: true,
			checkpointWhen: () => true,
		});
		const binding = {
			channelId: "c1",
			channelName: "general",
			guildId: "g1",
			guildName: "Guild",
			session: "s1",
			wake: { anyone: true, users: [], roles: [] },
			cursor: null,
			threads: {},
			createdAt: 1,
		};
		const pending = {
			session: "s1",
			channelId: "c1",
			replyChannelId: "c1",
			messageId: "100",
			submissionId: 1,
			since: 1,
		};
		const named = version === 1 ? {} : { botId: "existing-bot" };
		const oldFacet = defineFacet((host) =>
			host.serve(Probe, (_params, self) => {
				const state = self.state(legacy);
				return {
					seed: async (ctx) => {
						await state.change((draft) => {
							draft.bindings.c1 = { ...binding, ...named };
							draft.pending["100"] = { ...pending, ...named };
							draft.pending["101"] = { ...pending, ...named, channelId: "gone", messageId: "101" };
							draft.pending["102"] = { ...pending, ...named, session: "other-session", messageId: "102" };
							if (version === 2) {
								const foreign = { ...pending, botId: "other-bot", messageId: "103" };
								draft.pending["103"] = foreign;
							}
						}, ctx);
						return null;
					},
					read: async () => state.value,
				};
			}),
		);
		const currentFacet = defineFacet((host) =>
			host.serve(Probe, (_params, self) => {
				const state = self.state(DiscordState);
				return { seed: async () => null, read: async () => state.value };
			}),
		);
		const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), BACKGROUND_CONTEXT);
		const host = await testHost({ store, facets: [oldFacet] });
		t.after(async () => {
			await host.close();
			await store.close(BACKGROUND_CONTEXT);
		});
		const probe = host.host.hold(Probe, {}, BACKGROUND_CONTEXT);
		await probe.seed(BACKGROUND_CONTEXT);
		await host.reload([currentFacet]);
		const botId = version === 1 ? FIRST_BOT : "existing-bot";
		assert.deepEqual(await probe.read(BACKGROUND_CONTEXT), {
			bindings: { c1: { ...binding, botId, generation: 1, phase: "linked" } },
			pending: { "100": { ...pending, botId, generation: 1 } },
			nextGeneration: 1,
		});
	});
}

test("security:discord-unlink-leaves-relay-authorized: persisted worker v1 prompt metadata migrates without new authority", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-discord-migration-"));
	const path = join(directory, "worker.sqlite");
	const ctx = durableContext(BACKGROUND_CONTEXT);
	const legacy = defineDoc<{ link: { channel: string; guild: string } | null; threads: Record<string, string> }>({
		kind: "p2.discord-link",
		version: 1,
		scope: "session",
		initial: () => ({ link: null, threads: {} }),
		checkpointWhen: () => true,
	});
	let durable = await Harness.open(
		await openNodeSqliteStorage(path),
		{ models: createP2Models(true), registry: createRegistry() },
		ctx,
	);
	t.after(async () => {
		await durable.close(ctx);
		await rm(directory, { recursive: true, force: true });
	});
	await durable.commit(async (tx) => {
		const doc = await tx.doc(legacy);
		doc.link = { channel: "general", guild: "Guild" };
		doc.threads["2"] = "thread-context";
	}, ctx);
	await durable.close(ctx);
	durable = await Harness.open(
		await openNodeSqliteStorage(path),
		{ models: createP2Models(true), registry: createRegistry() },
		ctx,
	);
	assert.deepEqual(await durable.snapshot(DiscordLinkDoc, ctx), {
		link: { generation: 0, channel: "general", guild: "Guild" },
		threads: { "2": "thread-context" },
		revokedThrough: 0,
	});
});
