import type { LocalTask } from "@/db/schema";

export type ConflictResult = {
	resolved: LocalTask;
	conflictDetected: boolean;
	winner: "local" | "remote";
};

export function resolveTaskConflict(
	local: LocalTask | undefined,
	remote: LocalTask
): ConflictResult {
	if (!local) return { resolved: remote, conflictDetected: false, winner: "remote" };

	// Compare TickTick's own modifiedTime, not our internal updatedAt
	// bookkeeping -- updatedAt gets bumped to Date.now() by several
	// no-real-edit paths (routine bookkeeping resyncs, a plain vault
	// rewrite from a previous pull), so it doesn't reliably mean "local
	// has a genuinely newer edit than remote." modifiedTime only changes
	// when we write a task actually sourced from TickTick (a pull, or a
	// push's API-ack response), same signal echo suppression above uses.
	const localModifiedAt = local.task.modifiedTime ? new Date(local.task.modifiedTime).getTime() : 0;
	const remoteModifiedAt = remote.task.modifiedTime ? new Date(remote.task.modifiedTime).getTime() : 0;

	if (localModifiedAt >= remoteModifiedAt) {
		return { resolved: local, conflictDetected: true, winner: "local" };
	}

	return { resolved: remote, conflictDetected: true, winner: "remote" };
}
