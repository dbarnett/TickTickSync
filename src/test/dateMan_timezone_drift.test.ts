/**
 * Scope: DateMan.parseDates() producing a timezone-stable isoDate for
 * all-day (date-only) values -- the #366 regression.
 *
 * Distinct from dateMan_scheduled.test.ts, which covers
 * addDateHolderToTask's field *preservation* logic (merging old/new task
 * date holders), not date parsing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DateMan } from '../dateMan';

// Mock logger to avoid window.moment issues
vi.mock('@/utils/logger', () => ({
	default: {
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	}
}));

describe('DateMan.parseDates all-day timezone drift (#366)', () => {
	let dateMan: DateMan;
	let originalTZ: string | undefined;

	beforeEach(() => {
		dateMan = new DateMan();
		originalTZ = process.env.TZ;
	});

	afterEach(() => {
		process.env.TZ = originalTZ;
	});

	it.each([
		['Pacific/Kiritimati', 'UTC+14'],
		['Etc/GMT+12', 'UTC-12'],
	])('keeps the same calendar day for an all-day dueDate under host TZ %s (%s)', (tz) => {
		process.env.TZ = tz;
		const result = dateMan.parseDates('Some task 📅 2026-08-09');

		expect(result.dueDate).toMatchObject({
			date: '2026-08-09',
			isoDate: '2026-08-09T00:00:00.000+0000',
		});
	});

	it('produces an identical isoDate on repeated parses of the same line', () => {
		// isoDate (not date, which is just an echo of the regex match) is
		// the field the #366 bug actually corrupted, via new Date(...)
		// re-evaluating host-local time on each call. Guards against any
		// per-call state drift in DateMan itself, distinct from the
		// cross-timezone check above.
		process.env.TZ = 'Etc/GMT+12';
		const line = 'Some task 📅 2026-08-09';

		const isoDates = Array.from({ length: 5 }, () => dateMan.parseDates(line).dueDate?.isoDate);

		expect(isoDates).toEqual(Array(5).fill('2026-08-09T00:00:00.000+0000'));
	});
});
