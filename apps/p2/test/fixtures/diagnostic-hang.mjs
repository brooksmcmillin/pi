import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { phase } from "../../scripts/test-phase.mjs";

phase("fixture-module");
const mode = process.env.P2_DIAGNOSTIC_FIXTURE;
function hang() {
	spawn(
		process.execPath,
		[
			"--import",
			new URL("../../scripts/test-phase.mjs", import.meta.url).href,
			"-e",
			"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
		],
		{ stdio: "ignore" },
	);
	// Block even the runner's timeout callbacks, not just an unresolved promise.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
before(() => {
	phase("setup:start");
	if (mode === "setup") hang();
	phase("setup:end");
});
after(() => {
	phase("teardown:start");
	if (mode === "teardown") hang();
	phase("teardown:end");
});
test("controlled fixture", () => {
	phase("test:start");
	if (mode === "body") hang();
	phase("test:end");
	if (mode === "fail") throw new Error("controlled failure");
});
