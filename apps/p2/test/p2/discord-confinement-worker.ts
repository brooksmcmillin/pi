// Real session-worker lifecycle with offline environments and worker-owned confinement fixtures.
import { filesFacet } from "@earendil-works/chord/app/files";
import { workerMain } from "@earendil-works/chord/workers/child";
import {
	type ConversationId,
	configure,
	defineExtension,
	defineTask,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { awaitWithContext, BACKGROUND_CONTEXT, defineFacet, forbidden, whenLive } from "@p2/app/v1";
import discordWorker from "../../plugins/discord/worker.ts";
import { InheritedLocation, Subagents } from "../../plugins/subagents/contract.worker.ts";
import { WORKER_PACKAGES } from "../../src/hosts/host-packages.ts";
import { createHost } from "../../src/runtime/chord.ts";
import { durableContext } from "../../src/runtime/durable.ts";
import { hostFiles, openHostStore, sessionDirectory } from "../../src/runtime/host-dirs.ts";
import { HOST, SERVER } from "../../src/runtime/principals.ts";
import {
	conversationEnvironment,
	Extensions,
	HarnessEnvironments,
	HarnessHost,
	HarnessNative,
	harnessOf,
	InputGates,
	Liveness,
	SessionLocation,
	spawnLocation,
	type WorkerInit,
	workerCore,
	workerOf,
} from "../../src/runtime/worker.ts";
import { ConfinementProbe } from "./discord-confinement-contract.ts";

const background = defineTask<null, { phase: "held" }, null>({
	name: "test.confinement-background",
	version: 1,
	initial: () => ({ phase: "held" }),
	phases: {
		held: async (_task, _runtime, context) => {
			await awaitWithContext(new Promise<void>(() => {}), context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

const fixture = defineFacet((host, self) => {
	self.contribute(Extensions, {
		"confinement-background": defineExtension({ name: "confinement-background", tasks: [background] }),
	});
	let input: { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
	self.contribute(InputGates, {
		confinement: async () => {
			const held = input;
			if (held) {
				held.entered.resolve();
				await held.release.promise;
			}
		},
	});
	self.contribute(HarnessEnvironments, {
		remote: {
			open: async (name) => {
				if (name !== "sandbox" && name !== "ssh") throw new Error(`Unknown fixture environment ${name}`);
				return { at: (cwd) => new NodeExecutionEnv({ cwd }), close: () => {} };
			},
			describe: async (name) => `Offline fixture ${name}`,
			sandbox: (name) => name === "sandbox",
		},
	});
	host.serve(ConfinementProbe, (_params, principal, self) => {
		if (principal.kind !== "server") throw forbidden("server only");
		const harness = harnessOf(self);
		const worker = workerOf(self);
		return {
			variant: "server",
			members: {
				startBackground: async (ctx) => {
					await harness().durable.commit(
						(tx) =>
							tx.createTask(background, null, {
								ownership: { kind: "conversation" },
								conversationId: ROOT_CONVERSATION_ID,
								background: true,
							}),
						durableContext(ctx),
					);
					return null;
				},
				armInput: async () => {
					input = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
					return null;
				},
				inputEntered: async () => {
					await input!.entered.promise;
					return null;
				},
				releaseInput: async () => {
					input!.release.resolve();
					input = undefined;
					return null;
				},
				seed: ({ name, location, parent, archived, legacy }, ctx) =>
					worker().liveness.call(async () => {
						const durable = harness().durable;
						const context = durableContext(ctx);
						const child = await durable.createConversation({ ownership: { kind: "ownerless" } }, context);
						await durable.commit(async (tx) => {
							await configure(tx, child.id, {
								model: { provider: "faux", modelId: "faux-1" },
								cwd: location?.cwd ?? worker().location.value.cwd,
							});
							if (parent === undefined) {
								(await tx.doc(Subagents, ROOT_CONVERSATION_ID)).agents[name] = {
									conversationId: child.id,
									model: "faux/faux-1",
									thinkingLevel: "off",
									tools: [],
									...(location ? (legacy ? { unplacedCwd: location.cwd } : { location }) : {}),
									...(archived ? { archived: true } : {}),
									reported: [],
								};
							} else {
								// The probe's numeric parent is a worker-created Durable conversation ID.
								const registry = await tx.doc(Subagents, parent as ConversationId);
								registry.oneShots ??= {};
								registry.oneShots[name] = {
									conversationId: child.id,
									label: name,
									model: "faux/faux-1",
									thinkingLevel: "off",
									tools: [],
								};
								if (location) (await tx.doc(InheritedLocation, child.id)).location = location;
							}
							await tx.appendEntry(child.id, { kind: "note", data: "preserved child history" });
						}, context);
						return child.id;
					}),
				inspect: async ({ conversation }, ctx) => {
					// The wire uses numeric IDs; Durable brands those same persisted identifiers.
					const { env, location } = await conversationEnvironment(
						harness().environments,
						conversation as ConversationId,
						ctx,
					);
					let marker = "";
					const result = await env.exec(
						"pwd",
						{
							onOutput: (text) => {
								marker += text;
							},
						},
						durableContext(ctx),
					);
					if (!result.ok) throw new Error(result.error.message);
					const history = await harness().durable.commit(async (tx) => {
						// Wire conversation IDs are the same persisted numeric identifiers.
						const page = await tx.scanEntries({ conversationId: conversation as ConversationId }, 100);
						return page.items.some((entry) => entry.kind === "note" && entry.data === "preserved child history");
					}, durableContext(ctx));
					return { location, marker: marker.trim(), generation: worker().init.generation, history };
				},
			},
		};
	});
});

workerMain(
	async ({ address, start, parent, plugins, onClose }, context) => {
		// The parent supplies the production WorkerInit through workerMain's JSON transport.
		const init = start as unknown as WorkerInit;
		const dir = sessionDirectory(init.dataDir, init.values.session.id);
		const store = await openHostStore(dir, { outbox: false }, context);
		onClose(() => store.close(BACKGROUND_CONTEXT));
		const host = createHost({ address, principal: HOST, store, onError: (error) => console.error(error) });
		const liveness = new Liveness();
		onClose(async () => {
			liveness.stop();
			await host.close(BACKGROUND_CONTEXT);
		});
		host.connect(parent, { principal: SERVER, trusted: true }, context);
		await plugins.load(
			host,
			{
				kind: "worker",
				core: [
					{
						name: "@p2/core",
						facet: workerCore(
							init,
							liveness,
							new SessionLocation(spawnLocation(init.values.session)),
							store,
							(fn, ctx) => host.root(fn, ctx),
						),
					},
					{ name: "chord.app.files", facet: filesFacet(hostFiles(dir)) },
					{ name: "discord", facet: discordWorker },
					{ name: "confinement-fixture", facet: fixture },
				],
			},
			context,
		);
		const ready = host.hold(HarnessHost, {}, context);
		try {
			await whenLive(ready);
		} finally {
			ready.release();
		}
		const harness = (await host.registry(HarnessNative, context)).value;
		if (harness !== undefined && init.values.session.resume !== false) harness.durable.resume();
		return { busy: liveness };
	},
	{
		hostPackages: WORKER_PACKAGES,
		redact: () => ({ message: "Confinement fixture worker failed" }),
		onError: (error) => console.error(error),
	},
);
