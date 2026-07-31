/**
 * Tracks which task fields TickTick changed remotely during the current
 * sync cycle's pull step, so the push step (running moments later in the
 * same cycle) can tell "Obsidian disagrees with the freshly-pulled task
 * because TickTick also changed this field independently" apart from
 * "Obsidian disagrees because the user actually edited it here." Both look
 * identical as a lineTask-vs-savedTask diff; only the pull step knows which
 * one it is, since it's the one comparing against the *previous* remote
 * value.
 *
 * In-memory only, per plugin-lifetime -- not persisted, not shared across
 * devices. Cleared at the start of each sync cycle so a flag that nothing
 * ever consumes (e.g. push-detection skips that file this cycle) can't
 * leak into a later, unrelated cycle.
 */

const remoteChangedFields = new Map<string, Set<string>>();

export function clearRemoteChangedTracking(): void {
	remoteChangedFields.clear();
}

export function markRemoteChanged(taskId: string, fields: string[]): void {
	if (fields.length === 0) return;
	const existing = remoteChangedFields.get(taskId) ?? new Set<string>();
	for (const f of fields) existing.add(f);
	remoteChangedFields.set(taskId, existing);
}

/** Reads and clears the flag for a task -- each cycle's push check consumes it once. */
export function consumeRemoteChanged(taskId: string): Set<string> | undefined {
	const fields = remoteChangedFields.get(taskId);
	remoteChangedFields.delete(taskId);
	return fields;
}
