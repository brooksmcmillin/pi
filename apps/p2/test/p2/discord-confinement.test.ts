// Link confinement through real Discord, sessions movement and forked worker ownership, without remote services.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, defineFacet } from "@p2/app/v1";
import { Client } from "discord.js";
import { Chat } from "../../plugins/chat/contract.ts";
import { Bot } from "../../plugins/discord/bot.ts";
import { Discord, DiscordIngress } from "../../plugins/discord/contract.ts";
import discordServer from "../../plugins/discord/server.ts";
import { EnvManagers, EnvService } from "../../plugins/envs/contract.ts";
import { EnvManager } from "../../plugins/envs/manager.ts";
import { AgentLocations } from "../../plugins/locations/contract.ts";
import locationsServer from "../../plugins/locations/server.ts";
import { ArchivedSessionChanges } from "../../plugins/sessions/contract.server.ts";
import { Catalog, SessionArchived, SessionLocks, Sessions } from "../../plugins/sessions/contract.ts";
import { SessionWorkers } from "../../src/hosts/session-workers.ts";
import { Session, serveNative } from "../../src/runtime/chord.ts";
import { ServerNatives } from "../../src/runtime/server.ts";
import { WorkerBoundary } from "../../src/runtime/session-worker.ts";
import { ConfinementProbe } from "./discord-confinement-contract.ts";
import { holdIn, startFixture, until } from "./helpers.ts";

const LOCK = { mcp: [], projectMcp: false, instructions: false, capabilities: [] };

test(
	"security:discord-link-preserves-unsandboxed-subagents: real link refuses an own-location child",
	{ timeout: 120_000 },
	async (t) => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "p2-confinement-")));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const sandbox = join(directory, "sandbox");
		const own = join(directory, "own");
		await Promise.all([mkdir(sandbox), mkdir(own)]);
		const manager = new EnvManager(directory, async () => 0, directory);
		t.mock.method(manager, "workingDirectory", async (name: string, path: string) => {
			assert.equal(name, "sandbox");
			assert.equal(path, sandbox);
			return sandbox;
		});
		const environments = defineFacet((host, self) => {
			serveNative(host, EnvManagers);
			self.contribute(EnvManagers, { manager });
			host.serve(EnvService, (_params, self) => ({
				configs: self.derive([], () => ({
					sandbox: { type: "gondolin" as const, host: "local", mounts: [{ host: sandbox, guest: sandbox }] },
					ssh: { type: "ssh" as const, host: "offline.invalid" },
				})),
				tests: self.derive([], () => ({})),
				failure: self.derive([], () => null),
				reload: async () => null,
				test: async () => ({ ok: false, testedAt: 0, error: "not used" }),
			}));
		});
		let starting:
			| { session: string; entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }
			| undefined;
		const create = SessionWorkers.create;
		t.mock.method(
			SessionWorkers,
			"create",
			(options: Parameters<typeof create>[0], context: Parameters<typeof create>[1]) =>
				create(
					{
						...options,
						entry: fileURLToPath(new URL("./discord-confinement-worker.ts", import.meta.url)),
						values: async (session, ctx) => {
							const values = await options.values(session, ctx);
							const held = starting;
							if (held?.session === session) {
								held.entered.resolve();
								await held.release.promise;
							}
							return values;
						},
					},
					context,
				),
		);
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
		t.mock.method(Bot.prototype, "messages", async () => []);
		let archiveGate:
			| { session: string; entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }
			| undefined;
		const fixture = await startFixture({
			plugins: ["chat", "drafts", "files", "models", "sessions", "status", "subagents"],
			facets: [
				{ name: "discord", facet: discordServer },
				{ name: "offline-environments", facet: environments },
				{ name: "locations", facet: locationsServer },
				{
					name: "archive-gate",
					facet: defineFacet((_host, self) => {
						self.contribute(SessionArchived, {
							gate: async (session) => {
								if (archiveGate?.session === session) {
									archiveGate.entered.resolve();
									await archiveGate.release.promise;
								}
							},
						});
					}),
				},
			],
		});
		t.after(() => fixture.close());
		const owner = fixture.as({ kind: "owner", access: "local", session: "confinement-owner" });
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const discord = await holdIn(owner, Discord, {}, "owner");
		const { id: bot } = await discord.addBot({ token: "offline-test-token" }, BACKGROUND_CONTEXT);
		const link = (session: string, channel: string) => ({
			session,
			channel,
			bot,
			guild: "g1",
			sandbox: "sandbox",
			lock: LOCK,
			wake: { anyone: true, users: [], roles: [] },
		});
		const options = {
			cwd: fixture.workspace,
			model: { provider: "faux", modelId: "faux-1" },
			thinkingLevel: "off",
		} as const;

		// Availability control: a rejected unsafe link must not pass because the sandbox or restart is broken.
		const safe = await sessions.create(options, BACKGROUND_CONTEXT);
		await discord.link(link(safe.id, "safe"), BACKGROUND_CONTEXT);
		await fixture.server.host.root(async (ctx) => {
			const probe = await ctx.get(ConfinementProbe, { session: safe.id });
			const actual = await probe.inspect({ conversation: 1 }, ctx);
			assert.deepEqual(actual.location, { env: "sandbox", cwd: sandbox });
			assert.equal(actual.marker, sandbox);
			assert.deepEqual((await ctx.get(SessionLocks, {})).locks.value[safe.id], LOCK);
		}, BACKGROUND_CONTEXT);
		assert(discord.bindings.value.some((binding) => binding.session === safe.id));

		await t.test("PR #9: unlink waits for archival shutdown of an admitted Discord input", async () => {
			const gate = {
				session: safe.id,
				entered: Promise.withResolvers<void>(),
				release: Promise.withResolvers<void>(),
			};
			archiveGate = gate;
			try {
				await fixture.server.host.root(async (ctx) => {
					const probe = await ctx.get(ConfinementProbe, { session: safe.id });
					const ingress = await ctx.get(DiscordIngress, { session: safe.id });
					await probe.armInput(ctx);
					const delivery = ingress.deliver(
						{
							generation: 1,
							requestId: "archive-blocked-input",
							author: { id: "u1", name: "User" },
							text: "archive-blocked-input",
							context: { channel: "general", guild: "Guild", messages: 1 },
							files: [],
						},
						ctx,
					);
					const delivered = Promise.allSettled([delivery]);
					await probe.inputEntered(ctx);
					await sessions.archive({ id: safe.id }, ctx);
					await gate.entered.promise;
					const changes = (await fixture.server.host.registry(ArchivedSessionChanges, ctx)).value!;
					const whileArchived = changes.whileArchived;
					const unlinkEntered = Promise.withResolvers<void>();
					const wrapped = t.mock.method(changes, "whileArchived", (...args: Parameters<typeof whileArchived>) => {
						unlinkEntered.resolve();
						return whileArchived(...args);
					});
					const unlinking = discord.unlink({ session: safe.id }, ctx);
					try {
						await unlinkEntered.promise;
						assert.deepEqual((await ctx.get(SessionLocks, {})).locks.value[safe.id], LOCK);
						gate.release.resolve();
						await unlinking;
						assert.equal((await delivered)[0]!.status, "rejected", "shutdown cancels the admitted native input");
						assert.equal((await ctx.get(SessionLocks, {})).locks.value[safe.id], undefined);
					} finally {
						gate.release.resolve();
						wrapped.mock.restore();
						await Promise.allSettled([unlinking, delivery]);
					}
				}, BACKGROUND_CONTEXT);
				await sessions.restore({ id: safe.id }, BACKGROUND_CONTEXT);
				const chat = await holdIn(owner, Chat, { session: safe.id, conversation: 1 }, "participant");
				try {
					await until(chat.view, (view) => view !== undefined && view !== null);
					assert(!JSON.stringify(chat.view.value).includes("archive-blocked-input"));
				} finally {
					chat.release();
				}
			} finally {
				gate.release.resolve();
				archiveGate = undefined;
			}
		});

		const target = await sessions.create(options, BACKGROUND_CONTEXT);
		await fixture.server.host.root(async (ctx) => {
			const probe = await ctx.get(ConfinementProbe, { session: target.id });
			const child = await probe.seed({ name: "external", location: { env: null, cwd: own } }, ctx);
			assert.deepEqual((await probe.inspect({ conversation: child }, ctx)).location, { env: null, cwd: own });
			const boundary = await ctx.get(WorkerBoundary, { session: target.id });
			assert.equal((await boundary.prepare(null, ctx)).accepted, true);
			await boundary.cancel(ctx);
			await assert.rejects(
				discord.link(link(target.id, "unsafe"), ctx),
				/works outside the selected sandbox sandbox/,
			);
			const catalog = await ctx.get(Catalog, {});
			assert.equal((await catalog.get({ id: target.id }, ctx))?.cwd, fixture.workspace);
			assert.equal((await ctx.get(SessionLocks, {})).locks.value[target.id], undefined);
			assert(!discord.bindings.value.some((binding) => binding.session === target.id));
			assert.deepEqual((await probe.inspect({ conversation: child }, ctx)).location, { env: null, cwd: own });
		}, BACKGROUND_CONTEXT);

		for (const variant of ["ssh", "archived", "nested", "already-sandboxed", "cold", "legacy"] as const) {
			await t.test(`refuses ${variant} external placement without losing history`, async () => {
				const target = await sessions.create(
					variant === "already-sandboxed" ? { ...options, cwd: sandbox, env: "sandbox" } : options,
					BACKGROUND_CONTEXT,
				);
				const location = { cwd: own, env: variant === "ssh" ? "ssh" : null };
				const seeded = await fixture.server.host.root(async (ctx) => {
					const probe = await ctx.get(ConfinementProbe, { session: target.id });
					const parent = variant === "nested" ? await probe.seed({ name: "following-parent" }, ctx) : undefined;
					const child = await probe.seed(
						{
							name: "external",
							location,
							...(parent === undefined ? {} : { parent }),
							archived: variant === "archived",
							legacy: variant === "legacy",
						},
						ctx,
					);
					const before = await probe.inspect({ conversation: child }, ctx);
					assert.equal(before.history, true);
					return { child, before };
				}, BACKGROUND_CONTEXT);
				if (variant === "cold" || variant === "legacy")
					await fixture.server.host.root(async (ctx) => {
						const workers = (await fixture.server.host.registry(ServerNatives, ctx)).value!.workers;
						await workers.suspend(target.id);
						assert(!workers.running().includes(target.id));
					}, BACKGROUND_CONTEXT);
				await assert.rejects(
					discord.link(link(target.id, variant), BACKGROUND_CONTEXT),
					/works outside the selected sandbox/,
				);
				await fixture.server.host.root(async (ctx) => {
					const actual = await (await ctx.get(ConfinementProbe, { session: target.id })).inspect(
						{ conversation: seeded.child },
						ctx,
					);
					assert.deepEqual(actual.location, location);
					assert.equal(actual.history, true);
					assert.equal(actual.marker, own);
					if (variant === "cold") assert(actual.generation > seeded.before.generation);
					assert.equal((await ctx.get(SessionLocks, {})).locks.value[target.id], undefined);
					const row = await (await ctx.get(Catalog, {})).get({ id: target.id }, ctx);
					assert.equal(row.env, variant === "already-sandboxed" ? "sandbox" : null);
					assert(!discord.bindings.value.some((binding) => binding.session === target.id));
				}, BACKGROUND_CONTEXT);
			});
		}
		await t.test("followers and own/inherited same-sandbox children survive linking", async () => {
			const target = await sessions.create(options, BACKGROUND_CONTEXT);
			const children = await fixture.server.host.root(async (ctx) => {
				const probe = await ctx.get(ConfinementProbe, { session: target.id });
				const follower = await probe.seed({ name: "follower" }, ctx);
				const placed = await probe.seed({ name: "placed", location: { env: "sandbox", cwd: own } }, ctx);
				const inherited = await probe.seed(
					{ name: "nested", parent: placed, location: { env: "sandbox", cwd: own } },
					ctx,
				);
				return { follower, placed, inherited };
			}, BACKGROUND_CONTEXT);
			await discord.link(link(target.id, "compatible"), BACKGROUND_CONTEXT);
			await fixture.server.host.root(async (ctx) => {
				const probe = await ctx.get(ConfinementProbe, { session: target.id });
				for (const id of Object.values(children)) {
					const actual = await probe.inspect({ conversation: id }, ctx);
					assert.deepEqual(actual.location, { env: "sandbox", cwd: id === children.follower ? sandbox : own });
					assert.equal(actual.history, true);
					assert.equal(actual.marker, actual.location.cwd);
				}
			}, BACKGROUND_CONTEXT);
		});

		await t.test("persisted unfinished background work refuses a cold link", async () => {
			const target = await sessions.create(options, BACKGROUND_CONTEXT);
			await fixture.server.host.root(async (ctx) => {
				await (await ctx.get(ConfinementProbe, { session: target.id })).startBackground(ctx);
			}, BACKGROUND_CONTEXT);
			await fixture.server.host.root(async (ctx) => {
				const workers = (await fixture.server.host.registry(ServerNatives, ctx)).value!.workers;
				await workers.suspend(target.id);
				assert(!workers.running().includes(target.id));
			}, BACKGROUND_CONTEXT);
			await assert.rejects(discord.link(link(target.id, "unfinished"), BACKGROUND_CONTEXT), /still running/);
			await fixture.server.host.root(async (ctx) => {
				assert.equal((await (await ctx.get(Catalog, {})).get({ id: target.id }, ctx)).env, null);
				assert.equal((await ctx.get(SessionLocks, {})).locks.value[target.id], undefined);
			}, BACKGROUND_CONTEXT);
			assert(!discord.bindings.value.some((binding) => binding.session === target.id));
		});

		await t.test("pending input refuses linking without moving or locking", async () => {
			const target = await sessions.create(options, BACKGROUND_CONTEXT);
			const chat = await holdIn(owner, Chat, { session: target.id, conversation: 1 }, "participant");
			await fixture.server.host.root(async (ctx) => {
				const probe = await ctx.get(ConfinementProbe, { session: target.id });
				await probe.armInput(ctx);
				const sending = chat.send({ text: "hello", requestId: "confinement-busy" }, ctx);
				const settled = Promise.allSettled([sending]);
				try {
					await probe.inputEntered(ctx);
					await assert.rejects(discord.link(link(target.id, "busy"), ctx), /still running/);
					assert.equal((await (await ctx.get(Catalog, {})).get({ id: target.id }, ctx)).env, null);
					assert.equal((await ctx.get(SessionLocks, {})).locks.value[target.id], undefined);
				} finally {
					await probe.releaseInput(ctx);
					await settled;
				}
				await sending;
				await chat.stop(ctx);
			}, BACKGROUND_CONTEXT);
			chat.release();
		});

		for (const boundary of ["frozen", "replaced"] as const) {
			await t.test(`inspected worker remains ${boundary} before publication`, async () => {
				const target = await sessions.create(options, BACKGROUND_CONTEXT);
				const entered = Promise.withResolvers<SessionWorkers>();
				const release = Promise.withResolvers<void>();
				const pause = SessionWorkers.prototype.pauseChecked;
				t.mock.method(
					SessionWorkers.prototype,
					"pauseChecked",
					function (this: SessionWorkers, ...[session, prepare, work, context]: Parameters<typeof pause>) {
						return pause.call(
							this,
							session,
							async () => {
								const result = await prepare();
								if (session === target.id) {
									entered.resolve(this);
									await release.promise;
								}
								return result;
							},
							work,
							context,
						);
					},
				);
				const linking = discord.link(link(target.id, boundary), BACKGROUND_CONTEXT);
				const settled = Promise.allSettled([linking]);
				try {
					const workers = await entered.promise;
					if (boundary === "replaced") {
						const generation = workers.generation(target.id);
						await workers.workers.stop(Session({ id: target.id }), BACKGROUND_CONTEXT);
						await workers.workers.retry(Session({ id: target.id }), BACKGROUND_CONTEXT);
						await until(
							workers.workers.state,
							(states) => states?.[`session|${target.id}`]?.status === "running",
						);
						assert(workers.generation(target.id) > generation);
					} else {
						await fixture.server.host.root(async (ctx) => {
							const probe = await ctx.get(ConfinementProbe, { session: target.id });
							await assert.rejects(
								probe.seed({ name: "too-late", location: { env: null, cwd: own } }, ctx),
								/changing/,
							);
						}, BACKGROUND_CONTEXT);
						const chat = await holdIn(owner, Chat, { session: target.id, conversation: 1 }, "participant");
						try {
							await assert.rejects(
								chat.send({ text: "hello", requestId: "frozen" }, BACKGROUND_CONTEXT),
								/changing/,
							);
						} finally {
							chat.release();
						}
					}
				} finally {
					release.resolve();
					await settled;
				}
				if (boundary === "replaced") {
					await assert.rejects(linking, /exited or was replaced/);
					await fixture.server.host.root(async (ctx) => {
						assert.equal((await (await ctx.get(Catalog, {})).get({ id: target.id }, ctx)).env, null);
						assert.equal((await ctx.get(SessionLocks, {})).locks.value[target.id], undefined);
					}, BACKGROUND_CONTEXT);
					assert(!discord.bindings.value.some((binding) => binding.session === target.id));
				} else await linking;
			});
		}

		await t.test("publication excludes worker recovery and competing channel links", async () => {
			const first = await sessions.create(options, BACKGROUND_CONTEXT);
			const second = await sessions.create(options, BACKGROUND_CONTEXT);
			const entered = Promise.withResolvers<SessionWorkers>();
			const release = Promise.withResolvers<void>();
			const pause = SessionWorkers.prototype.pauseChecked;
			t.mock.method(
				SessionWorkers.prototype,
				"pauseChecked",
				function (this: SessionWorkers, ...[session, prepare, work, context]: Parameters<typeof pause>) {
					return pause.call(
						this,
						session,
						prepare,
						async () => {
							if (session === first.id) {
								entered.resolve(this);
								await release.promise;
							}
							await work();
						},
						context,
					);
				},
			);
			const linking = discord.link(link(first.id, "reserved"), BACKGROUND_CONTEXT);
			const settled = Promise.allSettled([linking]);
			try {
				const workers = await entered.promise;
				const generation = workers.generation(first.id);
				assert(!workers.running().includes(first.id));
				await assert.rejects(discord.link(link(second.id, "reserved"), BACKGROUND_CONTEXT), /being linked/);
				await workers.workers.retry(Session({ id: first.id }), BACKGROUND_CONTEXT);
				await until(workers.workers.state, (states) => states?.[`session|${first.id}`]?.status === "failed");
				assert.equal(workers.generation(first.id), generation);
				await fixture.server.host.root(async (ctx) => {
					const catalog = await ctx.get(Catalog, {});
					for (const id of [first.id, second.id]) {
						assert.equal((await catalog.get({ id }, ctx)).env, null);
						assert.equal((await ctx.get(SessionLocks, {})).locks.value[id], undefined);
					}
				}, BACKGROUND_CONTEXT);
			} finally {
				release.resolve();
				await settled;
			}
			await linking;
			await fixture.server.host.root(async (ctx) => {
				const actual = await (await ctx.get(ConfinementProbe, { session: first.id })).inspect(
					{ conversation: 1 },
					ctx,
				);
				assert.deepEqual(actual.location, { env: "sandbox", cwd: sandbox });
				assert.equal(actual.marker, sandbox);
				assert.deepEqual((await ctx.get(SessionLocks, {})).locks.value[first.id], LOCK);
			}, BACKGROUND_CONTEXT);
		});

		await t.test("replacement already preparing start values cannot publish a stale inspection", async () => {
			const target = await sessions.create(options, BACKGROUND_CONTEXT);
			const gate = {
				session: target.id,
				entered: Promise.withResolvers<void>(),
				release: Promise.withResolvers<void>(),
			};
			const pause = SessionWorkers.prototype.pauseChecked;
			t.mock.method(
				SessionWorkers.prototype,
				"pauseChecked",
				function (this: SessionWorkers, ...[session, prepare, work, context]: Parameters<typeof pause>) {
					return pause.call(
						this,
						session,
						async () => {
							const result = await prepare();
							if (session === target.id) {
								starting = gate;
								await this.workers.stop(Session({ id: session }), context);
								await this.workers.retry(Session({ id: session }), context);
								await gate.entered.promise;
							}
							return result;
						},
						work,
						context,
					);
				},
			);
			const linking = discord.link(link(target.id, "starting"), BACKGROUND_CONTEXT);
			const settled = Promise.allSettled([linking]);
			try {
				await gate.entered.promise;
				await fixture.server.host.root(async (ctx) => {
					assert.equal((await (await ctx.get(Catalog, {})).get({ id: target.id }, ctx)).env, null);
					assert.equal((await ctx.get(SessionLocks, {})).locks.value[target.id], undefined);
				}, BACKGROUND_CONTEXT);
			} finally {
				starting = undefined;
				gate.release.resolve();
				await settled;
			}
			await assert.rejects(linking, /exited or was replaced/);
			assert(!discord.bindings.value.some((binding) => binding.session === target.id));
		});

		await t.test("queued worker move cannot leave a newly linked sandbox", async () => {
			const queued = await sessions.create(options, BACKGROUND_CONTEXT);
			const generation = await fixture.server.host.root(async (ctx) => {
				const probe = await ctx.get(ConfinementProbe, { session: queued.id });
				return (await probe.inspect({ conversation: 1 }, ctx)).generation;
			}, BACKGROUND_CONTEXT);
			const worker = fixture.as({ kind: "worker", session: queued.id, generation });
			const locations = await holdIn(worker, AgentLocations, {}, "worker");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const relocate = SessionWorkers.prototype.relocate;
			t.mock.method(
				SessionWorkers.prototype,
				"relocate",
				async function (this: SessionWorkers, ...args: Parameters<typeof relocate>) {
					if (args[0] === queued.id) {
						entered.resolve();
						await release.promise;
					}
					return relocate.apply(this, args);
				},
			);
			const moving = locations.move({ origin: "owner", env: null, cwd: own }, BACKGROUND_CONTEXT);
			const outcome = moving.then(
				() => "resolved",
				(error: unknown) => error,
			);
			try {
				await entered.promise;
				await discord.link(link(queued.id, "queued"), BACKGROUND_CONTEXT);
			} finally {
				release.resolve();
			}
			assert.match(String(await outcome), /stale worker/);
			await fixture.server.host.root(async (ctx) => {
				assert.equal((await (await ctx.get(Catalog, {})).get({ id: queued.id }, ctx)).env, "sandbox");
			}, BACKGROUND_CONTEXT);
		});
	},
);
