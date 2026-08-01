import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IProject } from '@/api/types/Project';

vi.mock('obsidian', () => ({
	App: vi.fn(),
	AbstractInputSuggest: class {},
	Modal: vi.fn(),
	Notice: vi.fn(),
	Plugin: vi.fn(),
	PluginSettingTab: vi.fn(),
	TFile: vi.fn(),
	TFolder: vi.fn(),
	MarkdownView: vi.fn(),
}));

vi.mock('@/utils/logger', () => ({
	default: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const projectsTable = new Map<string, { id: string; project: IProject }>();
const filesTable = new Map<string, { path: string; defaultProjectId?: string }>();

vi.mock('@/db/dexie', () => ({
	db: {
		projects: {
			get: vi.fn(async (id: string) => projectsTable.get(id)),
			bulkPut: vi.fn(async (rows: Array<{ id: string; project: IProject }>) => {
				rows.forEach(r => projectsTable.set(r.id, r));
			}),
			toArray: vi.fn(async () => [...projectsTable.values()]),
		},
		projectGroups: { get: vi.fn(async () => undefined) },
	},
}));

vi.mock('@/db/projects', () => ({
	getAllProjects: vi.fn(async () => [...projectsTable.values()].map(r => r.project)),
	getProjectById: vi.fn(async (id: string) => projectsTable.get(id)?.project),
}));

const upsertFile = vi.fn(async (path: string, defaultProjectId?: string) => {
	filesTable.set(path, { path, defaultProjectId });
});

vi.mock('@/db/files', () => ({
	upsertFile: (path: string, id?: string) => upsertFile(path, id),
	getAllFiles: vi.fn(async () => [...filesTable.values()]),
	getFile: vi.fn(async (p: string) => filesTable.get(p)),
	deleteFile: vi.fn(),
}));

vi.mock('@/settings', () => ({
	getSettings: vi.fn(() => ({
		inboxID: 'inbox-1',
		inboxName: 'Inbox',
		keepProjectFolders: false,
	})),
	getDefaultFolder: vi.fn(() => ''),
	updateSettings: vi.fn(),
}));

vi.mock('@/modals/FoundDuplicateListsModal', () => ({
	FoundDuplicateListsModal: vi.fn(function () {
		return { showModal: vi.fn().mockResolvedValue(true) };
	}),
}));

import { ProjectSyncService } from '@/services/ProjectSyncService';

const remoteProjects = (): IProject[] => ([
	{ id: 'proj-a', name: 'Work' } as IProject,
	{ id: 'proj-b', name: 'Home' } as IProject,
]);

function makePlugin() {
	const updateFilePath = vi.fn(async () => {});
	return {
		plugin: {
			fileMetadataService: {
				getAllFileMetadata: vi.fn(async () => ({})),
				getFilepathForProjectId: vi.fn(async (id: string) => {
					for (const f of filesTable.values()) {
						if (f.defaultProjectId === id) return f.path;
					}
					return undefined;
				}),
				updateFilePath,
			},
		},
		updateFilePath,
	};
}

describe('ProjectSyncService.saveProjectsToCache', () => {
	beforeEach(() => {
		projectsTable.clear();
		filesTable.clear();
		upsertFile.mockClear();
	});

	it('does not re-create mappings on subsequent syncs', async () => {
		const { plugin } = makePlugin();
		const svc = new ProjectSyncService({} as never, plugin as never);

		await svc.saveProjectsToCache(remoteProjects());
		upsertFile.mockClear();

		await svc.saveProjectsToCache(remoteProjects());
		await svc.saveProjectsToCache(remoteProjects());

		expect(upsertFile).not.toHaveBeenCalled();
	});
});
