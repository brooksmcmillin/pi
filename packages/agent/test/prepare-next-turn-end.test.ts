import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentMessage, runAgentLoop } from "../src/index.ts";

describe("next-turn preparation handoff", () => {
	for (const queue of ["steer", "followUp"] as const) {
		for (const mode of ["one-at-a-time", "all"] as const) {
			it(`restores selected ${queue} messages in ${mode} mode before settlement`, async () => {
				const faux = createFauxCore({});
				faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("response")));
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const messages: AgentMessage[] = ["A", "B", "C"].map((content) => ({
					role: "user",
					content,
					timestamp: 0,
				}));
				const agent = new Agent({
					initialState: { model: getModel("openai", "gpt-4o-mini") },
					streamFn: faux.streamSimple,
					steeringMode: mode,
					followUpMode: mode,
					prepareNextTurn: async () => {
						entered.resolve();
						await release.promise;
						return { action: "end", messages: [{ role: "user", content: "ignored", timestamp: 0 }] };
					},
				});
				const delivered: AgentMessage[] = [];
				const batches: AgentMessage[][] = [];
				let queued = false;
				agent.subscribe((event) => {
					if (event.type === "message_end") delivered.push(event.message);
					if (event.type === "turn_end" && !queued) {
						queued = true;
						agent[queue](messages[0]);
						agent[queue](messages[1]);
					}
					if (event.type === "agent_end") batches.push(agent.peekQueuedMessages());
				});
				const run = agent.prompt("start");
				await entered.promise;
				agent[queue](messages[2]);
				release.resolve();
				await run;
				expect(faux.state.callCount).toBe(1);
				expect(delivered.filter((message) => messages.includes(message))).toEqual([]);
				expect(batches).toEqual([mode === "all" ? messages : [messages[0]]]);
				expect(JSON.stringify(agent.state.messages)).not.toContain("ignored");
				agent.prepareNextTurn = undefined;
				await agent.continue();
				expect(delivered.filter((message) => messages.includes(message))).toEqual(messages);
				expect(agent.state.messages.filter((message) => messages.includes(message))).toEqual(messages);
				expect(faux.state.callCount).toBe(mode === "all" ? 2 : 4);
				expect(agent.hasQueuedMessages()).toBe(false);
			});
		}
	}
	it("keeps new steering ahead of a returned follow-up batch", async () => {
		const faux = createFauxCore({});
		faux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("response")));
		const followUp: AgentMessage = { role: "user", content: "follow-up", timestamp: 0 };
		const steering: AgentMessage = { role: "user", content: "steering", timestamp: 0 };
		const agent = new Agent({
			initialState: { model: getModel("openai", "gpt-4o-mini") },
			streamFn: faux.streamSimple,
			prepareNextTurn: () => {
				agent.steer(steering);
				return { action: "end" };
			},
		});
		agent.followUp(followUp);
		await agent.prompt("start");
		expect(agent.peekQueuedMessages()).toEqual([steering]);
		agent.prepareNextTurn = undefined;
		await agent.continue();
		expect(agent.state.messages.filter((message) => message === steering || message === followUp)).toEqual([
			steering,
			followUp,
		]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it.each(["steering", "followUp"] as const)("returns low-level %s batches without emitting them", async (queue) => {
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage("response")]);
		const selected: AgentMessage = { role: "user", content: "selected", timestamp: 0 };
		const events: AgentEvent[] = [];
		const poll = async () => (faux.state.callCount === 1 ? [selected] : []);
		const messages = await runAgentLoop(
			[{ role: "user", content: "start", timestamp: 0 }],
			{ messages: [] },
			{
				model: getModel("openai", "gpt-4o-mini"),
				convertToLlm: () => [],
				getSteeringMessages: queue === "steering" ? poll : undefined,
				getFollowUpMessages: queue === "followUp" ? poll : undefined,
				prepareNextTurn: () => ({ action: "end" }),
			},
			(event) => {
				events.push(event);
			},
			undefined,
			faux.streamSimple,
		);
		expect(events.at(-1)).toEqual({
			type: "agent_end",
			messages,
			unconsumedMessages: { queue, messages: [selected] },
		});
		expect(messages).not.toContain(selected);
		expect(events.filter((event) => event.type === "message_end" && event.message === selected)).toEqual([]);
	});

	it("settles without starting another turn or synthesizing an error", async () => {
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage("completed response"), fauxAssistantMessage("must not run")]);
		const agent = new Agent({
			initialState: { model: getModel("openai", "gpt-4o-mini") },
			streamFn: faux.streamSimple,
			finishTurn: () => ({ action: "continue" }),
			prepareNextTurnWithContext: async () => ({
				action: "end",
				messages: [{ role: "user", content: "must not append", timestamp: Date.now() }],
			}),
		});
		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
		});
		await agent.prompt("start");
		expect(faux.state.callCount).toBe(1);
		for (const type of ["turn_start", "turn_end", "agent_end"]) {
			expect(events.filter((event) => event.type === type)).toHaveLength(1);
		}
		expect(events.at(-1)?.type).toBe("agent_end");
		expect(JSON.stringify(agent.state.messages)).not.toContain("must not append");
		expect(agent.state.errorMessage).toBeUndefined();
		expect(agent.state.isStreaming).toBe(false);
	});
});
