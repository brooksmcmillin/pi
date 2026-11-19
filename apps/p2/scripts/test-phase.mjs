// Synchronous side-channel evidence survives Node test-runner output buffering.
import { appendFileSync } from "node:fs";

export function phase(name) {
	if (process.env.P2_TEST_PHASE_LOG) {
		appendFileSync(
			process.env.P2_TEST_PHASE_LOG,
			`${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ppid: process.ppid, phase: name })}\n`,
		);
	}
}

phase("node-preload");
