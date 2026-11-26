const { spawn } = require("node:child_process");
const { appendFileSync, existsSync } = require("node:fs");

const [mode, marker, release] = process.argv.slice(2);
if (mode === "parent") {
	const child = spawn(process.execPath, [__filename, "leaf", marker, release], {
		stdio: ["ignore", "inherit", "inherit", "ipc"],
	});
	child.once("message", () => process.exit(0));
} else {
	const timer = setInterval(() => {
		appendFileSync(marker, "tick\n");
		process.stdout.write("tick\n");
		if (existsSync(release)) {
			clearInterval(timer);
			process.exit(0);
		}
	}, 10);
	process.on("SIGTERM", () => {
		appendFileSync(marker, "stopped\n");
		process.exit(0);
	});
	// The parent may cancel immediately after readiness, before this event-loop turn ends.
	appendFileSync(marker, "ready\n");
	process.stdout.write("ready\n");
	process.send?.("ready");
}
