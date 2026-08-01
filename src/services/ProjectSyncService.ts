import { App, Notice } from 'obsidian';
import type TickTickSync from '@/main';
import type { IProject } from '@/api/types/Project';
import { FoundDuplicateListsModal } from '@/modals/FoundDuplicateListsModal';
import { getSettings } from '@/settings';
import log from '@/utils/logger';
import { db } from '@/db/dexie';

export class ProjectSyncService {
	app: App;
	plugin: TickTickSync;

	constructor(app: App, plugin: TickTickSync) {
		this.app = app;
		this.plugin = plugin;
	}

	// Caches TickTick project id/name metadata for lookups (e.g. resolving a
	// task's projectId to a display name). Deliberately does NOT materialize
	// or rename vault files per project -- Project is TickTick-side metadata
	// only, never something this plugin should be moving/creating files for.
	async saveProjectsToCache(projects: IProject[]): Promise<boolean> {
		try {
			const inboxProject = {
				id: getSettings().inboxID,
				name: getSettings().inboxName
			} as IProject;
			projects.push(inboxProject);

			const duplicates = projects.reduce((acc, obj, index, arr) => {
				const duplicateIndex = arr.findIndex(item => item.name === obj.name && item.id !== obj.id);
				if (duplicateIndex !== -1 && !acc.includes(obj)) {
					acc.push(obj);
				}
				return acc;
			}, [] as IProject[]);
			const sortedDuplicates = duplicates.sort((a, b) => a.name.localeCompare(b.name));
			if (sortedDuplicates.length > 0) {
				const dupList = sortedDuplicates.map(thing => `${thing.id} ${thing.name}`);
				log.debug('Found duplicate lists: ', dupList);
				await this.showFoundDuplicatesModal(this.app, this.plugin, sortedDuplicates);
				return false;
			}

			const localProjects = projects.map(p => ({ id: p.id, project: p }));
			await db.projects.bulkPut(localProjects);

			return true;
		} catch (error) {
			log.error('Error on save projects: ', error);
			new Notice(`error on save projects: ${error instanceof Error ? error.message : String(error)}`);
		}
		return false;
	}

	private async showFoundDuplicatesModal(app: App, plugin: TickTickSync, projects: IProject[]) {
		const myModal = new FoundDuplicateListsModal(app, plugin, projects, () => {});
		return await myModal.showModal();
	}
}
