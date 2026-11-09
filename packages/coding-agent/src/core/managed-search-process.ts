import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getBinDir } from "../config.ts";
import { ensureTool } from "../utils/tools-manager.ts";
import { OwnerActivity, type Settlement } from "./owner-activity.ts";

/** Guarded searches use already-provisioned, host-validated rg/fd, never PATH probes or downloads. */
export async function resolveSearchTool(tool: "rg" | "fd", customOperations: boolean): Promise<string | undefined> {
	const owner = OwnerActivity.current;
	if (!owner?.guarded) return ensureTool(tool);
	owner.assertCurrent();
	if (owner.maintenance) throw new Error("Cache maintenance cannot start subprocesses");
	if (customOperations) throw new Error("Autonomous custom search operations are unsupported");
	const binary = join(getBinDir(), tool + (process.platform === "win32" ? ".exe" : ""));
	if (!existsSync(binary)) throw new Error(`Autonomous search requires a pre-provisioned ${tool} binary`);
	return binary;
}

/** Supervise one audited leaf search process. This is not a general shell or process-tree backend. */
export function spawnSearchProcess(command: string, args: string[], signal?: AbortSignal) {
	const owner = OwnerActivity.current;
	owner?.assertCurrent();
	if (owner?.maintenance) throw new Error("Cache maintenance cannot start subprocesses");
	signal?.throwIfAborted();
	owner?.dispatch();
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	const { promise: settlement, resolve } = Promise.withResolvers<Settlement>();
	let terminal = false;
	let exited = false;
	let failedSpawn = false;
	let deadline: ReturnType<typeof setTimeout> | undefined;

	const finish = (outcome: Settlement) => {
		if (terminal) return;
		terminal = true;
		if (deadline) clearTimeout(deadline);
		if (outcome === "uncertain") owner?.markUncertain();
		resolve(outcome);
	};
	child.once("exit", () => {
		exited = true;
	});
	child.on("error", () => {
		// Node also emits error for failed signalling; that is not an exit acknowledgement.
		if (child.pid === undefined) failedSpawn = true;
		else finish("uncertain");
	});
	child.once("close", () => finish(exited || failedSpawn ? "settled" : "uncertain"));
	owner?.joinSubprocess(settlement);

	return {
		child,
		settlement,
		stop() {
			if (terminal || deadline) return;
			if (!exited && !child.killed) {
				try {
					if (!child.kill()) {
						finish("uncertain");
						return;
					}
				} catch {
					finish("uncertain");
					return;
				}
			}
			// A deadline reports loss of supervision, never successful cleanup or settlement.
			deadline = setTimeout(() => finish("uncertain"), 5_000);
		},
	};
}
