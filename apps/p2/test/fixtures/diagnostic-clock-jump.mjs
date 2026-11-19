// Supervisor-only preload: advance wall time after the test signals a ready hanging child.
import { existsSync } from "node:fs";

const now = Date.now;
Date.now = () => now() + (existsSync(process.env.P2_DIAGNOSTIC_CLOCK_JUMP) ? 60_000 : 0);
