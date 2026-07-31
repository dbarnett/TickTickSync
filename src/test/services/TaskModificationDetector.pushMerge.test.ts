/**
 * TaskModificationDetector — observable behavior of the push path's
 * merge-onto-live-server-state fix (see docs/sync-logic.md § Push path
 * § Target fix). Exercises the real public entry point
 * (checkLineForModifications) with a real TaskParser/DateMan and
 * lightweight fakes for the plugin's storage/API surface, rather than
 * reaching into private helpers directly.
 *
 * Scope: does an unrelated local edit clobber a field TickTick changed
 * but the plugin hasn't pulled down yet? See
 * convertLineToTask.note-destination.test.ts for the sibling test using
 * the same real-TaskParser-plus-fake-plugin pattern.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TaskModificationDetector } from '@/services/TaskModificationDetector';
import { TaskParser } from '@/taskParser';
import { DateMan } from '@/dateMan';
import { NewFileMap, type ITaskRecord } from '@/services/NewFileMap';
import type { ITask } from '@/api/types/Task';
import { getSettings } from '@/settings';
import { markRemoteChanged } from '@/sync/conflictTracking';
import { Notice } from 'obsidian';

vi.mock('@/db/projects', () => ({
	getAllProjects: vi.fn().mockResolvedValue([]),
}));

vi.mock('obsidian', () => ({
	Notice: vi.fn(),
	TFile: vi.fn(),
	TFolder: vi.fn(),
}));

const TASK_ID = 'abcdefabcdefabcdefabcdef';
const FILEPATH = 'Folder/File.md';

function makeTask(overrides: Partial<ITask> = {}): ITask {
	return {
		id: TASK_ID,
		projectId: 'proj-1',
		childIds: [],
		parentId: '',
		sortOrder: 0,
		title: 'Original title',
		desc: '',
		content: '',
		startDate: '',
		dueDate: '',
		timeZone: 'UTC',
		isAllDay: false,
		reminder: '',
		reminders: [],
		repeatFlag: '',
		priority: 0,
		status: 0,
		items: [],
		progress: 0,
		modifiedTime: '2026-01-01T00:00:00.000Z',
		deleted: 0,
		tags: [],
		...overrides,
	};
}

describe('TaskModificationDetector push path: merge onto live server state', () => {
	let updateTaskSpy: ReturnType<typeof vi.fn>;
	let getTaskByIdSpy: ReturnType<typeof vi.fn>;
	let detector: TaskModificationDetector;
	let plugin: unknown;

	function makeFileMap(line: string) {
		const taskRecord: ITaskRecord = {
			task: line,
			parentId: '',
			taskLines: [],
		} as unknown as ITaskRecord;
		return {
			getTaskRecord: (_id: string) => taskRecord,
			getTaskItems: (_id: string) => [],
			getFileLines: () => line,
		} as unknown as NewFileMap;
	}

	beforeEach(() => {
		vi.mocked(Notice).mockClear();
		getSettings().fileLinksInTickTick = 'noLink';
		getSettings().syncNotes = true;

		updateTaskSpy = vi.fn(async (task: ITask) => task);
		// getTaskById represents TickTick's CURRENT server state -- may
		// already differ from savedTask (the plugin's last-known-synced
		// snapshot) because a change (e.g. completing the task on mobile)
		// hasn't been pulled down to this device yet.
		getTaskByIdSpy = vi.fn();

		const dateMan = new DateMan();
		const taskParser = new TaskParser({} as unknown as never, {} as unknown as never);

		plugin = {
			taskParser,
			dateMan,
			taskRepository: {
				loadTaskById: vi.fn(),
				loadLocalTaskById: vi.fn(),
				upsertTask: vi.fn(),
			},
			tickTickRestAPI: {
				getTaskById: getTaskByIdSpy,
				updateTask: updateTaskSpy,
			},
			fileMetadataService: {
				getFilepathForTask: vi.fn(async () => FILEPATH),
			},
			fileTaskQueries: {
				getDefaultProjectIdForFilepath: () => 'proj-1',
			},
		};
		taskParser.plugin = plugin;
		detector = new TaskModificationDetector({} as unknown as never, plugin as never);
	});

	it('does not clobber a status change TickTick has but the plugin has not pulled yet', async () => {
		const line = `- [ ] Updated title #ticktick  %%[ticktick_id:: ${TASK_ID}]%%`;

		// priority is re-derived from the line's marker on every parse (no
		// marker => 0), so it must match the line to stay "unmodified" here
		// -- otherwise detectModifications legitimately flags it changed.
		const savedTask = makeTask({ title: 'Original title', status: 0, priority: 0 });
		(plugin as { taskRepository: { loadTaskById: ReturnType<typeof vi.fn> } })
			.taskRepository.loadTaskById.mockResolvedValue(savedTask);

		// TickTick's live state: task was completed (status 2) via another
		// device/mobile, and priority bumped -- neither pulled down yet.
		const serverTask = makeTask({ title: 'Original title', status: 2, priority: 3 });
		getTaskByIdSpy.mockResolvedValue(serverTask);

		const changed = await detector.checkLineForModifications(
			FILEPATH,
			line,
			0,
			makeFileMap(line)
		);

		expect(changed).toBe(true);
		expect(updateTaskSpy).toHaveBeenCalledTimes(1);
		const pushedTask = updateTaskSpy.mock.calls[0][0] as ITask;

		// The only thing this edit touched was the title; status and
		// priority were NOT touched -- must carry TickTick's live values,
		// not the stale savedTask/checkbox-derived values.
		expect(pushedTask).toMatchObject({
			title: 'Updated title',
			status: 2,
			priority: 3,
		});
	});

	it('does push a field that was actually edited locally, even if stale on the server', async () => {
		const line = `- [ ] Original title #ticktick  %%[ticktick_id:: ${TASK_ID}]%%`;

		const savedTask = makeTask({ title: 'Original title', priority: 0 });
		(plugin as { taskRepository: { loadTaskById: ReturnType<typeof vi.fn> } })
			.taskRepository.loadTaskById.mockResolvedValue(savedTask);

		// Server hasn't seen the priority bump the checkbox line doesn't
		// encode anyway -- irrelevant here, this test is about a field
		// that DID change locally (priority is compared directly against
		// savedTask, not parsed from this line, so bump savedTask instead
		// to simulate detectModifications flagging it).
		const serverTask = makeTask({ title: 'Original title', priority: 0 });
		getTaskByIdSpy.mockResolvedValue(serverTask);

		// Force a tag change (an easy line-visible edit) to trigger the
		// content-changed push path deterministically.
		const editedLine = `- [ ] Original title #ticktick #urgent  %%[ticktick_id:: ${TASK_ID}]%%`;
		const changed = await detector.checkLineForModifications(
			FILEPATH,
			editedLine,
			0,
			makeFileMap(editedLine)
		);

		expect(changed).toBe(true);
		expect(updateTaskSpy).toHaveBeenCalledTimes(1);
		const pushedTask = updateTaskSpy.mock.calls[0][0] as ITask;
		expect(pushedTask).toMatchObject({
			tags: expect.arrayContaining(['urgent']),
		});
	});

	it('warns when a field being pushed was also changed remotely this same sync cycle', async () => {
		const line = `- [ ] Updated title #ticktick  %%[ticktick_id:: ${TASK_ID}]%%`;

		const savedTask = makeTask({ title: 'Original title', priority: 0 });
		(plugin as { taskRepository: { loadTaskById: ReturnType<typeof vi.fn> } })
			.taskRepository.loadTaskById.mockResolvedValue(savedTask);
		getTaskByIdSpy.mockResolvedValue(makeTask({ title: 'Original title', priority: 0 }));

		// Simulate this cycle's pull step having just seen TickTick change
		// the title independently, before this push-detection check runs.
		markRemoteChanged(TASK_ID, ['title']);

		await detector.checkLineForModifications(FILEPATH, line, 0, makeFileMap(line));

		const conflictNotices = vi.mocked(Notice).mock.calls
			.map(call => call[0])
			.filter((msg): msg is string => typeof msg === 'string' && msg.includes('edited on both TickTick and in Obsidian'));
		expect(conflictNotices).toEqual([expect.stringContaining('title')]);
	});

	it('does not warn when the remote change was to an unrelated field', async () => {
		const line = `- [ ] Updated title #ticktick  %%[ticktick_id:: ${TASK_ID}]%%`;

		const savedTask = makeTask({ title: 'Original title', priority: 0 });
		(plugin as { taskRepository: { loadTaskById: ReturnType<typeof vi.fn> } })
			.taskRepository.loadTaskById.mockResolvedValue(savedTask);
		getTaskByIdSpy.mockResolvedValue(makeTask({ title: 'Original title', priority: 0 }));

		// TickTick changed status remotely, but this edit only touches title --
		// no overlap, no warning.
		markRemoteChanged(TASK_ID, ['status']);

		await detector.checkLineForModifications(FILEPATH, line, 0, makeFileMap(line));

		const conflictNotices = vi.mocked(Notice).mock.calls
			.map(call => call[0])
			.filter((msg): msg is string => typeof msg === 'string' && msg.includes('edited on both TickTick and in Obsidian'));
		expect(conflictNotices).toEqual([]);
	});
});
