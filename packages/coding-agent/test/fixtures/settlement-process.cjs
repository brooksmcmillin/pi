const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { appendFileSync, existsSync } = require("node:fs");

const [mode, marker, release] = process.argv.slice(2);
if (mode === "parent") {
	const child = spawn(process.execPath, [__filename, "leaf", marker, release], {
		stdio: ["ignore", "inherit", "inherit", "ipc"],
	});
	child.once("message", () => process.exit(0));
} else {
	process.on("SIGTERM", () => {
		appendFileSync(marker, "stopped\n");
		process.exit(0);
	});
	announceReady();
	const timer = setInterval(() => {
		appendFileSync(marker, "tick\n");
		process.stdout.write("tick\n");
		if (existsSync(release)) {
			clearInterval(timer);
			process.exit(0);
		}
	}, 10);
}

function announceReady() {
	// The parent can send SIGTERM as soon as it reads this marker.
	assert(process.listenerCount("SIGTERM") > 0, "SIGTERM handler must be installed before readiness");
	appendFileSync(marker, "ready\n");
	process.stdout.write("ready\n");
	process.send?.("ready");
}
