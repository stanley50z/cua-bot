// Cron schedule maths: next-fire for 5-field cron, nicknames, @every, CRON_TZ, legacy conversion,
// labels, and rejection of bad specs. Expected instants are calendar literals (Date.UTC), never
// recomputed through the code under test. 2026-10-30 is a Friday; 2026-11-01 a Sunday.
// Run from the repo root:  node --test test/cron.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { cronLabel, legacyToCron, nextFire, toCronSpec } from "../src/cron.ts";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi, s));

test("weekday cron fires the same morning, then skips the weekend", () => {
	const spec = "CRON_TZ=UTC 30 7 * * 1-5";
	assert.equal(nextFire(spec, utc(2026, 10, 30, 6, 0)).getTime(), utc(2026, 10, 30, 7, 30).getTime());
	assert.equal(nextFire(spec, utc(2026, 10, 30, 8, 0)).getTime(), utc(2026, 11, 2, 7, 30).getTime());
});

test("next fire is strictly after the reference instant", () => {
	const spec = "CRON_TZ=UTC 30 7 * * *";
	assert.equal(nextFire(spec, utc(2026, 10, 30, 7, 30)).getTime(), utc(2026, 10, 31, 7, 30).getTime());
});

test("nicknames resolve to their calendar slots", () => {
	assert.equal(nextFire("CRON_TZ=UTC @hourly", utc(2026, 10, 30, 10, 20)).getTime(), utc(2026, 10, 30, 11, 0).getTime());
	assert.equal(nextFire("CRON_TZ=UTC @daily", utc(2026, 10, 30, 8, 0)).getTime(), utc(2026, 10, 31, 0, 0).getTime());
	assert.equal(nextFire("CRON_TZ=UTC @weekly", utc(2026, 10, 30, 8, 0)).getTime(), utc(2026, 11, 1, 0, 0).getTime());
	assert.equal(nextFire("CRON_TZ=UTC @monthly", utc(2026, 10, 30, 8, 0)).getTime(), utc(2026, 11, 1, 0, 0).getTime());
});

test("@every adds the interval to the reference instant", () => {
	const from = utc(2026, 10, 30, 12, 0);
	assert.equal(nextFire("@every 30s", from).getTime(), from.getTime() + 30_000);
	assert.equal(nextFire("@every 5m", from).getTime(), from.getTime() + 300_000);
	assert.equal(nextFire("@every 2h", from).getTime(), from.getTime() + 7_200_000);
	assert.equal(nextFire("@every 1h30m", from).getTime(), from.getTime() + 5_400_000);
});

test("CRON_TZ is honoured across the DST change", () => {
	const spec = "CRON_TZ=America/New_York 30 7 * * *";
	// 2026-10-30 is still EDT (UTC-4); DST ends 2026-11-01.
	assert.equal(nextFire(spec, utc(2026, 10, 30, 0, 0)).getTime(), utc(2026, 10, 30, 11, 30).getTime());
	// December is EST (UTC-5).
	assert.equal(nextFire(spec, utc(2026, 12, 1, 0, 0)).getTime(), utc(2026, 12, 1, 12, 30).getTime());
});

test("bare cron uses local time", () => {
	const next = nextFire("30 7 * * *", utc(2026, 10, 30, 0, 0));
	assert.equal(next.getHours(), 7);
	assert.equal(next.getMinutes(), 30);
	assert.ok(next.getTime() > utc(2026, 10, 30, 0, 0).getTime());
});

test("legacy schedules convert to cron with Sunday as weekday 1", () => {
	assert.equal(legacyToCron({ kind: "everyMinutes", minutes: 15 }), "@every 15m");
	assert.equal(legacyToCron({ kind: "dailyAt", hour: 8, minute: 5 }), "5 8 * * *");
	assert.equal(legacyToCron({ kind: "weeklyOn", weekday: 1, hour: 9, minute: 0 }), "0 9 * * 0");
	assert.equal(legacyToCron({ kind: "weeklyOn", weekday: 2, hour: 9, minute: 0 }), "0 9 * * 1");
	assert.equal(legacyToCron({ kind: "weeklyOn", weekday: 7, hour: 9, minute: 0 }), "0 9 * * 6");
});

test("a converted weeklyOn lands on the named weekday at the named local time", () => {
	const sunday = nextFire(legacyToCron({ kind: "weeklyOn", weekday: 1, hour: 9, minute: 0 }), utc(2026, 10, 30, 0, 0));
	assert.equal(sunday.getDay(), 0);
	assert.equal(sunday.getHours(), 9);
	assert.equal(sunday.getMinutes(), 0);
	const saturday = nextFire(legacyToCron({ kind: "weeklyOn", weekday: 7, hour: 9, minute: 0 }), utc(2026, 10, 30, 0, 0));
	assert.equal(saturday.getDay(), 6);
});

test("toCronSpec normalizes whitespace and accepts both input shapes", () => {
	assert.equal(toCronSpec("  30   7 * *   1-5 "), "30 7 * * 1-5");
	assert.equal(toCronSpec("CRON_TZ=UTC   @daily"), "CRON_TZ=UTC @daily");
	assert.equal(toCronSpec({ kind: "everyMinutes", minutes: 1 }), "@every 1m");
});

test("labels name day lists, ranges, and weekday names", () => {
	assert.equal(cronLabel("0 9 * * 2,5"), "Tuesdays and Fridays 09:00");
	assert.equal(cronLabel("0 9 * * tue,fri"), "Tuesdays and Fridays 09:00");
	assert.equal(cronLabel("0 9 * * FRI,TUE"), "Tuesdays and Fridays 09:00");
	assert.equal(cronLabel("0 9 * * 1,3,5"), "Mondays, Wednesdays and Fridays 09:00");
	assert.equal(cronLabel("0 9 * * 1-3"), "Mondays, Tuesdays and Wednesdays 09:00");
	assert.equal(cronLabel("0 9 * * 0,6"), "weekends 09:00");
	assert.equal(cronLabel("0 9 * * sat,sun"), "weekends 09:00");
	assert.equal(cronLabel("0 9 * * fri"), "Fridays 09:00");
	assert.equal(cronLabel("0 9 * * 0-6"), "daily 09:00");
	assert.equal(cronLabel("0 9 * * 2,2,5"), "Tuesdays and Fridays 09:00");
});

test("labels name the common shapes and keep the raw spec otherwise", () => {
	assert.equal(cronLabel("30 7 * * 1-5"), "weekdays 07:30");
	assert.equal(cronLabel("5 8 * * *"), "daily 08:05");
	assert.equal(cronLabel("0 9 * * 1"), "Mondays 09:00");
	assert.equal(cronLabel("0 9 * * 0"), "Sundays 09:00");
	assert.equal(cronLabel("@every 30m"), "every 30m");
	assert.equal(cronLabel("@hourly"), "hourly");
	assert.equal(cronLabel("@daily"), "daily 00:00");
	assert.equal(cronLabel("*/15 * * * *"), "*/15 * * * *");
	assert.equal(cronLabel("CRON_TZ=America/New_York 30 7 * * 1-5"), "weekdays 07:30 America/New_York");
});

test("bad specs throw instead of guessing", () => {
	const from = utc(2026, 10, 30, 0, 0);
	for (const bad of ["", "banana", "61 * * * *", "* * * *", "0 9 * * * *", "@sometimes", "@every", "@every 0m", "@every 5x", "@every -5m"]) {
		assert.throws(() => nextFire(bad, from), /Invalid cron/, bad);
	}
	assert.throws(() => nextFire("CRON_TZ=Not/AZone 0 9 * * *", from), /Invalid cron/);
	assert.throws(() => legacyToCron({ kind: "weeklyOn", weekday: 8, hour: 9, minute: 0 }), /weekday/);
	assert.throws(() => legacyToCron({ kind: "dailyAt", hour: 24, minute: 0 }), /hour/);
	assert.throws(() => legacyToCron({ kind: "everyMinutes", minutes: 0 }), /minutes/);
});

test("an impossible calendar date has no next fire", () => {
	assert.throws(() => nextFire("CRON_TZ=UTC 0 0 30 2 *", utc(2026, 1, 1)), /no next fire/);
});
