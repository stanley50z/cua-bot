// Cron schedules for routines: 5-field cron (minute hour day-of-month month day-of-week,
// day-of-week 0 = Sunday), the @hourly/@daily/@weekly/@monthly nicknames, `@every 30s|5m|2h`,
// and an optional `CRON_TZ=Area/City` prefix for the calendar shapes. The hackathon's three
// legacy schedule objects convert to this grammar in legacyToCron. Bad specs throw; nothing
// here guesses. Calendar maths is croner's; this module owns the grammar around it.
import { Cron } from "croner";

/** The hackathon schedule shapes, still accepted at the tool boundary and in stored state. `weekday` is 1 = Sunday … 7 = Saturday. */
export type LegacySchedule =
	| { kind: "everyMinutes"; minutes: number }
	| { kind: "dailyAt"; hour: number; minute: number }
	| { kind: "weeklyOn"; weekday: number; hour: number; minute: number };

export type ParsedSchedule =
	| { kind: "every"; spec: string; everyMs: number }
	| { kind: "cron"; spec: string; expression: string; timezone?: string };

const NICKNAMES = new Set(["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"]);
const NICKNAME_LABELS: Record<string, string> = {
	"@hourly": "hourly",
	"@daily": "daily 00:00",
	"@midnight": "daily 00:00",
	"@weekly": "weekly Sun 00:00",
	"@monthly": "monthly on the 1st 00:00",
	"@yearly": "yearly Jan 1 00:00",
	"@annually": "yearly Jan 1 00:00",
};
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function invalid(raw: string, detail: string): Error {
	return new Error(`Invalid cron schedule ${JSON.stringify(raw)}: ${detail}`);
}

function parseDurationMs(text: string): number | undefined {
	if (!/^(\d+[smhd])+$/.test(text)) return undefined;
	let ms = 0;
	for (const part of text.matchAll(/(\d+)([smhd])/g)) ms += Number(part[1]) * (UNIT_MS[part[2] ?? ""] ?? 0);
	return ms;
}

function checkTimezone(timezone: string, raw: string): void {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
	} catch {
		throw invalid(raw, `unknown timezone ${JSON.stringify(timezone)}`);
	}
}

function cronJob(expression: string, timezone: string | undefined, raw: string): Cron {
	try {
		return new Cron(expression, { timezone, mode: "5-part", paused: true });
	} catch (error) {
		throw invalid(raw, error instanceof Error ? error.message : String(error));
	}
}

/** Parse and validate a schedule spec. Returns the normalized spec to store. Throws on anything malformed. */
export function parseCron(raw: string): ParsedSchedule {
	const spec = raw.trim().replace(/\s+/g, " ");
	if (spec.length === 0) throw invalid(raw, "schedule is empty");

	let rest = spec;
	let timezone: string | undefined;
	const tzMatch = rest.match(/^CRON_TZ=(\S+) (.+)$/);
	if (tzMatch?.[1] !== undefined && tzMatch[2] !== undefined) {
		timezone = tzMatch[1];
		rest = tzMatch[2];
		checkTimezone(timezone, raw);
	} else if (rest.startsWith("CRON_TZ=")) {
		throw invalid(raw, "CRON_TZ= must be followed by a timezone, a space, and a schedule");
	}

	if (/^@every/i.test(rest)) {
		if (timezone !== undefined) throw invalid(raw, "CRON_TZ does not apply to @every intervals");
		const duration = rest.replace(/^@every\s*/i, "").toLowerCase();
		const everyMs = parseDurationMs(duration);
		if (everyMs === undefined || everyMs < 1_000) {
			throw invalid(raw, "@every needs a duration of at least 1s, like 30s, 5m, 2h, or 1h30m");
		}
		return { kind: "every", spec: `@every ${duration}`, everyMs };
	}

	const expression = rest.startsWith("@") ? rest.toLowerCase() : rest;
	if (expression.startsWith("@")) {
		if (!NICKNAMES.has(expression)) throw invalid(raw, `unknown nickname ${JSON.stringify(expression)}`);
	} else if (expression.split(" ").length !== 5) {
		throw invalid(raw, "expected 5 fields: minute hour day-of-month month day-of-week");
	}
	cronJob(expression, timezone, raw); // validate fields and ranges now, not at first fire
	return {
		kind: "cron",
		spec: timezone === undefined ? expression : `CRON_TZ=${timezone} ${expression}`,
		expression,
		timezone,
	};
}

/** The first fire strictly after `from`. Throws when the spec is invalid or never fires (e.g. Feb 30). */
export function nextFire(spec: string, from: Date): Date {
	const parsed = parseCron(spec);
	if (parsed.kind === "every") return new Date(from.getTime() + parsed.everyMs);
	const job = cronJob(parsed.expression, parsed.timezone, spec);
	let next: Date | null;
	try {
		next = job.nextRun(from);
		// Croner is strictly-after already; keep the guarantee local so a fire can never re-arm at its own instant.
		if (next !== null && next.getTime() <= from.getTime()) next = job.nextRun(new Date(from.getTime() + 1_000));
	} catch (error) {
		throw invalid(spec, error instanceof Error ? error.message : String(error));
	}
	if (next === null) throw new Error(`Cron schedule ${JSON.stringify(spec)} has no next fire time`);
	return next;
}

function intIn(name: string, value: number, min: number, max: number): number {
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`legacy schedule ${name} must be an integer from ${min} to ${max}, got ${value}`);
	}
	return value;
}

/** Convert a legacy schedule object to the cron grammar. Legacy `weekday` 1 = Sunday … 7 = Saturday becomes cron 0–6. */
export function legacyToCron(schedule: LegacySchedule): string {
	switch (schedule.kind) {
		case "everyMinutes": {
			if (!Number.isInteger(schedule.minutes) || schedule.minutes < 1) {
				throw new Error(`legacy schedule minutes must be a positive integer, got ${schedule.minutes}`);
			}
			return `@every ${schedule.minutes}m`;
		}
		case "dailyAt":
			return `${intIn("minute", schedule.minute, 0, 59)} ${intIn("hour", schedule.hour, 0, 23)} * * *`;
		case "weeklyOn":
			return `${intIn("minute", schedule.minute, 0, 59)} ${intIn("hour", schedule.hour, 0, 23)} * * ${intIn("weekday", schedule.weekday, 1, 7) - 1}`;
	}
}

/** Normalize tool input (a cron string or a legacy object) to the stored cron spec. Throws on a bad spec. */
export function toCronSpec(input: string | LegacySchedule): string {
	return parseCron(typeof input === "string" ? input : legacyToCron(input)).spec;
}

/** One-line human label for wake text and listings: `weekdays 07:30`, `every 30m`, else the raw expression. */
export function cronLabel(spec: string): string {
	const parsed = parseCron(spec);
	if (parsed.kind === "every") return `every ${parsed.spec.slice("@every ".length)}`;
	const suffix = parsed.timezone === undefined ? "" : ` ${parsed.timezone}`;
	const expression = parsed.expression;
	const nickname = NICKNAME_LABELS[expression];
	if (nickname !== undefined) return `${nickname}${suffix}`;
	const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = expression.split(" ");
	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dayOfMonth === "*" && month === "*") {
		const at = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
		if (dayOfWeek === "*") return `daily ${at}${suffix}`;
		if (dayOfWeek === "1-5") return `weekdays ${at}${suffix}`;
		if (/^[0-7]$/.test(dayOfWeek)) return `${WEEKDAYS[Number(dayOfWeek) % 7]}s ${at}${suffix}`;
	}
	return `${expression}${suffix}`;
}
