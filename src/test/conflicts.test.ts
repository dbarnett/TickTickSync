import { describe, it, expect } from 'vitest';
import { resolveTaskConflict } from '../sync/conflicts';
import type { LocalTask } from '../db/schema';

function makeTask(modifiedTime: string | undefined, overrides: Partial<LocalTask> = {}): LocalTask {
	return {
		localId: 'test-local',
		taskId: 'test-task',
		task: { id: 'test-task', title: 'test', projectId: '', modifiedTime } as unknown,
		updatedAt: 1000,
		lastModifiedByDeviceId: 'device-a',
		file: '',
		source: 'obsidian',
		...overrides
	};
}

describe('resolveTaskConflict', () => {

	it('returns remote when no local exists', () => {
		const remote = makeTask('2026-01-01T00:00:00.000+0000');
		const result = resolveTaskConflict(undefined, remote);
		expect(result.resolved).toBe(remote);
		expect(result.conflictDetected).toBe(false);
		expect(result.winner).toBe('remote');
	});

	it('resolves local when local.task.modifiedTime is newer than remote', () => {
		const local = makeTask('2026-01-02T00:00:00.000+0000', { lastModifiedByDeviceId: 'device-a' });
		const remote = makeTask('2026-01-01T00:00:00.000+0000', { lastModifiedByDeviceId: 'device-b' });
		const result = resolveTaskConflict(local, remote);
		expect(result.resolved).toBe(local);
		expect(result.conflictDetected).toBe(true);
		expect(result.winner).toBe('local');
	});

	it('resolves remote when remote.task.modifiedTime is newer than local', () => {
		const local = makeTask('2026-01-01T00:00:00.000+0000', { lastModifiedByDeviceId: 'device-a' });
		const remote = makeTask('2026-01-02T00:00:00.000+0000', { lastModifiedByDeviceId: 'device-b' });
		const result = resolveTaskConflict(local, remote);
		expect(result.resolved).toBe(remote);
		expect(result.conflictDetected).toBe(true);
		expect(result.winner).toBe('remote');
	});

	it('ignores stale internal updatedAt bookkeeping in favor of TickTick modifiedTime', () => {
		// Regression case: a no-op hash-only resync (or any internal write)
		// can bump updatedAt to Date.now() without a real edit happening.
		// A remote change with a genuinely newer TickTick modifiedTime must
		// still win even though local's bookkeeping updatedAt is higher.
		const local = makeTask('2026-01-01T00:00:00.000+0000', { updatedAt: 99999999999 });
		const remote = makeTask('2026-01-02T00:00:00.000+0000', { updatedAt: 1 });
		const result = resolveTaskConflict(local, remote);
		expect(result.resolved).toBe(remote);
		expect(result.winner).toBe('remote');
	});

	it('resolves local on tie when same device', () => {
		const local = makeTask('2026-01-01T00:00:00.000+0000', { lastModifiedByDeviceId: 'device-a' });
		const remote = makeTask('2026-01-01T00:00:00.000+0000', { lastModifiedByDeviceId: 'device-a' });
		const result = resolveTaskConflict(local, remote);
		expect(result.resolved).toBe(local);
		expect(result.conflictDetected).toBe(true);
		expect(result.winner).toBe('local');
	});

	it('resolves local on tie regardless of device', () => {
		const local = makeTask('2026-01-01T00:00:00.000+0000', { lastModifiedByDeviceId: 'device-a' });
		const remote = makeTask('2026-01-01T00:00:00.000+0000', { lastModifiedByDeviceId: 'device-b' });
		const result = resolveTaskConflict(local, remote);
		expect(result.resolved).toBe(local);
		expect(result.conflictDetected).toBe(true);
		expect(result.winner).toBe('local');
	});
});
