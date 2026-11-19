// POSIX watchdog for the existing Node runner; artifacts remain outside runner buffering.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { resolve } from "node:path";

const [directory, seconds, ...args] = process.argv.slice(2);
const budget = Number(seconds);
if (
	process.platform === "win32" ||
	!directory ||
	!Number.isFinite(budget) ||
	budget <= 0 ||
	budget > 3600 ||
	!args.length
) {
	console.error("Usage (POSIX): node scripts/test-diagnose.mjs NEW_ARTIFACT_DIR SECONDS <node arguments...>");
	process.exit(2);
}
const output = resolve(directory);
mkdirSync(output); // Refuse to overwrite a previous attempt.
const events = openSync(`${output}/events.jsonl`, "wx", 0o600);
const stdout = openSync(`${output}/stdout.log`, "wx", 0o600);
const stderr = openSync(`${output}/stderr.log`, "wx", 0o600);
const phaseLog = `${output}/phases.jsonl`;
closeSync(openSync(phaseLog, "wx", 0o600));
const started = Date.now();
function record(event, details = {}) {
	writeSync(events, `${JSON.stringify({ event, elapsedMs: Date.now() - started, ...details })}\n`);
}
record("launch", { cwd: process.cwd(), node: process.execPath, version: process.version, args, budget });
const child = spawn(process.execPath, ["--import", new URL("./test-phase.mjs", import.meta.url).href, ...args], {
	detached: true,
	stdio: ["ignore", stdout, stderr],
	env: { ...process.env, P2_TEST_PHASE_LOG: phaseLog },
});
closeSync(stdout);
closeSync(stderr);
let stopped = false;
let terminalCode = 0;
let escalation;
function signalGroup(signal) {
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
	}
}
function stop(reason, code) {
	if (stopped) return;
	stopped = true;
	terminalCode = code;
	clearInterval(deadline);
	record("stopping", { reason, pid: child.pid });
	signalGroup("SIGTERM");
	// Keep the grace timer even if the runner exits first: its children may remain.
	escalation = setTimeout(() => {
		signalGroup("SIGKILL");
		record("group-kill", { pid: child.pid });
		process.exitCode = terminalCode;
	}, 1000);
}
// Node timers can pause during system sleep; recheck wall time promptly after wake.
const deadline = setInterval(
	() => {
		if (Date.now() - started >= budget * 1000) stop("deadline", 124);
	},
	Math.min(1000, budget * 1000),
);
process.on("SIGINT", () => stop("SIGINT", 130));
process.on("SIGTERM", () => stop("SIGTERM", 143));
child.on("spawn", () => record("spawn", { pid: child.pid, pgid: child.pid }));
child.on("error", (error) => {
	clearInterval(deadline);
	clearTimeout(escalation);
	record("spawn-error", { message: error.message });
	process.exitCode = 1;
});
child.on("exit", (code, signal) => {
	record("runner-exit", { code, signal });
	if (!stopped) stop("runner-exit-cleanup", code ?? 1);
});
process.on("exit", (code) => record("terminal", { code }));
