import { App, Notice, TFile } from 'obsidian';
import type TickTickSync from '@/main';
import type { IProject } from '@/api/types/Project';
import { FoundDuplicateListsModal } from '@/modals/FoundDuplicateListsModal';
import { getDefaultFolder, getSettings } from '@/settings';
import log from '@/utils/logger';
import { db } from '@/db/dexie';
import { getAllProjects } from '@/db/projects';
import { getAllFiles } from '@/db/files';

export class ProjectSyncService {
	app: App;
	plugin: TickTickSync;

	constructor(app: App, plugin: TickTickSync) {
		this.app = app;
		this.plugin = plugin;
	}

	// Caches TickTick project id/name metadata for lookups (e.g. resolving a
	// task's projectId to a display name). Deliberately does NOT create a
	// vault file for a project just because it exists on TickTick -- Project
	// is TickTick-side metadata only, and this plugin never infers which
	// note "owns" a project without an explicit user action. It does keep
	// an already-mapped file's name in sync with a TickTick-side rename,
	// since that mapping was created by the user's own earlier action.
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

			for (const project of projects) {
				await this.checkProjectRename(project.id, project.name, project)
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

	// Deliberately does NOT create a vault file for a project that has no
	// existing file mapping -- that's project-level auto-materialization,
	// which this fork opts out of (see class doc comment above). Only keeps
	// an *already-mapped* file's name in sync with a TickTick-side project
	// rename, since that file was mapped by explicit user action already.
	async checkProjectRename(ttProjectId: string, ttProjectName: string, ttProject?: IProject): Promise<void> {
		const fileMetadatas = await this.plugin.fileMetadataService.getAllFileMetadata();
		if (!fileMetadatas) return;
		const projects = await getAllProjects();

		const project = projects.find(p => p.id === ttProjectId);
		if (!project) {
			return;
		}
		if (project.name !== ttProjectName) {
			log.debug(`Project Name Changed from ${project?.name} to ${ttProjectName}`)

			const files = await getAllFiles();
			const currentFile = files.find(f => f.defaultProjectId === ttProjectId);

			let currentFilePath;

			if (!currentFile) {
				log.debug(`No file found for project ${ttProjectId}`);
				currentFilePath = await this.plugin.fileMetadataService.getFilepathForProjectId(ttProjectId);
				log.debug(`currentFilePath: ${currentFilePath}`);
				if (!currentFilePath) {
					log.debug(`No file found for project ${ttProjectId} and no default file found`);
					return
				}
			} else {
				currentFilePath = currentFile.path;
			}

			const folder = getDefaultFolder();
			const safeProjectName = ttProjectName.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
			const newFilePath = (folder ? folder + "/" : "") + safeProjectName + '.md';

			log.debug(`Renaming project file from ${currentFilePath} to ${newFilePath}`);

			if (currentFilePath !== newFilePath) {
				const vaultFile = this.app.vault.getAbstractFileByPath(currentFilePath);
				if (vaultFile && vaultFile instanceof TFile) {
					log.debug(`Renaming ${currentFilePath} to ${newFilePath}`);
					await this.app.vault.rename(vaultFile, newFilePath);
					log.debug(`Updating file path in database from ${currentFilePath} to ${newFilePath}`);
					await this.plugin.fileMetadataService.updateFilePath(currentFilePath, newFilePath);
				} else {
					log.warn(`File ${currentFilePath} not found in vault, updating database only`);
					await this.plugin.fileMetadataService.updateFilePath(currentFilePath, newFilePath);
				}
			}
		}
	}

	private async showFoundDuplicatesModal(app: App, plugin: TickTickSync, projects: IProject[]) {
		const myModal = new FoundDuplicateListsModal(app, plugin, projects, () => {});
		return await myModal.showModal();
	}
}
