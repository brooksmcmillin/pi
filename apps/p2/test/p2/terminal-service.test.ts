// Closing an archived session's terminals (`TerminalService.closeSession`): no host is started when none runs, and a
// host running older code, which does not know `closeSession`, has them closed with the viewer protocol (list, then
// attach and force-close each). The old host here is a fake speaking that protocol.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectRunningTerminalHost, terminalHostAddress } from "../../plugins/terminals/detached.ts";
import { encodeFrame, readFrames, type TerminalInfo, type TerminalRequest } from "../../plugins/terminals/protocol.ts";
import { TerminalService, TerminalView } from "../../plugins/terminals/service.ts";
import { APP, poll } from "./helpers.ts";

const terminal = (id: string, sessionId: string): TerminalInfo => ({
	id,
	sessionId,
	index: 0,
	cwd: "/",
	env: null,
	title: "",
	createdAt: 0,
	cols: 80,
	rows: 24,
});

test("closing a session starts no host, and closes an outdated host's terminals as the panel does", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-terminal-service-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const service = new TerminalService(directory, APP);
	t.after(() => service.close());

	// No host runs: nothing to close, and none is started.
	await service.closeSession("s1");
	assert.equal(await connectRunningTerminalHost(directory), undefined);

	// A host running older code: it only knows the viewer requests.
	const terminals = [terminal("a", "s1"), terminal("b", "s1"), terminal("c", "s2")];
	const requests: TerminalRequest[] = [];
	const host = createServer((socket: Socket) => {
		let attached: string | undefined;
		socket.write(encodeFrame({ type: "hello", version: "older", running: terminals.length, pid: 1 }));
		readFrames(socket, (frame) => {
			const request = frame as TerminalRequest;
			requests.push(request);
			if (request.type === "list")
				socket.write(
					encodeFrame({
						type: "list",
						terminals: terminals.filter((each) => each.sessionId === request.sessionId),
					}),
				);
			else if (request.type === "attach") attached = request.terminalId;
			else if (request.type === "close" && request.force && attached) {
				terminals.splice(
					terminals.findIndex((each) => each.id === attached),
					1,
				);
				socket.write(encodeFrame({ type: "closed", terminalId: attached }));
				attached = undefined;
			} else socket.write(encodeFrame({ type: "error", message: "Unknown request" }));
		});
	});
	const address = await terminalHostAddress(directory);
	await new Promise<void>((resolve) => host.listen(address, resolve));
	t.after(() => new Promise<void>((resolve) => host.close(() => resolve())));
	await service.closeSession("s1");
	assert.deepEqual(requests, [
		{ type: "list", sessionId: "s1" },
		{ type: "attach", terminalId: "a" },
		{ type: "close", force: true },
		{ type: "attach", terminalId: "b" },
		{ type: "close", force: true },
	]);
	assert.deepEqual(
		terminals.map((each) => each.id),
		["c"],
	);
	// A session without terminals: one listing, nothing closed.
	requests.length = 0;
	await service.closeSession("s3");
	assert.deepEqual(requests, [{ type: "list", sessionId: "s3" }]);
});

test("closing a service fences opens and calls still loading the host version", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-terminal-service-"));
	const service = new TerminalService(directory, APP);
	t.after(async () => {
		await service.close();
		const host = await connectRunningTerminalHost(directory);
		if (host) {
			const closed = once(host, "close");
			host.resume();
			host.write(encodeFrame({ type: "shutdown" }));
			await closed;
		}
		await rm(directory, { recursive: true, force: true });
	});
	const rejected = Promise.all([
		assert.rejects(service.open("s1"), /closed/),
		assert.rejects(service.call({ op: "list", sessionId: "s1" }), /closed/),
	]);
	const closing = service.close();
	assert.equal(service.close(), closing, "concurrent close callers join the same work");
	await closing;
	await rejected;
	await assert.rejects(service.open("late"), /closed/);
	await assert.rejects(service.call({ op: "list", sessionId: "late" }), /closed/);
	assert.equal(await connectRunningTerminalHost(directory), undefined, "closure must not start a host");
});

test(
	"closing a view joins pending attachment startup but preserves the detached host",
	{ timeout: 20_000 },
	async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "p2-terminal-service-"));
		const view = new TerminalView(directory, APP, "s1", "test-version");
		t.after(async () => {
			await view.close();
			let host: Socket | undefined;
			await poll(
				async () => {
					host = await connectRunningTerminalHost(directory);
					return Boolean(host);
				},
				10_000,
				"started terminal host",
			);
			const closed = once(host!, "close");
			host!.resume();
			host!.write(encodeFrame({ type: "shutdown" }));
			await closed;
			await rm(directory, { recursive: true, force: true });
		});
		const rejected = assert.rejects(view.ready(), /disconnected|closed/);
		await view.close();
		await rejected;
		await assert.rejects(view.ready(), /closed/);
		const host = await connectRunningTerminalHost(directory);
		assert.ok(host, "close joins connection startup rather than leaving it to finish later");
		host.destroy();
	},
);
