// Pi on Discord: the relay between channels and sessions with a fake Discord and a fake session (who may wake Pi,
// batches since the cursor, threads, pending replies split at 2000 characters, refusals), and a session's
// `DiscordIngress` with the fake provider (a batch with an attachment downloaded into the session's uploads, its turn's
// answer, a thread's subagent forked from the main conversation).
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@p2/app/v1";
import { Chat, ChatCosts } from "../../plugins/chat/contract.ts";
import type { RelayBinding as Binding } from "../../plugins/discord/contract.ts";
import { DISCORD_BATCH, Discord, DiscordIngress, DiscordV2 } from "../../plugins/discord/contract.ts";
import {
	batchOf,
	chunkText,
	type DiscordChannel,
	type DiscordMessage,
	type DiscordPort,
	PENDING_TIMEOUT_MS,
	Relay,
	type RelayState,
	type SessionPort,
	type TurnState,
} from "../../plugins/discord/relay.ts";
import { FileSummaries } from "../../plugins/files/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { WorkerControl } from "../../plugins/status/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import type { Held } from "../../src/runtime/chord.ts";
import { type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";

const BOT = "999";

let serial = 100;
function message(text: string, options: Partial<DiscordMessage> = {}): DiscordMessage {
	serial++;
	return {
		id: String(serial),
		channelId: "c1",
		author: { id: "u1", name: "Ada", bot: false },
		roles: [],
		text,
		mentionsBot: text.includes(`<@${BOT}>`),
		attachments: [],
		...options,
	};
}

/** A fake Discord: channels with their messages, and what the bot posted. */
class FakeDiscord implements DiscordPort {
	readonly botId = BOT;
	readonly channels = new Map<string, DiscordChannel>();
	readonly history = new Map<string, DiscordMessage[]>();
	readonly posted: { channel: string; replyTo: string | undefined; text: string; files?: string[] }[] = [];
	/** Bytes attached to posts, by file name. */
	readonly uploaded = new Map<string, Uint8Array>();
	/** The server's per-message upload limit. */
	limit = 10 * 1024 * 1024;
	readonly typed: string[] = [];
	add(channel: DiscordChannel): void {
		this.channels.set(channel.id, channel);
		this.history.set(channel.id, []);
	}
	say(channel: string, entry: DiscordMessage): DiscordMessage {
		this.history.get(channel)?.push({ ...entry, channelId: channel });
		return { ...entry, channelId: channel };
	}
	async channel(id: string): Promise<DiscordChannel> {
		const found = this.channels.get(id);
		if (!found) throw new Error(`No channel ${id}`);
		return found;
	}
	/** History requests, as Discord gets them. */
	readonly requests: { channel: string; after: string }[] = [];
	/** Typing and history reads in order, as `typing:<channel>` and `messages:<channel>`. */
	readonly events: string[] = [];
	async messages(channelId: string, query: { after: string; limit: number }): Promise<DiscordMessage[]> {
		this.requests.push({ channel: channelId, after: query.after });
		this.events.push(`messages:${channelId}`);
		const all = this.history.get(channelId) ?? [];
		return all.filter((entry) => BigInt(entry.id) > BigInt(query.after)).slice(0, Math.min(query.limit, 100));
	}
	async reply(
		channel: string,
		replyTo: string | undefined,
		text: string,
		files: readonly { name: string; data: Uint8Array }[] = [],
	): Promise<void> {
		assert(text.length <= 2000);
		assert(text || files.length, "never an empty message");
		assert(files.length <= 10 && files.reduce((sum, file) => sum + file.data.length, 0) <= this.limit);
		for (const file of files) this.uploaded.set(file.name, file.data);
		this.posted.push({ channel, replyTo, text, ...(files.length ? { files: files.map((file) => file.name) } : {}) });
	}
	async uploadLimit(): Promise<number> {
		return this.limit;
	}
	async typing(channel: string): Promise<void> {
		this.typed.push(channel);
		this.events.push(`typing:${channel}`);
	}
}

/** A fake session: what it was handed, and the turns' states the test sets. */
class FakeSessions implements SessionPort {
	refusal: string | undefined;
	readonly delivered: Parameters<SessionPort["deliver"]>[1][] = [];
	readonly turns = new Map<number, TurnState>();
	readonly threads: { name: string; before: number }[] = [];
	/** The offered files' bytes by ID; reads count. */
	readonly bytes = new Map<string, Uint8Array>();
	reads = 0;
	async read(_session: string, id: string, offset: number, length: number): Promise<Uint8Array> {
		this.reads++;
		return (this.bytes.get(id) ?? new Uint8Array()).subarray(offset, offset + length);
	}
	/** How long placing an input and forking a thread take (ms): a slow worker. */
	slow = 0;
	async usable(): Promise<string | undefined> {
		return this.refusal;
	}
	async deliver(_session: string, input: Parameters<SessionPort["deliver"]>[1]) {
		await new Promise((resolve) => setTimeout(resolve, this.slow));
		this.delivered.push(input);
		this.running.add(input.conversation ?? 1);
		const submissionId = this.delivered.length;
		this.turns.set(submissionId, { state: "pending" });
		return { conversation: input.conversation ?? 1, submissionId };
	}
	async turn(_session: string, submissionId: number): Promise<TurnState> {
		return this.turns.get(submissionId) ?? { state: "unanswered", reason: "gone", files: [] };
	}
	/** Conversations with a turn under way, and the commands run. */
	readonly running = new Set<number>();
	readonly commands: { conversation?: number; command: string }[] = [];
	/** The fake's `stop`: the conversation's pending turns end stopped. */
	async command(_session: string, input: { conversation?: number; command: string }) {
		this.commands.push({
			command: input.command,
			...(input.conversation === undefined ? {} : { conversation: input.conversation }),
		});
		const conversation = input.conversation ?? 1;
		if (input.command !== "stop") return { text: `${input.command} of ${conversation}` };
		if (!this.running.delete(conversation)) return { text: "Nothing is running." };
		this.delivered.forEach((delivered, index) => {
			if ((delivered.conversation ?? 1) === conversation && this.turns.get(index + 1)?.state === "pending")
				this.turns.set(index + 1, { state: "stopped" });
		});
		return { text: "Stopped." };
	}
	async thread(_session: string, name: string, before: number) {
		await new Promise((resolve) => setTimeout(resolve, this.slow));
		this.threads.push({ name, before });
		return { conversation: 40 + this.threads.length };
	}
}

function binding(patch: Partial<Binding> = {}): Binding {
	return {
		generation: 1,
		phase: "linked",
		botId: "bot-a",
		channelId: "c1",
		channelName: "general",
		guildId: "g1",
		guildName: "Guild",
		session: "s1",
		wake: { anyone: false, users: ["u1"], roles: ["r1"] },
		cursor: null,
		threads: {},
		createdAt: 1,
		...patch,
	};
}

function setup(initial: Binding = binding()) {
	const discord = new FakeDiscord();
	discord.add({ id: "c1", name: "general", guildId: "g1", guildName: "Guild", lastMessageId: null });
	discord.add({
		id: "t1",
		name: "Release plan",
		guildId: "g1",
		guildName: "Guild",
		thread: { parentId: "c1", createdAt: 5_000, createdId: "0" },
		lastMessageId: null,
	});
	const sessions = new FakeSessions();
	let state: RelayState = { bindings: { [initial.channelId]: initial }, pending: {} };
	// Bot "bot-a" is the link's; "bot-b" another bot in the same server; `offline` bots are not connected.
	const offline = new Set<string>();
	const relay = new Relay((bot) => (offline.has(bot) ? undefined : discord), sessions, {
		value: () => state,
		change: async (update) => {
			const draft = structuredClone(state);
			update(draft);
			state = draft;
		},
	});
	return { discord, sessions, relay, offline, state: () => state };
}

describe("discord relay", () => {
	for (const phase of ["usable", "history", "thread"] as const) {
		it(`security:discord-unlink-leaves-relay-authorized: unlink during ${phase} refuses old delivery`, async (t) => {
			const { discord, sessions, relay, state } = setup();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const pause = async () => {
				entered.resolve();
				await release.promise;
			};
			if (phase === "usable")
				t.mock.method(sessions, "usable", async () => {
					await pause();
					return undefined;
				});
			else if (phase === "history") {
				const original = discord.messages.bind(discord);
				t.mock.method(discord, "messages", async (...args: Parameters<FakeDiscord["messages"]>) => {
					await pause();
					return original(...args);
				});
			} else {
				const original = sessions.thread.bind(sessions);
				t.mock.method(sessions, "thread", async (...args: Parameters<FakeSessions["thread"]>) => {
					await pause();
					return original(...args);
				});
			}
			const sending = relay.onMessage(
				"bot-a",
				discord.say(phase === "thread" ? "t1" : "c1", message(`<@${BOT}> held`)),
			);
			await entered.promise;
			delete state().bindings.c1;
			release.resolve();
			await sending;
			assert.equal(sessions.delivered.length, 0);
			assert.deepEqual(state().pending, {});
			assert.deepEqual(discord.posted, []);
		});
	}

	it("security:discord-unlink-leaves-relay-authorized: thread lookup cannot inherit a relink", async (t) => {
		const { discord, sessions, relay, state } = setup();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = discord.channel.bind(discord);
		t.mock.method(discord, "channel", async (id: string) => {
			entered.resolve();
			await release.promise;
			return original(id);
		});
		const sending = relay.onMessage("bot-a", discord.say("t1", message(`<@${BOT}> held lookup`)));
		await entered.promise;
		// Like a committed State snapshot, replace the map rather than mutating the captured one.
		state().bindings = { c1: binding({ generation: 2 }) };
		release.resolve();
		await sending;
		assert.equal(sessions.delivered.length, 0);
		assert.equal(sessions.threads.length, 0);
		assert.deepEqual(state().pending, {});
		await relay.onMessage("bot-a", discord.say("t1", message(`<@${BOT}> fresh lookup`)));
		assert.equal(sessions.delivered.length, 1);
	});

	it("security:discord-unlink-leaves-relay-authorized: queued mentions cannot inherit a relink", async (t) => {
		const { discord, sessions, relay, state } = setup();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = discord.messages.bind(discord);
		let calls = 0;
		t.mock.method(discord, "messages", async (...args: Parameters<FakeDiscord["messages"]>) => {
			if (++calls === 1) {
				entered.resolve();
				await release.promise;
			}
			return original(...args);
		});
		const first = relay.onMessage("bot-a", discord.say("c1", message(`<@${BOT}> held`)));
		await entered.promise;
		const second = relay.onMessage("bot-a", discord.say("c1", message(`<@${BOT}> queued`)));
		const replacement = { ...binding({ createdAt: 2 }), generation: 3 };
		state().bindings.c1 = replacement;
		release.resolve();
		await Promise.all([first, second]);
		assert.equal(sessions.delivered.length, 0);
		assert.equal(state().bindings.c1?.cursor, null);
		assert.deepEqual(state().pending, {});
		await relay.onMessage("bot-a", discord.say("c1", message(`<@${BOT}> fresh`)));
		assert.equal(sessions.delivered.length, 1, "the new link still works");
	});

	it("security:discord-unlink-leaves-relay-authorized: catch-up cannot inherit a relink after history", async (t) => {
		const { discord, sessions, relay, state } = setup();
		discord.say("c1", message(`<@${BOT}> missed`));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = discord.messages.bind(discord);
		t.mock.method(discord, "messages", async (...args: Parameters<FakeDiscord["messages"]>) => {
			entered.resolve();
			await release.promise;
			return original(...args);
		});
		const catching = relay.catchUp("bot-a");
		await entered.promise;
		const replacement = { ...binding({ createdAt: 2 }), generation: 3 };
		state().bindings.c1 = replacement;
		release.resolve();
		await catching;
		assert.equal(sessions.delivered.length, 0);
		assert.deepEqual(state().pending, {});
	});

	it("security:discord-unlink-leaves-relay-authorized: orphaned persisted replies cannot post after restart", async () => {
		const { discord, sessions, relay, state } = setup();
		await relay.onMessage("bot-a", discord.say("c1", message(`<@${BOT}> first`)));
		sessions.turns.set(1, { state: "answered", text: "private answer", files: [], answer: 91 });
		delete state().bindings.c1;
		const restarted = new Relay(() => discord, sessions, { value: state, change: async (update) => update(state()) });
		const typed = discord.typed.length;
		await restarted.typing();
		await restarted.checkPending();
		assert.deepEqual(discord.posted, []);
		assert.equal(discord.typed.length, typed);
		assert.deepEqual(state().pending, {});
	});

	for (const phase of ["turn", "file", "part"] as const) {
		it(`security:discord-unlink-leaves-relay-authorized: unlink during ${phase} prevents further reply parts`, async (t) => {
			const { discord, sessions, relay, state } = setup();
			await relay.onMessage("bot-a", discord.say("c1", message(`<@${BOT}> first`)));
			sessions.bytes.set("file", new Uint8Array(4));
			sessions.turns.set(1, {
				state: "answered",
				text: phase === "part" ? "word ".repeat(600) : "answer",
				files: phase === "file" ? [{ id: "file", name: "file", size: 4 }] : [],
				answer: 92,
			});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const pause = async () => {
				entered.resolve();
				await release.promise;
			};
			if (phase === "turn") {
				const original = sessions.turn.bind(sessions);
				t.mock.method(sessions, "turn", async (...args: Parameters<FakeSessions["turn"]>) => {
					await pause();
					return original(...args);
				});
			} else if (phase === "file") {
				const original = sessions.read.bind(sessions);
				t.mock.method(sessions, "read", async (...args: Parameters<FakeSessions["read"]>) => {
					await pause();
					return original(...args);
				});
			} else {
				const original = discord.reply.bind(discord);
				t.mock.method(discord, "reply", async (...args: Parameters<FakeDiscord["reply"]>) => {
					await original(...args);
					await pause();
				});
			}
			const posting = relay.checkPending();
			await entered.promise;
			delete state().bindings.c1;
			state().pending = {};
			release.resolve();
			await posting;
			assert.equal(
				discord.posted.length,
				phase === "part" ? 1 : 0,
				"an already-issued part cannot be recalled; no later part starts",
			);
		});
	}

	for (const phase of ["usable", "command"] as const) {
		it(`security:discord-unlink-leaves-relay-authorized: unlink during command ${phase} fences its output`, async (t) => {
			const { discord, sessions, relay, state } = setup();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			if (phase === "usable")
				t.mock.method(sessions, "usable", async () => {
					entered.resolve();
					await release.promise;
					return undefined;
				});
			else {
				const original = sessions.command.bind(sessions);
				t.mock.method(sessions, "command", async (...args: Parameters<FakeSessions["command"]>) => {
					entered.resolve();
					await release.promise;
					return original(...args);
				});
			}
			const commanding = relay.onMessage("bot-a", discord.say("c1", message(`<@${BOT}> stop`)));
			await entered.promise;
			delete state().bindings.c1;
			release.resolve();
			await commanding;
			assert.deepEqual(discord.posted, []);
			if (phase === "usable") assert.deepEqual(sessions.commands, []);
		});
	}

	it("delivers the messages since the cursor when someone allowed mentions Pi; others are ignored", async () => {
		const { discord, sessions, relay, state } = setup();
		discord.say("c1", message("before the bot"));
		const stranger = discord.say("c1", message(`<@${BOT}> hi`, { author: { id: "u2", name: "Eve", bot: false } }));
		await relay.onMessage("bot-a", stranger);
		assert.equal(sessions.delivered.length, 0, "u2 may not wake Pi");
		// Another bot is a person to the link: not allowed to wake Pi here, its message is in the batch.
		const bot = discord.say(
			"c1",
			message(`<@${BOT}> I am a bot`, { author: { id: "b7", name: "Helper", bot: true } }),
		);
		await relay.onMessage("bot-a", bot);
		assert.equal(sessions.delivered.length, 0, "b7 may not wake Pi");
		// The link's own bot (an earlier reply) is never in a batch.
		discord.say("c1", message("my earlier answer", { author: { id: BOT, name: "Pi", bot: true } }));
		const byRole = discord.say(
			"c1",
			message(`<@${BOT}> what do you think?`, { author: { id: "u3", name: "Bo", bot: false }, roles: ["r1"] }),
		);
		await relay.onMessage("bot-a", byRole);
		assert.equal(sessions.delivered.length, 1);
		const input = sessions.delivered[0];
		assert(input);
		assert.equal(input.requestId, `discord:${byRole.id}`);
		assert.deepEqual(input.author, { id: "u3", name: "Bo" });
		// No cursor yet: from the channel's start; each author with their mention, bots marked, the bot's own left out.
		assert.deepEqual(input.text.split("\n"), [
			"[Discord #general (Guild): 4 messages since the last delivery]",
			"Ada (<@u1>): before the bot",
			"Eve (<@u2>): @Pi hi",
			"Helper (bot, <@b7>): @Pi I am a bot",
			"Bo (<@u3>): @Pi what do you think?",
		]);
		assert.equal(state().bindings.c1?.cursor, byRole.id);
		assert.equal(state().pending[byRole.id]?.submissionId, 1);
		assert.deepEqual(discord.typed, ["c1"]);
		// The next batch starts after the cursor.
		const next = discord.say("c1", message(`<@${BOT}> and now?`));
		await relay.onMessage("bot-a", next);
		assert.deepEqual(sessions.delivered[1]?.text.split("\n").slice(1), ["Ada (<@u1>): @Pi and now?"]);
	});

	it("another bot is a person: it wakes Pi by the link's rules; the link's own bot never does", async () => {
		const { discord, sessions, relay } = setup(
			binding({ cursor: "1", wake: { anyone: false, users: ["b7"], roles: [] } }),
		);
		const own = discord.say(
			"c1",
			message(`<@${BOT}> talking to myself`, { author: { id: BOT, name: "Pi", bot: true } }),
		);
		await relay.onMessage("bot-a", own);
		assert.equal(sessions.delivered.length, 0, "never its own message");
		const helper = discord.say(
			"c1",
			message(`<@${BOT}> build done`, { author: { id: "b7", name: "Helper", bot: true } }),
		);
		await relay.onMessage("bot-a", helper);
		assert.deepEqual(sessions.delivered[0]?.author, { id: "b7", name: "Helper" });
		assert.deepEqual(sessions.delivered[0]?.text.split("\n").slice(1), ["Helper (bot, <@b7>): @Pi build done"]);
	});

	it("loop guard: at most 3 bot-started turns in a row per channel; one notice; a person's message resets it", async () => {
		const { discord, sessions, relay } = setup(
			binding({ cursor: "1", wake: { anyone: true, users: [], roles: [] } }),
		);
		const fromBot = (text: string) =>
			discord.say("c1", message(`<@${BOT}> ${text}`, { author: { id: "b7", name: "Helper", bot: true } }));
		for (const text of ["one", "two", "three", "four", "five"]) await relay.onMessage("bot-a", fromBot(text));
		assert.equal(sessions.delivered.length, 3);
		assert.deepEqual(
			discord.posted.map((post) => post.text),
			["Not answering more bots here until a person writes (3 bot turns in a row)."],
			"one notice, at the first refused",
		);
		// A thread is counted on its own.
		discord.add({
			id: "t9",
			name: "Side",
			guildId: "g1",
			guildName: "Guild",
			thread: { parentId: "c1", createdAt: 7_000, createdId: "0" },
			lastMessageId: null,
		});
		await relay.onMessage(
			"bot-a",
			discord.say("t9", message(`<@${BOT}> in a thread`, { author: { id: "b7", name: "Helper", bot: true } })),
		);
		assert.equal(sessions.delivered.length, 4);
		// A person writes (no mention needed): bots may start turns again.
		await relay.onMessage("bot-a", discord.say("c1", message("ok, carry on")));
		await relay.onMessage("bot-a", fromBot("six"));
		assert.equal(sessions.delivered.length, 5);
		assert.deepEqual(sessions.delivered[4]?.text.split("\n").slice(-2), [
			"Ada (<@u1>): ok, carry on",
			"Helper (bot, <@b7>): @Pi six",
		]);
	});

	it("inputs steered into one turn: its answer is posted once, to the newest mention, with the whole turn's files", async () => {
		const { discord, sessions, relay, state } = setup(binding({ cursor: "1" }));
		const first = discord.say("c1", message(`<@${BOT}> start`));
		await relay.onMessage("bot-a", first);
		const second = discord.say("c1", message(`<@${BOT}> also this`));
		await relay.onMessage("bot-a", second);
		sessions.bytes.set("plan", new TextEncoder().encode("plan"));
		// The turn's answer settles both inputs; the steered one's span starts later and misses the earlier file.
		const files = [{ id: "plan", name: "plan.md", size: 4 }];
		sessions.turns.set(1, { state: "answered", text: "Both done.", files, answer: 77 });
		sessions.turns.set(2, { state: "answered", text: "Both done.", files: [], answer: 77 });
		await relay.checkPending();
		assert.deepEqual(discord.posted, [{ channel: "c1", replyTo: second.id, text: "Both done.", files: ["plan.md"] }]);
		assert.deepEqual(state().pending, {});
		// Settled apart (the older input checked after the newer one was posted): still one post.
		const third = discord.say("c1", message(`<@${BOT}> next`));
		await relay.onMessage("bot-a", third);
		const fourth = discord.say("c1", message(`<@${BOT}> and that`));
		await relay.onMessage("bot-a", fourth);
		sessions.turns.set(4, { state: "answered", text: "Later.", files: [], answer: 88 });
		await relay.checkPending();
		sessions.turns.set(3, { state: "answered", text: "Later.", files: [], answer: 88 });
		await relay.checkPending();
		assert.deepEqual(
			discord.posted.slice(1).map((post) => [post.replyTo, post.text]),
			[[fourth.id, "Later."]],
		);
		assert.deepEqual(state().pending, {});
	});

	it("posts the answer once its turn ended, as a reply split at 2000 characters", async () => {
		const { discord, sessions, relay, state } = setup();
		const trigger = discord.say("c1", message(`<@${BOT}> long answer please`));
		await relay.onMessage("bot-a", trigger);
		await relay.checkPending();
		assert.equal(discord.posted.length, 0, "still pending");
		const answer = `${"word ".repeat(500)}\n${"more ".repeat(300)}`;
		sessions.turns.set(1, { state: "answered", text: answer, files: [], answer: 1000 + 1 });
		await Promise.all([relay.checkPending(), relay.checkPending(new Set(["s1"]))]);
		assert(discord.posted.length >= 2, "split");
		assert.equal(discord.posted[0]?.replyTo, trigger.id, "the first part replies to the message that woke Pi");
		assert(discord.posted.slice(1).every((post) => post.replyTo === undefined));
		assert.equal(
			discord.posted
				.map((post) => post.text)
				.join(" ")
				.replace(/\s+/g, " "),
			answer.trim().replace(/\s+/g, " "),
		);
		assert.deepEqual(state().pending, {});
		// Posted once although two checks ran at once.
		const count = discord.posted.length;
		await relay.checkPending();
		assert.equal(discord.posted.length, count);
	});

	it("says why when a turn ends without an answer, or never ends", async () => {
		const { discord, sessions, relay, state } = setup();
		await relay.onMessage("bot-a", discord.say("c1", message(`<@${BOT}> one`)));
		sessions.turns.set(1, { state: "unanswered", reason: "The model failed.", files: [] });
		await relay.checkPending();
		assert.equal(discord.posted.at(-1)?.text, "(No answer: The model failed.)");
		const trigger = discord.say("c1", message(`<@${BOT}> two`));
		await relay.onMessage("bot-a", trigger);
		const pending = state().pending[trigger.id];
		assert(pending);
		pending.since -= PENDING_TIMEOUT_MS + 1;
		await relay.checkPending();
		assert.match(discord.posted.at(-1)?.text ?? "", /did not answer in time/);
	});

	it("refuses with a notice when the session cannot take input; the cursor stays", async () => {
		const { discord, sessions, relay, state } = setup();
		sessions.refusal = "its p2 session does not work in a sandbox.";
		const trigger = discord.say("c1", message(`<@${BOT}> hello`));
		await relay.onMessage("bot-a", trigger);
		assert.equal(sessions.delivered.length, 0);
		assert.match(
			discord.posted[0]?.text ?? "",
			/not listening here right now: its p2 session does not work in a sandbox/,
		);
		assert.equal(state().bindings.c1?.cursor, null);
	});

	it("gives a thread its own subagent at the first mention, with its own cursor; replies go to the thread", async () => {
		const { discord, sessions, relay, state } = setup(binding({ cursor: "1" }));
		discord.say("t1", message("thread opener"));
		const first = discord.say("t1", message(`<@${BOT}> plan it`));
		await relay.onMessage("bot-a", first);
		assert.deepEqual(sessions.threads, [{ name: "Release plan", before: 5_000 }]);
		assert.equal(sessions.delivered[0]?.conversation, 41);
		assert.equal(sessions.delivered[0]?.context.thread, "Release plan");
		assert.deepEqual(sessions.delivered[0]?.text.split("\n"), [
			'[Discord thread "Release plan" in #general (Guild), its first delivery: 2 messages of the thread]',
			"Ada (<@u1>): thread opener",
			"Ada (<@u1>): @Pi plan it",
		]);
		assert.deepEqual(state().bindings.c1?.threads.t1, { conversation: 41, name: "Release plan", cursor: first.id });
		assert.equal(state().bindings.c1?.cursor, "1", "the channel's cursor is the channel's own");
		const second = discord.say("t1", message(`<@${BOT}> next step`));
		await relay.onMessage("bot-a", second);
		assert.equal(sessions.threads.length, 1, "one subagent per thread");
		assert.equal(sessions.delivered[1]?.conversation, 41);
		sessions.turns.set(1, { state: "answered", text: "Plan.", files: [], answer: 1000 + 1 });
		await relay.checkPending();
		assert.deepEqual(discord.posted[0], { channel: "t1", replyTo: first.id, text: "Plan." });
	});

	it("listens only through the link's own bot; a reply waits while its bot is not connected", async () => {
		const { discord, sessions, relay, offline, state } = setup();
		const other = discord.say("c1", message(`<@${BOT}> hello`));
		await relay.onMessage("bot-b", other);
		assert.equal(sessions.delivered.length, 0, "another bot's mention");
		const trigger = discord.say("c1", message(`<@${BOT}> hello again`));
		await relay.onMessage("bot-a", trigger);
		assert.equal(state().pending[trigger.id]?.botId, "bot-a");
		sessions.turns.set(1, { state: "answered", text: "Hi.", files: [], answer: 1000 + 1 });
		offline.add("bot-a");
		await relay.checkPending();
		assert.equal(discord.posted.length, 0);
		assert(state().pending[trigger.id], "kept for later");
		offline.delete("bot-a");
		await relay.checkPending();
		assert.deepEqual(discord.posted, [{ channel: "c1", replyTo: trigger.id, text: "Hi." }]);
	});

	it("delivers one batch at a time per channel and thread: near-simultaneous mentions never overlap", async () => {
		const { discord, sessions, relay, state } = setup(binding({ cursor: "1" }));
		sessions.slow = 20;
		discord.say("c1", message("one"));
		const first = discord.say("c1", message(`<@${BOT}> first`));
		discord.say("c1", message("two"));
		const second = discord.say("c1", message(`<@${BOT}> second`));
		// A new thread: its two mentions must not fork two subagents either.
		const a = discord.say("t1", message(`<@${BOT}> a`));
		const b = discord.say("t1", message(`<@${BOT}> b`));
		sessions.running.clear();
		await Promise.all([
			relay.onMessage("bot-a", first),
			relay.onMessage("bot-a", second),
			relay.onMessage("bot-a", a),
			relay.onMessage("bot-a", b),
		]);
		const batches = (thread: boolean) =>
			sessions.delivered
				.filter((input) => (input.context.thread !== undefined) === thread)
				.map((input) => input.text.split("\n").slice(1));
		// The second starts at the cursor the first left: no message is in both.
		assert.deepEqual(batches(false), [
			["Ada (<@u1>): one", "Ada (<@u1>): @Pi first"],
			["Ada (<@u1>): two", "Ada (<@u1>): @Pi second"],
		]);
		assert.deepEqual(batches(true), [["Ada (<@u1>): @Pi a"], ["Ada (<@u1>): @Pi b"]]);
		assert.equal(sessions.threads.length, 1, "one subagent for the thread");
		assert.equal(state().bindings.c1?.cursor, second.id);
		assert.equal(state().bindings.c1?.threads.t1?.cursor, b.id);
		assert.deepEqual(Object.keys(state().pending).sort(), [first.id, second.id, a.id, b.id].sort());
	});

	it("a thread's first batch: the channel's undelivered messages up to the thread, then the thread's; then its own cursor", async () => {
		const { discord, sessions, relay, state } = setup(binding({ cursor: "1" }));
		discord.say("c1", message("before the thread"));
		const starter = discord.say(
			"c1",
			message("shall we plan the release?", { author: { id: "u3", name: "Bo", bot: false } }),
		);
		// The thread is made from that message (its ID); the channel goes on meanwhile.
		const thread = discord.channels.get("t1");
		assert(thread?.thread);
		thread.thread.createdId = starter.id;
		discord.say("c1", message("unrelated, after the thread"));
		discord.say("t1", message("in the thread"));
		const first = discord.say("t1", message(`<@${BOT}> plan it`));
		await relay.onMessage("bot-a", first);
		assert.deepEqual(sessions.delivered[0]?.text.split("\n"), [
			'[Discord thread "Release plan" in #general (Guild), its first delivery: 2 messages of #general before the thread, then 2 messages of the thread]',
			"[#general, before the thread]",
			"Ada (<@u1>): before the thread",
			"Bo (<@u3>): shall we plan the release?",
			"[The thread]",
			"Ada (<@u1>): in the thread",
			"Ada (<@u1>): @Pi plan it",
		]);
		assert.equal(sessions.delivered[0]?.context.messages, 4);
		assert.equal(state().bindings.c1?.cursor, "1", "the channel's cursor stays: the main agent still gets these");
		assert.equal(state().bindings.c1?.threads.t1?.cursor, first.id);
		// Then only the thread, since its own cursor.
		discord.say("t1", message("more detail"));
		const second = discord.say("t1", message(`<@${BOT}> and now?`));
		await relay.onMessage("bot-a", second);
		assert.deepEqual(sessions.delivered[1]?.text.split("\n"), [
			'[Discord thread "Release plan" in #general (Guild): 2 messages since the last delivery]',
			"Ada (<@u1>): more detail",
			"Ada (<@u1>): @Pi and now?",
		]);
		// The main agent's next batch has every channel message since its cursor, the thread's start included.
		const main = discord.say("c1", message(`<@${BOT}> back here`));
		await relay.onMessage("bot-a", main);
		assert.deepEqual(sessions.delivered[2]?.text.split("\n").slice(1), [
			"Ada (<@u1>): before the thread",
			"Bo (<@u3>): shall we plan the release?",
			"Ada (<@u1>): unrelated, after the thread",
			"Ada (<@u1>): @Pi back here",
		]);
	});

	it("stop while a turn runs: answered at once, even behind a delivery; the stopped turn posts nothing", async () => {
		const { discord, sessions, relay, state } = setup(binding({ cursor: "1" }));
		const first = discord.say("c1", message(`<@${BOT}> long task`));
		await relay.onMessage("bot-a", first);
		// A second mention is being delivered (a slow worker) when the stop comes: the stop does not wait for it.
		sessions.slow = 50;
		const second = discord.say("c1", message(`<@${BOT}> and another`));
		const stop = discord.say(
			"c1",
			message(`<@${BOT}> /STOP`, { author: { id: "u3", name: "Bo", bot: false }, roles: ["r1"] }),
		);
		const delivering = relay.onMessage("bot-a", second);
		await relay.onMessage("bot-a", stop);
		assert.deepEqual(discord.posted, [{ channel: "c1", replyTo: stop.id, text: "Stopped." }], "before the delivery");
		assert.equal(sessions.delivered.length, 1);
		await delivering;
		assert.deepEqual(sessions.commands, [{ command: "stop" }]);
		assert.equal(sessions.turns.get(1)?.state, "stopped");
		await relay.checkPending(new Set(["s1"]));
		assert.deepEqual(Object.keys(state().pending), [second.id], "the stopped turn's reply is gone, unposted");
		assert.equal(discord.posted.length, 1);
		// The command is never delivered: the next batch has the messages around it, not it.
		const after = discord.say("c1", message(`<@${BOT}> next`));
		await relay.onMessage("bot-a", after);
		assert.deepEqual(sessions.delivered.at(-1)?.text.split("\n").slice(1), ["Ada (<@u1>): @Pi next"]);
		assert.deepEqual(sessions.delivered[1]?.text.split("\n").slice(1), ["Ada (<@u1>): @Pi and another"]);
	});

	it("stop with nothing running says so; status and compact go to the main conversation; strangers' commands are ignored", async () => {
		const { discord, sessions, relay } = setup();
		await relay.onMessage("bot-a", discord.say("c1", message(`<@${BOT}> stop`)));
		await relay.onMessage("bot-a", discord.say("c1", message(`<@${BOT}>   Status `)));
		await relay.onMessage("bot-a", discord.say("c1", message(`<@${BOT}> compact`)));
		await relay.onMessage(
			"bot-a",
			discord.say("c1", message(`<@${BOT}> stop`, { author: { id: "u9", name: "Eve", bot: false } })),
		);
		assert.deepEqual(
			discord.posted.map((post) => post.text),
			["Nothing is running.", "status of 1", "compact of 1"],
		);
		assert.equal(sessions.delivered.length, 0, "commands are not inputs");
		// Not a command: more than the word.
		await relay.onMessage("bot-a", discord.say("c1", message(`<@${BOT}> stop the build please`)));
		assert.equal(sessions.delivered.length, 1);
	});

	it("a command in a thread reaches the thread's subagent; a thread without one has nothing to stop", async () => {
		const known = { conversation: 41, name: "Release plan", cursor: "1" };
		const { discord, sessions, relay } = setup(binding({ cursor: "1", threads: { t1: known } }));
		discord.add({
			id: "t2",
			name: "New",
			guildId: "g1",
			guildName: "Guild",
			thread: { parentId: "c1", createdAt: 6_000, createdId: "0" },
			lastMessageId: null,
		});
		await relay.onMessage("bot-a", discord.say("t1", message(`<@${BOT}> do it`)));
		const stop = discord.say("t1", message(`<@${BOT}> stop`));
		await relay.onMessage("bot-a", stop);
		assert.deepEqual(sessions.commands, [{ conversation: 41, command: "stop" }]);
		assert.deepEqual(discord.posted, [{ channel: "t1", replyTo: stop.id, text: "Stopped." }]);
		assert.equal(sessions.turns.get(1)?.state, "stopped");
		const elsewhere = discord.say("t2", message(`<@${BOT}> stop`));
		await relay.onMessage("bot-a", elsewhere);
		assert.deepEqual(discord.posted.at(-1), { channel: "t2", replyTo: elsewhere.id, text: "Nothing is running." });
		assert.equal(sessions.threads.length, 0, "a command forks no subagent");
	});

	it("a command missed while down is neither run nor a catch-up trigger", async () => {
		const { discord, sessions, relay } = setup(binding({ cursor: "1" }));
		discord.say("c1", message(`<@${BOT}> stop`));
		await relay.catchUp("bot-a");
		assert.equal(sessions.delivered.length, 0);
		assert.equal(sessions.commands.length, 0);
	});

	it("attaches the files a turn offered to its reply: within the server's limit, 10 a message, larger ones named", async () => {
		const { discord, sessions, relay } = setup();
		discord.limit = 1024;
		const file = (id: string, size: number) => {
			sessions.bytes.set(id, new Uint8Array(size).fill(id.length));
			return { id, name: `${id}.bin`, size };
		};
		const trigger = discord.say("c1", message(`<@${BOT}> build it`));
		await relay.onMessage("bot-a", trigger);
		const small = Array.from({ length: 11 }, (_, index) => file(`f${index}`, 10));
		const pair = [file("half-a", 600), file("half-b", 600)];
		sessions.turns.set(1, {
			state: "answered",
			text: "Built.",
			files: [...small, file("huge", 2048), ...pair],
			answer: 1001,
		});
		await relay.checkPending();
		assert.deepEqual(
			discord.posted.map((post) => ({ replyTo: post.replyTo, text: post.text, files: post.files })),
			[
				// The answer, its text naming what Discord cannot take, with the first 10 files.
				{
					replyTo: trigger.id,
					text: "Built.\n\nToo large for Discord: huge.bin (0.0 MiB)",
					files: small.slice(0, 10).map((each) => each.name),
				},
				// Then at most 10 a message, their sizes within the limit together.
				{ replyTo: undefined, text: "", files: ["f10.bin", "half-a.bin"] },
				{ replyTo: undefined, text: "", files: ["half-b.bin"] },
			],
		);
		assert.deepEqual(
			Buffer.from(discord.uploaded.get("half-a.bin") ?? []),
			Buffer.from(sessions.bytes.get("half-a") ?? []),
		);
		assert.equal(discord.uploaded.has("huge.bin"), false);
	});

	it("a turn with files and no text, in a thread, posts them as the reply there", async () => {
		const known = { conversation: 41, name: "Release plan", cursor: "1" };
		const { discord, sessions, relay } = setup(binding({ cursor: "1", threads: { t1: known } }));
		const trigger = discord.say("t1", message(`<@${BOT}> send the log`));
		await relay.onMessage("bot-a", trigger);
		sessions.bytes.set("log", new TextEncoder().encode("log line\n"));
		sessions.turns.set(1, {
			state: "answered",
			text: "",
			files: [{ id: "log", name: "build.log", size: 9 }],
			answer: 1000 + 1,
		});
		await relay.checkPending();
		assert.deepEqual(discord.posted, [{ channel: "t1", replyTo: trigger.id, text: "", files: ["build.log"] }]);
		assert.equal(new TextDecoder().decode(discord.uploaded.get("build.log")), "log line\n");
	});

	it("typing: at once, before the history is read; refreshed through a slow delivery and while the reply is pending; never after", async () => {
		const { discord, sessions, relay, state } = setup(binding({ cursor: "1" }));
		sessions.slow = 60;
		const trigger = discord.say("c1", message(`<@${BOT}> think hard`));
		const delivering = relay.onMessage("bot-a", trigger);
		// Sent before any page of history (and before the session is asked anything).
		assert.deepEqual(discord.events, ["typing:c1"]);
		// The 8 s tick during the delivery (the worker is slow) refreshes it.
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(sessions.delivered.length, 0, "still delivering");
		await relay.typing();
		assert.deepEqual(discord.events, ["typing:c1", "messages:c1", "typing:c1"]);
		await delivering;
		// Pending, queued or not (no tasks needed): still typing.
		await relay.typing();
		assert.equal(discord.typed.length, 3);
		// The reply is posted: no more typing.
		sessions.turns.set(1, { state: "answered", text: "Done.", files: [], answer: 1000 + 1 });
		await relay.checkPending();
		assert.deepEqual(Object.keys(state().pending), []);
		await relay.typing();
		assert.equal(discord.typed.length, 3);
		assert.equal(discord.posted.length, 1);
	});

	it("typing ends with a stopped turn and with a failed delivery; a command never types", async () => {
		const { discord, sessions, relay } = setup(binding({ cursor: "1" }));
		await relay.onMessage("bot-a", discord.say("c1", message(`<@${BOT}> long task`)));
		await relay.onMessage("bot-a", discord.say("c1", message(`<@${BOT}> stop`)));
		await relay.checkPending();
		const typed = discord.typed.length;
		await relay.typing();
		assert.equal(discord.typed.length, typed, "the stopped turn's typing is over");
		// A delivery the session refuses to take: typing while trying, none after.
		sessions.deliver = async () => {
			throw new Error("worker down");
		};
		await relay.onMessage("bot-a", discord.say("c1", message(`<@${BOT}> again`)));
		assert.match(discord.posted.at(-1)?.text ?? "", /Could not reach Pi: worker down/);
		const after = discord.typed.length;
		await relay.typing();
		assert.equal(discord.typed.length, after);
		// The command's own message typed nothing: typing came from the two deliveries only.
		assert.equal(discord.typed.filter((channel) => channel === "c1").length, after);
		assert.equal(after, 2);
	});

	it("pages through everything since the cursor up to the mention", async () => {
		const { discord, sessions, relay, state } = setup(binding({ cursor: "1" }));
		const said = Array.from({ length: 199 }, (_, index) => discord.say("c1", message(`line ${index}`)));
		const trigger = discord.say("c1", message(`<@${BOT}> summarize`));
		discord.say("c1", message("after the mention"));
		await relay.onMessage("bot-a", trigger);
		const lines = sessions.delivered[0]?.text.split("\n") ?? [];
		assert.equal(lines[0], "[Discord #general (Guild): 200 messages since the last delivery]");
		assert.equal(lines[1], "Ada (<@u1>): line 0", "message 1 of 200");
		assert.equal(lines[101], `Ada (<@u1>): ${said[100]?.text}`, "past the first page");
		assert.equal(lines.at(-1), "Ada (<@u1>): @Pi summarize");
		assert.equal(sessions.delivered[0]?.context.messages, 200);
		assert.deepEqual(
			discord.requests.map((request) => request.after),
			["1", said[99]?.id, trigger.id],
			"after the cursor, then after each full page, until past the mention",
		);
		assert.equal(state().bindings.c1?.cursor, trigger.id);
	});

	it("puts only the newest 200 into a huge batch and says how many earlier ones were left out", async () => {
		const { discord, sessions, relay } = setup(binding({ cursor: "1" }));
		for (let index = 0; index < 450; index++) discord.say("c1", message(`line ${index}`));
		await relay.onMessage("bot-a", discord.say("c1", message(`<@${BOT}> what happened?`)));
		const lines = sessions.delivered[0]?.text.split("\n") ?? [];
		assert.equal(
			lines[0],
			"[Discord #general (Guild): 451 messages since the last delivery; the 251 earliest are left out, the newest 200 follow]",
		);
		assert.equal(lines.length, 201);
		assert.equal(lines[1], "Ada (<@u1>): line 251");
		assert.equal(lines.at(-1), "Ada (<@u1>): @Pi what happened?");
	});

	it("catches up after downtime: one batch per link and thread, every message from the cursor to the newest allowed mention", async () => {
		const { discord, sessions, relay, state } = setup(binding({ cursor: "1" }));
		// Delivered before p2 went down: the cursor is this message.
		const delivered = discord.say("c1", message(`<@${BOT}> already answered`));
		const link = state().bindings.c1;
		assert(link);
		link.cursor = delivered.id;
		link.threads.t1 = { conversation: 41, name: "Release plan", cursor: "1" };
		// While p2 was down: chatter, a stranger's mention, two allowed mentions with chatter between, chatter after.
		discord.say("c1", message("good morning"));
		discord.say("c1", message(`<@${BOT}> me too`, { author: { id: "u9", name: "Eve", bot: false } }));
		discord.say("c1", message(`<@${BOT}> first question`));
		discord.say("c1", message("some context for it", { author: { id: "u3", name: "Bo", bot: false } }));
		const newest = discord.say("c1", message(`<@${BOT}> second question`));
		discord.say("c1", message("chatter after"));
		const inThread = discord.say("t1", message(`<@${BOT}> plan the release`));
		await relay.catchUp("bot-b");
		assert.equal(sessions.delivered.length, 0, "another bot's links are not its to catch up");
		await relay.catchUp("bot-a");
		assert.equal(sessions.delivered.length, 2, "one delivery per channel and thread");
		const channel = sessions.delivered[0];
		// The trigger is the newest missed mention; the batch is everything after the cursor up to it, the earlier
		// mentions and the messages without one included, the cursor's message and what came after the trigger not.
		assert.equal(channel?.requestId, `discord:${newest.id}`);
		assert.deepEqual(channel?.text.split("\n"), [
			"[Discord #general (Guild): 5 messages since the last delivery]",
			"Ada (<@u1>): good morning",
			"Eve (<@u9>): @Pi me too",
			"Ada (<@u1>): @Pi first question",
			"Bo (<@u3>): some context for it",
			"Ada (<@u1>): @Pi second question",
		]);
		assert.equal(state().bindings.c1?.cursor, newest.id);
		assert.equal(sessions.delivered[1]?.conversation, 41);
		assert.equal(sessions.delivered[1]?.requestId, `discord:${inThread.id}`);
		assert.equal(state().bindings.c1?.threads.t1?.cursor, inThread.id);
		assert.equal(sessions.threads.length, 0, "the thread's subagent exists already");
		// Again, and the same mention replayed by a resumed gateway: nothing new.
		await relay.catchUp("bot-a");
		await relay.onMessage("bot-a", newest);
		assert.equal(sessions.delivered.length, 2);
		// Answers go back to where each mention was.
		sessions.turns.set(1, { state: "answered", text: "Second answer.", files: [], answer: 1000 + 1 });
		sessions.turns.set(2, { state: "answered", text: "Plan.", files: [], answer: 1000 + 2 });
		await relay.checkPending();
		assert.deepEqual(discord.posted, [
			{ channel: "c1", replyTo: newest.id, text: "Second answer." },
			{ channel: "t1", replyTo: inThread.id, text: "Plan." },
		]);
	});

	it("downloads attachments up to 25 MiB (20 at most) and lists larger ones as links", () => {
		const big = 26 * 1024 * 1024;
		const batch = batchOf(
			[
				{
					messages: [
						message("see files", {
							id: "7",
							attachments: [
								{ name: "a.png", url: "https://cdn/a.png", size: 10 },
								{ name: "huge.zip", url: "https://cdn/huge.zip", size: big },
							],
						}),
					],
				},
			],
			BOT,
			"[h]",
		);
		assert.deepEqual(batch.files, [
			{ url: "https://cdn/a.png", name: "a.png", size: 10, key: "discord:7:0", ref: "7" },
		]);
		assert.equal(
			batch.text,
			`[h]\nAda (<@u1>): see files\n[attachment huge.zip (${big} bytes): https://cdn/huge.zip]`,
		);
	});

	it("splits text at line breaks, then spaces, then anywhere", () => {
		assert.deepEqual(chunkText("short"), ["short"]);
		assert.deepEqual(chunkText(`${"a".repeat(8)}\n${"b".repeat(8)}`, 10), ["a".repeat(8), "b".repeat(8)]);
		assert.deepEqual(chunkText("x".repeat(25), 10), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
	});
});

const texts = (view: ConversationView | null | undefined): string[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).flatMap((model) =>
			model.role === "assistant" ? model.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
		),
	);

/** The system sections in effect: the latest value of each, replayed from `pi.system` entries. */
function sections(view: ConversationView | null | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of view?.entries ?? [])
		for (const message of entry.model ?? []) {
			if (message.role !== "system" || !("sections" in message)) continue;
			for (const [key, value] of Object.entries(
				(message as { sections?: Record<string, string | null> }).sections ?? {},
			))
				if (value === null) delete result[key];
				else result[key] = value;
		}
	return result;
}

/** The turn of `submissionId` once it is no longer pending. */
async function ended(ingress: Held<typeof DiscordIngress>, submissionId: number): Promise<TurnState> {
	let turn: TurnState = { state: "pending" };
	await poll(async () => {
		turn = await ingress.turn({ submissionId }, BACKGROUND_CONTEXT);
		return turn.state !== "pending";
	});
	return turn;
}

it("reuse:discord-upload-chunk-writer: final-byte overruns are dropped, bounded files and retries survive", async (t) => {
	const limit = 25 * 1024 * 1024;
	const requests: string[] = [];
	let retry = false;
	const cdn = createServer((request, response) => {
		requests.push(request.url!);
		if (!retry && request.url === "/error") {
			response.writeHead(503).end();
			return;
		}
		if (!retry && request.url === "/broken") {
			response.writeHead(200, { "content-length": "2" });
			response.on("finish", () => request.socket.end());
			response.end(Buffer.alloc(1));
			return;
		}
		response.writeHead(200, { "content-type": "application/octet-stream" });
		const size =
			request.url === "/limit"
				? limit
				: request.url === "/empty"
					? 0
					: retry
						? 1
						: limit + (request.url === "/over-chunk" ? 1024 * 1024 : 1);
		response.end(Buffer.alloc(size));
	});
	await new Promise<void>((resolve) => cdn.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => cdn.close(() => resolve())));
	const url = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`;
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const owner = fixture.browser();
	const sessions = await holdIn(owner, Sessions, {}, "owner");
	const session = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
	const ingress = fixture.server.host.hold(DiscordIngress, { session }, BACKGROUND_CONTEXT);
	const mirror = await holdIn(owner, FileSummaries, {}, "owner");
	const file = (name: string, size: number) => ({
		url: `${url}/${name}`,
		name: `${name}.bin`,
		size,
		key: `discord:bounds:${name}`,
		ref: "bounds",
	});
	const input = {
		generation: 1,
		requestId: "discord:bounds",
		author: { id: "u1", name: "Ada" },
		text: "Check the attached files",
		context: { channel: "general", guild: "Guild", messages: 1 },
		files: [
			file("over", limit),
			file("over-chunk", limit),
			file("limit", limit),
			file("declared-over", limit + 1),
			file("error", 1),
			file("broken", 1),
			file("empty", 0),
		],
	};
	await ended(ingress, (await ingress.deliver(input, BACKGROUND_CONTEXT)).submissionId);
	const summary = (await mirror.of({ session }, BACKGROUND_CONTEXT)).uploads;
	assert.equal(summary?.bytes, limit, "the final extra byte must not publish an oversized upload");
	assert.deepEqual(summary?.newest.map((entry) => entry.key).sort(), ["discord:bounds:empty", "discord:bounds:limit"]);
	assert.deepEqual(
		requests,
		["/over", "/over-chunk", "/limit", "/error", "/broken", "/empty"],
		"declared oversize is never fetched",
	);
	// The cancelled key can be retried; an already finished key never downloads again.
	retry = true;
	await ended(
		ingress,
		(await ingress.deliver({ ...input, requestId: "discord:bounds:retry" }, BACKGROUND_CONTEXT)).submissionId,
	);
	assert.deepEqual(requests.slice(6), ["/over", "/over-chunk", "/error", "/broken"]);
	const retried = (await mirror.of({ session }, BACKGROUND_CONTEXT)).uploads;
	assert.equal(retried?.files, 6);
	assert.equal(retried?.bytes, limit + 4);
});

it("security:discord-unlink-leaves-relay-authorized: unlink cancels a worker download before submission", async (t) => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const cdn = createServer(async (_request, response) => {
		response.writeHead(200, { "content-type": "text/plain" });
		response.flushHeaders();
		entered.resolve();
		await release.promise;
		response.end("attachment");
	});
	await new Promise<void>((resolve) => cdn.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => cdn.close(() => resolve())));
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const owner = fixture.browser();
	const sessions = await holdIn(owner, Sessions, {}, "owner");
	const session = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
	const ingress = fixture.server.host.hold(DiscordIngress, { session }, BACKGROUND_CONTEXT);
	const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
	const sending = ingress.deliver(
		{
			generation: 1,
			requestId: "held-download",
			author: { id: "u1", name: "Ada" },
			text: "must not submit after unlink",
			context: { channel: "general", guild: "Guild", messages: 1 },
			files: [
				{
					url: `http://127.0.0.1:${(cdn.address() as AddressInfo).port}/file`,
					name: "held.txt",
					size: 10,
					key: "discord:held",
					ref: "held",
				},
			],
		},
		BACKGROUND_CONTEXT,
	);
	const settled = Promise.allSettled([sending]);
	await entered.promise;
	try {
		await ingress.unlinked({ generation: 1 }, withAbortSignal(AbortSignal.timeout(5_000), BACKGROUND_CONTEXT));
	} finally {
		release.resolve();
		await settled;
	}
	assert.equal((await settled)[0]!.status, "rejected", "revoked input must not become a submission");
	await chat.send({ text: "owner after unlink", requestId: "owner-after" }, BACKGROUND_CONTEXT);
	const view = await until(chat.view, (value) => texts(value).includes("Echo: owner after unlink"));
	assert.equal(
		view?.entries.some((entry) => entry.kind === DISCORD_BATCH),
		false,
	);
	assert.equal(sections(view).discord, undefined);
});

it("security:discord-unlink-leaves-relay-authorized: unlink preserves already-submitted work", async (t) => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const owner = fixture.browser();
	const sessions = await holdIn(owner, Sessions, {}, "owner");
	const session = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
	const ingress = fixture.server.host.hold(DiscordIngress, { session }, BACKGROUND_CONTEXT);
	const submitted = await ingress.deliver(
		{
			generation: 1,
			requestId: "already-submitted",
			author: { id: "u1", name: "Ada" },
			text: "slow-tool",
			context: { channel: "general", guild: "Guild", messages: 1 },
			files: [],
		},
		BACKGROUND_CONTEXT,
	);
	await poll(async () =>
		(await ingress.command({ generation: 1, command: "status" }, BACKGROUND_CONTEXT)).text.includes("Working: yes"),
	);
	await ingress.unlinked({ generation: 1 }, BACKGROUND_CONTEXT);
	assert.equal((await ended(ingress, submitted.submissionId)).state, "answered");
});

it("security:discord-unlink-leaves-relay-authorized: revoked grants stay revoked across worker restart and relink", async (t) => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const owner = fixture.browser();
	const sessions = await holdIn(owner, Sessions, {}, "owner");
	const session = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
	const ingress = fixture.server.host.hold(DiscordIngress, { session }, BACKGROUND_CONTEXT);
	const input = (generation: number, requestId: string) => ({
		generation,
		requestId,
		author: { id: "u1", name: "Ada" },
		text: "hello",
		context: { channel: "general", guild: "Guild", messages: 1 },
		files: [],
	});
	await ended(ingress, (await ingress.deliver(input(1, "first-link"), BACKGROUND_CONTEXT)).submissionId);
	await ingress.unlinked({ generation: 1 }, BACKGROUND_CONTEXT);
	const worker = await holdIn(owner, WorkerControl, { session }, "owner");
	await worker.restart(BACKGROUND_CONTEXT);
	await assert.rejects(ingress.deliver(input(1, "old-after-restart"), BACKGROUND_CONTEXT), /revoked/);
	await ended(ingress, (await ingress.deliver(input(2, "replacement-link"), BACKGROUND_CONTEXT)).submissionId);
	await ingress.unlinked({ generation: 1 }, BACKGROUND_CONTEXT);
	const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
	await chat.send({ text: "owner during replacement", requestId: "owner-replacement" }, BACKGROUND_CONTEXT);
	const view = await until(chat.view, (value) => texts(value).includes("Echo: owner during replacement"));
	assert.match(
		sections(view).discord ?? "",
		/Discord channel #general/,
		"late old revocation cannot clear the replacement prompt",
	);
	await assert.rejects(ingress.deliver(input(1, "old-after-relink"), BACKGROUND_CONTEXT), /revoked/);
	await ingress.unlinked({ generation: 2 }, BACKGROUND_CONTEXT);
	await assert.rejects(ingress.deliver(input(2, "revoked-replacement"), BACKGROUND_CONTEXT), /revoked/);
});

describe("discord ingress (fake provider)", () => {
	let generation = 1;
	let fixture: Fixture;
	let session: string;
	let cdn: ReturnType<typeof createServer>;
	let cdnUrl: string;
	before(async () => {
		cdn = createServer((request, response) => {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end(`file at ${request.url}`);
		});
		await new Promise<void>((resolve) => cdn.listen(0, "127.0.0.1", resolve));
		cdnUrl = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`;
		fixture = await startFixture();
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		session = (await sessions.create({ cwd: fixture.workspace, title: "Discord" }, BACKGROUND_CONTEXT)).id;
	});
	after(async () => {
		await fixture?.close();
		cdn?.close();
	});

	it("places a batch as the Discord author's input with its attachment, and reads the turn's answer", async () => {
		const ingress = fixture.server.host.hold(DiscordIngress, { session }, BACKGROUND_CONTEXT);
		const input = {
			generation,
			requestId: "discord:500",
			author: { id: "u1", name: "Ada" },
			text: "[Discord #general (Guild): 1 message since the last delivery]\nAda: @Pi read this",
			context: { channel: "general", guild: "Guild", messages: 1 },
			files: [{ url: `${cdnUrl}/notes.txt`, name: "notes.txt", size: 20, key: "discord:500:0", ref: "500" }],
		};
		const delivered = await ingress.deliver(input, BACKGROUND_CONTEXT);
		assert.equal(delivered.conversation, 1);
		// A retry is placed once.
		assert.equal((await ingress.deliver(input, BACKGROUND_CONTEXT)).submissionId, delivered.submissionId);
		const turn = await ended(ingress, delivered.submissionId);
		assert(turn.state === "answered" && turn.text.startsWith("Echo:"), JSON.stringify(turn));
		const chat = await holdIn(fixture.browser(), Chat, { session, conversation: 1 }, "participant");
		const view = await until(chat.view, (value) =>
			(value?.entries ?? []).some((entry) => entry.kind === DISCORD_BATCH),
		);
		const entry = view?.entries.find((candidate) => candidate.kind === DISCORD_BATCH);
		const data = entry?.data as { author: { kind: string; name: string }; attachments: { id: string }[] };
		assert.deepEqual(data.author, { kind: "guest", id: "discord:u1", name: "Ada · Discord" });
		assert.deepEqual(data.attachments, [{ id: "discord:500:0", name: "notes.txt" }]);
		const content = (entry?.model?.[0] as UserMessage).content;
		assert(Array.isArray(content));
		assert(content.some((part) => part.type === "text" && part.text.includes("<attachments>")));
		const mirror = await holdIn(fixture.browser(), FileSummaries, {}, "owner");
		const spaces = await mirror.of({ session }, BACKGROUND_CONTEXT);
		assert.equal(spaces.uploads?.newest[0]?.source, "discord");
	});

	it("a turn's answer lists the files its conversation offered during it, readable through the ingress", async () => {
		await writeFile(join(fixture.workspace, "created.txt"), "made for Discord\n");
		const ingress = fixture.server.host.hold(DiscordIngress, { session }, BACKGROUND_CONTEXT);
		const input = (requestId: string, text: string, conversation?: number) => ({
			generation,
			...(conversation === undefined ? {} : { conversation }),
			requestId,
			author: { id: "u1", name: "Ada" },
			text,
			context: { channel: "general", guild: "Guild", messages: 1 },
			files: [],
		});
		const sent = await ingress.deliver(input("discord:800", "send-file"), BACKGROUND_CONTEXT);
		const turn = await ended(ingress, sent.submissionId);
		assert(turn.state === "answered", JSON.stringify(turn));
		assert.deepEqual(
			turn.files.map((file) => ({ name: file.name, size: file.size })),
			[{ name: "created.txt", size: 17 }],
		);
		const [offered] = turn.files;
		assert(offered);
		const bytes = await ingress.read({ id: offered.id, offset: 0, length: 1024 }, BACKGROUND_CONTEXT);
		assert.equal(new TextDecoder().decode(bytes), "made for Discord\n");
		// The next turn offers nothing: an earlier turn's files are not its.
		const plain = await ingress.deliver(input("discord:801", "nothing to send"), BACKGROUND_CONTEXT);
		const next = await ended(ingress, plain.submissionId);
		assert(next.state === "answered" && next.files.length === 0, JSON.stringify(next));
		// A thread's subagent: its own turn's files only.
		const { conversation } = await ingress.thread(
			{ generation, name: "files", before: Date.now() },
			BACKGROUND_CONTEXT,
		);
		const inThread = await ingress.deliver(input("discord:802", "send-file", conversation), BACKGROUND_CONTEXT);
		const threadTurn = await ended(ingress, inThread.submissionId);
		assert(threadTurn.state === "answered", JSON.stringify(threadTurn));
		assert.deepEqual(
			threadTurn.files.map((file) => file.name),
			["created.txt"],
		);
		assert.notEqual(threadTurn.files[0]?.id, offered.id);
	});

	it("end to end: a mention, a turn that calls send_file, and the reply in Discord carries the file", async () => {
		// The fake model's scripted `send-file` turn sends created.txt.
		await writeFile(join(fixture.workspace, "created.txt"), "# Rules\nBe brief.\n");
		const ingress = fixture.server.host.hold(DiscordIngress, { session }, BACKGROUND_CONTEXT);
		const discord = new FakeDiscord();
		discord.add({ id: "c1", name: "general", guildId: "g1", guildName: "Guild", lastMessageId: null });
		// The session's worker for real; only the batch's text is the fake model's send_file prompt (it acts on exact
		// prompts, not on a batch).
		const port: SessionPort = {
			usable: async () => undefined,
			deliver: (_session, input) => ingress.deliver({ ...input, text: "send-file" }, BACKGROUND_CONTEXT),
			turn: (_session, submissionId) => ingress.turn({ submissionId }, BACKGROUND_CONTEXT),
			read: (_session, id, offset, length) => ingress.read({ id, offset, length }, BACKGROUND_CONTEXT),
			thread: (_session, name, before, generation) =>
				ingress.thread({ name, before, generation }, BACKGROUND_CONTEXT),
			command: (_session, input) => ingress.command(input, BACKGROUND_CONTEXT),
		};
		let state: RelayState = { bindings: { c1: { ...binding({ cursor: "1", generation }), session } }, pending: {} };
		const relay = new Relay(() => discord, port, {
			value: () => state,
			change: async (update) => {
				const draft = structuredClone(state);
				update(draft);
				state = draft;
			},
		});
		const trigger = discord.say("c1", message(`<@${BOT}> send me the rules file`));
		await relay.onMessage("bot-a", trigger);
		await poll(async () => {
			await relay.checkPending();
			return discord.posted.length > 0;
		});
		const [reply] = discord.posted;
		assert.equal(reply?.replyTo, trigger.id);
		assert.deepEqual(reply?.files, ["created.txt"]);
		assert.equal(new TextDecoder().decode(discord.uploaded.get("created.txt")), "# Rules\nBe brief.\n");
		assert.deepEqual(state.pending, {});
	});

	it("the owner's Discord view: updateLink needs a linked session; pages of version 2 still bind", async () => {
		const owner = fixture.browser();
		const discord = await holdIn(owner, Discord, {}, "owner");
		const lock = { mcp: [], projectMcp: false, instructions: false, capabilities: [] };
		await assert.rejects(
			discord.updateLink({ session, wake: { anyone: true, users: [], roles: [] }, lock }, BACKGROUND_CONTEXT),
			/not linked/,
		);
		const old = await holdIn(owner, DiscordV2, {}, "owner");
		assert.deepEqual(await until(old.bindings, (value) => Array.isArray(value)), []);
	});

	it("tells a linked session's agents where their answer goes; unlinking takes it back", async () => {
		const ingress = fixture.server.host.hold(DiscordIngress, { session }, BACKGROUND_CONTEXT);
		const input = (requestId: string, conversation?: number, thread?: string) => ({
			generation,
			...(conversation === undefined ? {} : { conversation }),
			requestId,
			author: { id: "u1", name: "Ada" },
			text: "hello",
			context: { channel: "general", guild: "Guild", messages: 1, ...(thread ? { thread } : {}) },
			files: [],
		});
		await ended(ingress, (await ingress.deliver(input("discord:1000"), BACKGROUND_CONTEXT)).submissionId);
		const owner = fixture.browser();
		const main = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		const said = sections(await until(main.view, (view) => Boolean(sections(view).discord))).discord ?? "";
		assert.match(said, /^<discord>\nYour input comes from the Discord channel #general \(Guild\)/);
		assert.match(said, /your final answer of each turn is posted there as the reply/);
		assert.match(said, /files you offer with send_file during the turn attached/);
		assert.match(said, /Nothing else is posted \(not intermediate text, thinking or tool output\)/);
		assert.match(said, /`Ann \(<@1234>\): text`; write `<@1234>` to mention them/);
		// A thread's subagent: the same, for its thread.
		const { conversation } = await ingress.thread(
			{ generation, name: "Release", before: Date.now() },
			BACKGROUND_CONTEXT,
		);
		await ended(
			ingress,
			(await ingress.deliver(input("discord:1001", conversation, "Release"), BACKGROUND_CONTEXT)).submissionId,
		);
		const sub = await holdIn(owner, Chat, { session, conversation }, "participant");
		const inThread = await until(sub.view, (view) => /the thread "Release"/.test(sections(view).discord ?? ""));
		assert.match(
			sections(inThread).discord ?? "",
			/Your input comes from the thread "Release" of the Discord channel #general/,
		);
		// Unlinked: the owner's next turn has no Discord section.
		await ingress.unlinked({ generation }, BACKGROUND_CONTEXT);
		generation++;
		await main.send({ text: "just me now", requestId: "after-unlink" }, BACKGROUND_CONTEXT);
		await until(main.view, (view) => texts(view).includes("Echo: just me now") && !sections(view).discord);
	});

	it("a batch while a turn runs steers it: both inputs end with the one answer", async () => {
		const ingress = fixture.server.host.hold(DiscordIngress, { session }, BACKGROUND_CONTEXT);
		const input = (requestId: string, text: string) => ({
			generation,
			requestId,
			author: { id: "u1", name: "Ada" },
			text,
			context: { channel: "general", guild: "Guild", messages: 1 },
			files: [],
		});
		const running = await ingress.deliver(input("discord:1100", "slow-tool"), BACKGROUND_CONTEXT);
		await poll(async () =>
			(await ingress.command({ generation, command: "status" }, BACKGROUND_CONTEXT)).text.includes("Working: yes"),
		);
		const steered = await ingress.deliver(input("discord:1101", "and this too"), BACKGROUND_CONTEXT);
		const one = await ended(ingress, running.submissionId);
		const two = await ended(ingress, steered.submissionId);
		assert(one.state === "answered" && two.state === "answered", JSON.stringify([one, two]));
		assert.equal(one.answer, two.answer, "one turn, one answer");
	});

	it("stop aborts the running turn and withdraws the queued inputs, as the web's Stop", async () => {
		const ingress = fixture.server.host.hold(DiscordIngress, { session }, BACKGROUND_CONTEXT);
		const input = (requestId: string, text: string) => ({
			generation,
			requestId,
			author: { id: "u1", name: "Ada" },
			text,
			context: { channel: "general", guild: "Guild", messages: 1 },
			files: [],
		});
		// A turn that runs a few seconds (its bash tool sleeps), and one queued behind it.
		const running = await ingress.deliver(input("discord:700", "slow-tool"), BACKGROUND_CONTEXT);
		const queued = await ingress.deliver(input("discord:701", "queued behind"), BACKGROUND_CONTEXT);
		await poll(async () =>
			(await ingress.command({ generation, command: "status" }, BACKGROUND_CONTEXT)).text.includes("Working: yes"),
		);
		const status = (await ingress.command({ generation, command: "status" }, BACKGROUND_CONTEXT)).text;
		assert.match(status, /^Model: .+\nWorking: yes\nQueued: 1\nContext: /);
		const stopped = await ingress.command({ generation, command: "stop" }, BACKGROUND_CONTEXT);
		assert.equal(stopped.text, "Stopped; 1 queued message withdrawn.");
		assert.deepEqual(await ended(ingress, running.submissionId), { state: "stopped" });
		assert.deepEqual(await ended(ingress, queued.submissionId), { state: "stopped" });
		assert.equal(
			(await ingress.command({ generation, command: "stop" }, BACKGROUND_CONTEXT)).text,
			"Nothing is running.",
		);
		assert.match(
			(await ingress.command({ generation, command: "status" }, BACKGROUND_CONTEXT)).text,
			/Working: no\nQueued: 0/,
		);
		assert.equal(
			(await ingress.command({ generation, command: "compact" }, BACKGROUND_CONTEXT)).text,
			"Compacting the context.",
		);
	});

	it("stop also aborts a running compaction (a task of its own), and says so", async () => {
		const ingress = fixture.server.host.hold(DiscordIngress, { session }, BACKGROUND_CONTEXT);
		const status = async () => (await ingress.command({ generation, command: "status" }, BACKGROUND_CONTEXT)).text;
		// Something to compact: more than compaction keeps verbatim (20k tokens), in turns the fake echoes quickly enough.
		await poll(async () => !(await status()).includes("Compacting: yes"));
		for (const index of [0, 1, 2]) {
			const turn = await ingress.deliver(
				{
					generation,
					requestId: `discord:90${index}`,
					author: { id: "u1", name: "Ada" },
					text: `part ${index}: ${"lorem ipsum dolor ".repeat(700)}`,
					context: { channel: "general", guild: "Guild", messages: 1 },
					files: [],
				},
				BACKGROUND_CONTEXT,
			);
			await ended(ingress, turn.submissionId);
		}
		assert.equal(
			(await ingress.command({ generation, command: "compact" }, BACKGROUND_CONTEXT)).text,
			"Compacting the context.",
		);
		// The fake summary streams for a moment: the stop right after reaches it running (as the web's Escape test).
		assert.equal(
			(await ingress.command({ generation, command: "stop" }, BACKGROUND_CONTEXT)).text,
			"Stopped compaction.",
		);
		assert.doesNotMatch(await status(), /Compacting/);
		assert.equal(
			(await ingress.command({ generation, command: "stop" }, BACKGROUND_CONTEXT)).text,
			"Nothing is running.",
		);
	});

	it("status reports the cost so far from the cost sheet's data, and the last turn's", async () => {
		const ingress = fixture.server.host.hold(DiscordIngress, { session }, BACKGROUND_CONTEXT);
		const turn = await ingress.deliver(
			{
				generation,
				requestId: "discord:950",
				author: { id: "u1", name: "Ada" },
				text: "what does it cost",
				context: { channel: "general", guild: "Guild", messages: 1 },
				files: [],
			},
			BACKGROUND_CONTEXT,
		);
		await ended(ingress, turn.submissionId);
		const sheet = await holdIn(fixture.browser(), ChatCosts, { session, conversation: 1 }, "viewer");
		const costs = await sheet.costs(BACKGROUND_CONTEXT);
		assert(costs.length > 0);
		const total = costs.reduce((sum, entry) => sum + entry.cost, 0);
		const dollars = (value: number) => `$${value.toFixed(value >= 0.01 || value === 0 ? 4 : 6)}`;
		const text = (await ingress.command({ generation, command: "status" }, BACKGROUND_CONTEXT)).text;
		assert(text.includes(`\nCost: ${dollars(total)} so far, last turn $`), text);
	});

	it("forks a thread's subagent from the main conversation's last answer before the thread", async () => {
		const ingress = fixture.server.host.hold(DiscordIngress, { session }, BACKGROUND_CONTEXT);
		const { conversation } = await ingress.thread(
			{ generation, name: "Release Plan!", before: Date.now() },
			BACKGROUND_CONTEXT,
		);
		assert.notEqual(conversation, 1);
		const children = await holdIn(fixture.browser(), Subagents, {}, "reader");
		await until(children.children, (value) =>
			(value?.[session] ?? []).some((child) => child.name === "discord-release-plan"),
		);
		const sub = await holdIn(fixture.browser(), Chat, { session, conversation }, "participant");
		const forked = await until(sub.view, (value) => texts(value).some((text) => text.startsWith("Echo:")));
		assert(texts(forked).length >= 1, "the fork carries the main conversation's answer");
		const delivered = await ingress.deliver(
			{
				conversation,
				generation,
				requestId: "discord:600",
				author: { id: "u1", name: "Ada" },
				text: "Ada (<@u1>): @Pi in the thread",
				context: { channel: "general", guild: "Guild", messages: 1, thread: "Release Plan!" },
				files: [],
			},
			BACKGROUND_CONTEXT,
		);
		assert.equal(delivered.conversation, conversation);
		const turn = await ended(ingress, delivered.submissionId);
		assert(turn.state === "answered" && turn.text.includes("in the thread"), JSON.stringify(turn));
		// A second thread of the same name gets its own subagent.
		const again = await ingress.thread({ generation, name: "Release Plan!", before: Date.now() }, BACKGROUND_CONTEXT);
		await until(children.children, (value) =>
			(value?.[session] ?? []).some((child) => child.name === "discord-release-plan-2"),
		);
		assert.notEqual(again.conversation, conversation);
	});
});
