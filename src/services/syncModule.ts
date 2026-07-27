import TickTickSync from '@/main';
import {
	App,
	MarkdownView,
	Notice,
	TFile,
	TFolder
} from 'obsidian';
import type { ITask } from '@/api/types/Task';
import ObjectID from 'bson-objectid';
import { getSettings } from '@/settings';
import { NewFileMap, type ITaskItemRecord } from '@/services/NewFileMap';
import log from '@/utils/logger';

export class SyncMan {
	private readonly app: App;
	private readonly plugin: TickTickSync;


	constructor(app: App, plugin: TickTickSync) {
		this.app = app;
		this.plugin = plugin;
	}


	async backupTickTickAllResources() {
		try {
			// log.debug("backing up.")
			// if (this.plugin.tickTickSyncAPI) {
			// log.debug("It's defined", this.plugin.tickTickSyncAPI)
			// }
			let bkupFolder = getSettings().bkupFolder;
			if (bkupFolder[bkupFolder.length - 1] != '/') {
				bkupFolder += '/';
			}
			const now: Date = new Date();
			const month = now.getMonth() + 1;
		const timeString: string = `${now.getFullYear()}${month}${now.getDate()}${now.getHours()}${now.getMinutes()}${now.getSeconds()}`;

			const name = bkupFolder + 'ticktick-backup-' + timeString + '.csv';
			log.debug('Creating Backup: ', name);

			const bkupData = await this.plugin.tickTickRestAPI?.exportData();


			if (bkupData) {
				await this.app.vault.create(name, bkupData);
				//log.debug(`ticktick backup successful`)
				new Notice(`TickTick backup data is saved in the path ${name}`);
			}
		} catch (error) {
			log.error('An error occurred while creating TickTick backup', error);
			new Notice('An error occurred while creating TickTick backup' + (error instanceof Error ? error.message : String(error)), 5000);
		}

	}

	///End of Test


	//Update TT after reconstructing the task
	async forceUpdates(file_path: string) {
		let file;
		if (file_path) {
			file = this.app.vault.getAbstractFileByPath(file_path);
			if ((file) && (file instanceof TFolder)) {
				//leave folders alone.
				return false;
			}
			if (!file) {
				log.error(`File: ${file_path} not found. Removing from Meta Data`);
				await this.plugin.fileMetadataService?.deleteFileMetadata(file_path);
				return false;
			}
		} else {
			throw new Error('No file path provided');
		}
		if (!(file instanceof TFile)) {
			return false;
		}
		const fileMap = new NewFileMap(this.app, this.plugin, file);
		await fileMap.init();

		const lines = fileMap.getFileLines().split('\n');
		for (let line = 0; line < lines.length; line++) {
			const lineText = lines[line];
			if (this.plugin.taskParser?.hasTickTickId(lineText) && this.plugin.taskParser?.hasTickTickTag(lineText)) {
				const taskId = this.plugin.taskParser.getTickTickId(lineText);
				const savedTask = await this.plugin.taskRepository.loadTaskById(taskId ?? '');
				if (taskId && savedTask) {
					savedTask.modifiedTime = this.plugin.dateMan?.formatDateToISO(new Date()) ?? '';
					const taskRecord = fileMap.getTaskRecord(taskId)
					//NB: lineNumber = 0 is only safe because we KNOW we have a task record.
					const lineTask = await this.plugin.taskParser?.convertLineToTask(lineText, 0, fileMap.getFilePath(), fileMap, taskRecord);
					const merged = { ...savedTask, ...lineTask };
					Object.assign(lineTask, merged);
					const updatedTask = <ITask>await this.plugin.tickTickRestAPI?.updateTask(lineTask);
					//let's go ahead and do the file while we're at it.
					const updatedLineText = await this.plugin.taskParser.convertTaskToLine(updatedTask, this.plugin.taskParser.getNumTabs(lineText))
					fileMap.updateTask(updatedTask, updatedLineText )
					await this.plugin.taskRepository.upsertTask(updatedTask, undefined, Date.now());
				}
			}
		}
		const fileLines = fileMap.getFileLines()
		if (file instanceof TFile) {
			await this.app.vault.modify(file, fileLines);
		}
	}

	async handleTaskItem(lineText: string, fileMap: NewFileMap, lineNumber: number | undefined) {
		if (lineText.contains("Copy Tasks from")) {
			log.debug("Copy Tasks from found.");
		}
		let modified = false;
		let added = false;
		//it's a task. Is it a task item?
		//is it a task at all?
		if (!this.plugin.taskParser?.isMarkdownTask(lineText)) {
			//Nah Brah. Bail.
			return false;
		}
		let currentObject: ITaskItemRecord | undefined = undefined;
		const lineItemId = this.plugin.taskParser.getLineItemId(lineText);
		if (lineItemId) {
			currentObject = fileMap.getTaskItemRecord(lineItemId);
		} else {
			if (lineNumber) {
				currentObject = fileMap.getTaskItemRecordByLine(lineNumber);
			}
		}
		if (!currentObject) {
			//a text line of no interest.
			log.warn('Item not found in file map: ', lineText);
			return false;
		}

		if ((!currentObject.parentId || currentObject.parentId === '' || currentObject.parentId.length < 1)) {
			return false;
		}

		// Verify this is a genuine task item, not note-level content.
		if (lineNumber !== undefined) {
			const fileLines = fileMap.getFileLines().split('\n');
			for (let i = lineNumber - 1; i >= 0; i--) {
				const ancestorLine = fileLines[i];
				if (this.plugin.taskParser.isMarkdownTask(ancestorLine) && this.plugin.taskParser.hasTickTickId(ancestorLine)) {
					const ancestorTabs = this.plugin.taskParser.getNumTabs(ancestorLine);
					if (!this.plugin.taskParser.isTaskItem(lineText, ancestorTabs)) {
						return false;
					}
					break;
				}
			}
		}

		const parentID = currentObject.parentId;
		const itemId = currentObject.ID;

		const newItem = this.plugin.taskParser?.taskFromLine(lineText);

		const parentTask = await this.plugin.taskRepository.loadTaskById(parentID);
		if (parentTask && parentTask.items) { //we have some items.
			if (itemId) {
				const oldItem = parentTask.items.find((item) => item.id == itemId);
				if (oldItem) {
					if (oldItem.title.trim() != newItem!.description.trim() ||
						oldItem.status != (newItem?.status ? 2 : 0)) {
						oldItem.title = newItem!.description.trim();
						oldItem.status = newItem!.status ? 2 : 0;
						modified = true;
					}
				} else {
					//TODO: Assume that there's a timing issue, and assume that this item really needs to live
					log.warn('', newItem, 'not found in parent items. Forcibly adding...');
					parentTask.items.push({
						id: itemId,
						title: newItem!.description,
						status: newItem!.status ? 2 : 0
					});
					modified = true;
				}
			} else {
				const Oid = ObjectID();
				const OidHexString = Oid.toHexString();
				parentTask.items.push({
					id: OidHexString,
					title: newItem!.description,
					status: newItem!.status ? 2 : 0
				});
				const updatedItemContent = `${lineText} %%${OidHexString}%%`;
				//Update the line in the file.
				try {
					const markDownView = this.app.workspace.getActiveViewOfType(MarkdownView);
					const editor = markDownView?.app.workspace.activeEditor?.editor;
					editor?.setLine(lineNumber!, updatedItemContent);
				} catch (error) {
					log.error(`Error updating item: ${String(error)}`);
				}
				added = true;
			}

		} else {
			if (getSettings().debugMode) {
				// log.debug(`parent didn't have items.`);
			}
		}

		if (modified || added) {
			//do the update mambo. cache and api.
			if (parentTask) {
				const filepath = fileMap.getFilePath();
				modified = await this.updateTask(parentTask, filepath);
			}
		}

		return modified;
	}

	private async updateTask(parentTask: ITask, filepath: string) {
		parentTask.modifiedTime = this.plugin.dateMan?.formatDateToISO(new Date()) ?? '';
		await this.plugin.taskRepository.upsertTask(parentTask, filepath, Date.now());
		if (getSettings().fileLinksInTickTick !== 'noLink') {
			let taskURL = this.plugin.taskParser?.getObsidianUrlFromFilepath(filepath);
			//If getSettings().fileLinksInTickTick === "noteLink") it's already been handled in
			//   convertLineToTask
			if (getSettings().fileLinksInTickTick === 'taskLink') {
				if (taskURL) {
					parentTask.title = parentTask.title + ' ' + taskURL;
				}
			}
		}
		const result = await this.plugin.tickTickRestAPI?.updateTask(parentTask);
		const updateFailed = !result;
		new Notice(`Task ${parentTask.title} modified.`);
		return !updateFailed;
	}


}
