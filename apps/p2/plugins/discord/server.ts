// The discord plugin's server facet: the owner's bots (fleet.ts, tokens in `<data>/discord.json`), the links of
// sessions to channels with their cursors, threads and pending replies (persisted), the relay between them (relay.ts),
// and the owner's `Discord` view. Linking moves the session into a sandbox and locks it to the picked resources;
// unlinking lifts the lock.
import { join } from "node:path";
import { int, obj } from "@earendil-works/pi-schema";
import {
	type AcceptsTable,
	type Context,
	type Ctx,
	defineFacet,
	defineState,
	deriveTyped,
	followNative,
	forbidden,
	isOwner,
	nativeOf,
	type Ref,
	record,
	signalOf,
	sleep,
	withoutAbortSignal,
} from "@p2/app/v1";
import { optionalText, stripJsonComments } from "@p2/app/v1/node";
import { Routes, Server, serverOf } from "@p2/app/v1/server";
import { EnvService } from "../envs/contract.ts";
import { isSandbox } from "../envs/schema.ts";
import { ArchivedSessionChanges, PreparedSessionMoves } from "../sessions/contract.server.ts";
import { Catalog, SessionLocks, SessionMoves } from "../sessions/contract.ts";
import { StatusStore } from "../status/contract.ts";
import {
	type Binding,
	Discord,
	DiscordConfinement,
	DiscordIngress,
	DiscordStore,
	type Pending,
	PendingSchema,
	type RelayBinding,
	RelayBindingSchema,
} from "./contract.ts";
import { FIRST_BOT, Fleet } from "./fleet.ts";
import { Relay, type RelayState, type SessionPort } from "./relay.ts";

export const DiscordState = defineState("p2.discord-bindings", {
	schema: obj({
		bindings: record(RelayBindingSchema),
		pending: record(PendingSchema),
		nextGeneration: int({ minimum: 0 }),
	}),
	// 3: durable link generations and retryable revocation.
	version: 3,
	initial: () => ({ bindings: {}, pending: {}, nextGeneration: 0 }),
	migrate: (old, from) => {
		if (from !== 1 && from !== 2) throw new Error(`Unknown p2.discord-bindings version ${from}`);
		// Stored versions have their declared shape; v1 predates botId.
		const value = old as { bindings: Record<string, Binding>; pending: Record<string, Omit<Pending, "generation">> };
		let nextGeneration = 0;
		const bindings: Record<string, RelayBinding> = Object.fromEntries(
			Object.entries(value.bindings).map(([key, binding]) => [
				key,
				{
					...binding,
					botId: from === 1 ? FIRST_BOT : binding.botId,
					generation: ++nextGeneration,
					phase: "linked" as const,
				},
			]),
		);
		const pending = Object.fromEntries(
			Object.entries(value.pending).flatMap(([key, entry]) => {
				const botId = from === 1 ? FIRST_BOT : entry.botId;
				const binding = bindings[entry.channelId];
				return binding && binding.botId === botId && binding.session === entry.session
					? [[key, { ...entry, botId, generation: binding.generation }] as const]
					: [];
			}),
		);
		return { bindings, pending, nextGeneration };
	},
	persist: true,
	checkpointWhen: () => true,
});

/**
 * How often "typing" is refreshed while a delivery is under way or a reply pending (Discord shows it about 10 s), and
 * every how many of those pending turns are checked anyway.
 */
const TYPING_MS = 8_000;
const CHECK_EVERY = 2;

export default defineFacet((host) => {
	host.serve(DiscordStore, (_params, self) => {
		const server = self.get(Server, {});
		const catalog = self.get(Catalog, {});
		const envs = self.get(EnvService, {});
		const locks = self.get(SessionLocks, {});
		self.get(SessionMoves, {});
		const moves = nativeOf(self, PreparedSessionMoves, "The prepared session moves");
		const archivedChanges = nativeOf(self, ArchivedSessionChanges, "The archived session changes");
		const reservedChannels = new Set<string>();
		const statuses = self.get(StatusStore, {});
		const state = self.state(DiscordState);
		const dataDir = () => server.info.value.dataDir;
		const fleet = self.open(
			() => Fleet.open(dataDir()),
			(opened) => opened.close(),
		);
		/** The context of the store's live loop: replies, deliveries and state changes run under it. */
		let live: Ctx | undefined;
		const during = (): Ctx => {
			if (!live) throw new Error("The Discord store is not live");
			return live;
		};
		const usable = async (session: string): Promise<string | undefined> => {
			const row = catalog.sessions.value.find((entry) => entry.id === session);
			if (!row) return "its p2 session is gone.";
			if (row.archivedAt !== null) return "its p2 session is archived.";
			if (!row.env || !isSandbox(envs.configs.value, row.env)) return "its p2 session does not work in a sandbox.";
			return undefined;
		};
		const natives = serverOf(self);
		const mutations = new Map<string, Promise<unknown>>();
		const changeLink = <T>(session: string, caller: Ctx, change: (ctx: Context) => Promise<T>): Promise<T> => {
			const done = (mutations.get(session) ?? Promise.resolve())
				.catch(() => {})
				.then(() => {
					caller.abortSignal?.throwIfAborted();
					// Keep the method's call chain while finishing accepted work after caller disconnect.
					return change(withoutAbortSignal(caller));
				});
			mutations.set(session, done);
			return done.finally(() => {
				if (mutations.get(session) === done) mutations.delete(session);
			});
		};
		/** One call of session `session`'s worker (started if needed) as the server, in a scope of its own. */
		const ingress = <T>(
			session: string,
			call: (worker: Ref<typeof DiscordIngress>, ctx: Ctx) => Promise<T>,
			context: Context,
		): Promise<T> =>
			// A root scope releases the worker's reference when the call ends; the live routine's would keep them all.
			natives().root(async (ctx) => call(await ctx.get(DiscordIngress, { session }), ctx), context);
		const admit = <T>(
			session: string,
			generation: number,
			call: (worker: Ref<typeof DiscordIngress>, ctx: Ctx) => Promise<T>,
		): Promise<T> =>
			ingress(
				session,
				(worker, ctx) => {
					if (
						!Object.values(state.value.bindings).some(
							(binding) =>
								binding.session === session && binding.generation === generation && binding.phase === "linked",
						)
					)
						throw forbidden("The Discord link was revoked");
					return call(worker, ctx);
				},
				during(),
			);
		const sessions: SessionPort = {
			usable,
			deliver: (session, input) => admit(session, input.generation, (worker, ctx) => worker.deliver(input, ctx)),
			turn: (session, submissionId) =>
				ingress(session, (worker, ctx) => worker.turn({ submissionId }, ctx), during()),
			thread: (session, name, before, generation) =>
				admit(session, generation, (worker, ctx) => worker.thread({ name, before, generation }, ctx)),
			command: (session, input) => admit(session, input.generation, (worker, ctx) => worker.command(input, ctx)),
			read: (session, id, offset, length) =>
				ingress(session, (worker, ctx) => worker.read({ id, offset, length }, ctx), during()),
		};
		const relay = new Relay((bot) => fleet.value.connected(bot), sessions, {
			// The state's drafts are the same JSON as the relay's plain records.
			value: () => state.value as RelayState,
			change: (update) => state.change((draft) => update(draft as RelayState), during()),
		});
		self.onLive(async (ctx) => {
			live = ctx;
			// One event at a time, in the order the bots received them: a catch-up and a live mention never race.
			for (;;) {
				const received = await fleet.value.next(signalOf(ctx));
				if (!received) return;
				const { bot, event } = received;
				await (event.kind === "message" ? relay.onMessage(bot, event.message) : relay.catchUp(bot)).catch(
					(error: unknown) => console.error("p2 discord:", errorText(error)),
				);
			}
		});
		self.onLive(async (ctx) => {
			for (let tick = 1; !signalOf(ctx).aborted; tick++) {
				await sleep(TYPING_MS, ctx);
				await relay.typing();
				if (tick % CHECK_EVERY === 0 && Object.keys(state.value.pending).length)
					await relay.checkPending().catch(() => {});
			}
		});
		// A session's status changed: its turn may have ended.
		let seen: Record<string, string> = {};
		self.on(statuses.statuses, async ({ value }) => {
			const changed = new Set<string>();
			const next: Record<string, string> = {};
			for (const [session, status] of Object.entries(value)) {
				next[session] = `${status.running} ${status.tasks} ${status.busy.join(",")}`;
				if (next[session] !== seen[session]) changed.add(session);
			}
			seen = next;
			if (live && changed.size && Object.keys(state.value.pending).length)
				await relay.checkPending(changed).catch((error: unknown) => console.error("p2 discord:", errorText(error)));
		});
		// The bots' avatars for the owner's sheets: the page's CSP allows only its own images, so they come through here.
		const avatars = new Map<string, Promise<{ type: string; bytes: Buffer }>>();
		self.contribute(Routes, {
			"GET /discord/avatar": async (request, response, { principal }) => {
				const bot = new URL(request.url ?? "/", "http://localhost").searchParams.get("bot") ?? "";
				const status = fleet.value.views().find((view) => view.id === bot)?.status;
				const url = status?.state === "connected" ? status.avatarUrl : undefined;
				if (!isOwner(principal) || !url) {
					response.writeHead(404);
					response.end();
					return;
				}
				try {
					let avatar = avatars.get(url);
					if (!avatar) {
						avatar = fetchAvatar(url);
						avatars.set(url, avatar);
						avatar.catch(() => avatars.delete(url));
					}
					const { type, bytes } = await avatar;
					response.writeHead(200, {
						"Content-Type": type,
						"Content-Length": bytes.length,
						"Cache-Control": "private, max-age=86400",
						"Cross-Origin-Resource-Policy": "same-origin",
					});
					response.end(bytes);
				} catch {
					response.writeHead(502);
					response.end();
				}
			},
		});
		const connected = (bot: string) => {
			const found = fleet.value.connected(bot);
			if (!found) throw new Error("The Discord bot is not connected");
			return found;
		};
		/** Drops `session`'s link and lifts its lock; its agents stop being told they answer Discord. */
		const unlink = async (session: string, ctx: Context): Promise<void> => {
			const binding = Object.values(state.value.bindings).find((entry) => entry.session === session);
			if (!binding) return;
			await state.change((draft) => {
				draft.bindings[binding.channelId]!.phase = "revoking";
				for (const [id, reply] of Object.entries(draft.pending))
					if (reply.generation === binding.generation) delete draft.pending[id];
			}, ctx);
			const finish = async () => {
				await locks.set({ session, lock: null }, ctx);
				await state.change((draft) => {
					if (draft.bindings[binding.channelId]?.generation === binding.generation)
						delete draft.bindings[binding.channelId];
				}, ctx);
			};
			// Catalog archival precedes shutdown. Sessions keeps restore excluded through publication.
			if (await archivedChanges().whileArchived(session, finish, ctx)) return;
			if (catalog.sessions.value.some((entry) => entry.id === session))
				await ingress(session, (worker, scope) => worker.unlinked({ generation: binding.generation }, scope), ctx);
			await finish();
		};
		return {
			bots: followNative(
				self,
				(changed) => fleet.value.subscribe(changed),
				() => fleet.value.views(),
			),
			bindings: deriveTyped(self, [state], ([value]) =>
				Object.values(value.bindings)
					.sort((a, b) => a.createdAt - b.createdAt)
					.map(({ generation: _generation, phase: _phase, ...binding }) => binding),
			),
			addBot: async ({ token }) => ({ id: await fleet.value.add(token) }),
			setBotToken: async ({ bot, token }) => {
				await fleet.value.setToken(bot, token);
				return null;
			},
			removeBot: async ({ bot }, ctx) => {
				for (const binding of Object.values(state.value.bindings))
					if (binding.botId === bot)
						await changeLink(binding.session, ctx, (scope) => unlink(binding.session, scope));
				await fleet.value.remove(bot);
				return null;
			},
			server: ({ bot, guild }) => connected(bot).server(guild),
			mcpServers: async () => {
				const text = await optionalText(join(dataDir(), "mcp.json"));
				return text ? mcpServerNames(text) : [];
			},
			link: ({ session, bot, guild, channel: channelId, wake, sandbox, lock }, caller) =>
				changeLink(session, caller, async (ctx) => {
					const bindings = Object.values(state.value.bindings);
					if (bindings.some((binding) => binding.session === session))
						throw new Error("This session is linked already: unlink it first");
					if (state.value.bindings[channelId]) throw new Error("This channel is linked to another session");
					const config = envs.configs.value[sandbox];
					if (config?.type !== "gondolin") throw new Error(`No sandbox ${sandbox}`);
					const row = catalog.sessions.value.find((entry) => entry.id === session);
					if (!row || row.archivedAt !== null) throw new Error("No such session");
					if (reservedChannels.has(channelId)) throw new Error("This channel is being linked to another session");
					reservedChannels.add(channelId);
					try {
						const channel = await connected(bot).channel(channelId);
						if (channel.thread || channel.guildId !== guild) throw new Error("Pick a channel of the server");
						const cwd = row.env === sandbox ? row.cwd : (config.mounts?.[0]?.guest ?? "/root");
						await moves().withPreparedMove(
							{ id: session, cwd, env: sandbox },
							{
								inspect: async (scope) => {
									const checker = await scope.get(DiscordConfinement, { session });
									return (await checker.check({ sandbox }, scope)).generation;
								},
								validate: () => {
									connected(bot);
									if (envs.configs.value[sandbox] !== config)
										throw new Error("The sandbox configuration changed");
									if (
										state.value.bindings[channelId] ||
										Object.values(state.value.bindings).some((binding) => binding.session === session)
									)
										throw new Error("The channel or session is linked already");
								},
								publish: async (scope) => {
									await locks.set({ session, lock }, scope);
									await state.change((draft) => {
										draft.bindings[channelId] = {
											generation: ++draft.nextGeneration,
											phase: "linked",
											botId: bot,
											channelId,
											channelName: channel.name,
											guildId: channel.guildId,
											guildName: channel.guildName,
											session,
											wake,
											cursor: channel.lastMessageId,
											threads: {},
											createdAt: Date.now(),
										};
									}, scope);
								},
							},
							ctx,
						);
						return null;
					} finally {
						reservedChannels.delete(channelId);
					}
				}),
			unlink: ({ session }, caller) =>
				changeLink(session, caller, async (ctx) => {
					await unlink(session, ctx);
					return null;
				}),
			updateLink: ({ session, wake, lock }, caller) =>
				changeLink(session, caller, async (ctx) => {
					if (
						!Object.values(state.value.bindings).some(
							(binding) => binding.session === session && binding.phase === "linked",
						)
					)
						throw new Error("This session is not linked");
					// Both apply at once: who may wake Pi is read at each message, the lock is mirrored into the session.
					await locks.set({ session, lock }, ctx);
					await state.change((draft) => {
						for (const binding of Object.values(draft.bindings))
							if (binding.session === session) binding.wake = wake;
					}, ctx);
					return null;
				}),
		};
	});

	host.serve(
		Discord,
		(_params, principal, self) => {
			if (!isOwner(principal)) throw forbidden("Discord is the owner's");
			const store = self.get(DiscordStore, {});
			return {
				variant: "owner",
				members: {
					bots: store.bots,
					bindings: store.bindings,
					addBot: (args, ctx) => store.addBot(args, ctx),
					setBotToken: (args, ctx) => store.setBotToken(args, ctx),
					removeBot: (args, ctx) => store.removeBot(args, ctx),
					server: (args, ctx) => store.server(args, ctx),
					mcpServers: (ctx) => store.mcpServers(ctx),
					link: (args, ctx) => store.link(args, ctx),
					unlink: (args, ctx) => store.unlink(args, ctx),
					updateLink: (args, ctx) => store.updateLink(args, ctx),
				},
			};
		},
		{ accepts: DISCORD_ACCEPTS },
	);
});

/** A Discord avatar (an image of Discord's CDN, a trust boundary: only images pass). */
async function fetchAvatar(url: string): Promise<{ type: string; bytes: Buffer }> {
	if (!url.startsWith("https://cdn.discordapp.com/")) throw new Error("Not a Discord avatar");
	const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	const type = response.headers.get("content-type") ?? "";
	if (!response.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) throw new Error("No avatar");
	return { type, bytes: Buffer.from(await response.arrayBuffer()) };
}

/** `Discord` 2 (pages loaded before `updateLink`): the same state and methods, without it. */
const DISCORD_ACCEPTS: AcceptsTable<typeof Discord> = { 2: {} };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The server names of `mcp.json` (a trust boundary: the owner's file; the MCP plugin reports what is wrong in it). */
function mcpServerNames(text: string): string[] {
	try {
		const value: unknown = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, "")));
		const servers = value && typeof value === "object" && "mcpServers" in value ? value.mcpServers : undefined;
		return servers && typeof servers === "object" ? Object.keys(servers).sort() : [];
	} catch {
		return [];
	}
}
