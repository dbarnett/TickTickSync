/**
 * Scope: TaskParser.isTitleChanged() detecting a TickTick-side title
 * that's missing its expected Obsidian link, not just genuine content
 * edits. Distinct from taskParser.test.ts, which doesn't cover this
 * method.
 */
import { describe, expect, it } from 'vitest';
import { TaskParser } from '@/taskParser';
import { getSettings } from '@/settings';
import type { ITask } from '@/api/types/Task';

function makeParser() {
	return new TaskParser({} as unknown, {} as unknown);
}

function task(title: string): ITask {
	return { title } as ITask;
}

describe('TaskParser.isTitleChanged', () => {
	it('detects a genuine content edit regardless of link settings', () => {
		((getSettings as unknown as () => Record<string, string>)()).fileLinksInTickTick = 'noLink';
		const parser = makeParser();

		expect(parser.isTitleChanged(task('New title'), task('Old title'))).toBe(true);
	});

	it('sees no change when content and link both match', () => {
		((getSettings as unknown as () => Record<string, string>)()).fileLinksInTickTick = 'taskLink';
		const parser = makeParser();
		const link = ' [Folder/File.md](obsidian://open?vault=V&file=Folder%2FFile.md)';

		expect(parser.isTitleChanged(task(`Task${link}`), task(`Task${link}`))).toBe(false);
	});

	it('detects a change when the TT-side title is missing its expected link', () => {
		((getSettings as unknown as () => Record<string, string>)()).fileLinksInTickTick = 'taskLink';
		const parser = makeParser();
		const link = ' [Folder/File.md](obsidian://open?vault=V&file=Folder%2FFile.md)';

		// Content matches once the link is stripped from both sides, but
		// TickTick's copy has no link at all -- this is the #366-follow-up
		// bug: previously invisible to the comparison, so it never healed.
		expect(parser.isTitleChanged(task(`Task${link}`), task('Task'))).toBe(true);
	});

	it('does not require a link when fileLinksInTickTick is not taskLink', () => {
		((getSettings as unknown as () => Record<string, string>)()).fileLinksInTickTick = 'noLink';
		const parser = makeParser();

		expect(parser.isTitleChanged(task('Task'), task('Task'))).toBe(false);
	});
});
