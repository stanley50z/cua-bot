// The persona's date line (see the "today" section in src/main.ts), rendered every turn so the model
// never has to look the date up. Day granularity keeps the prompt stable: Pi Durable appends a system
// patch only when a section's text changes, so this costs one small entry per day.
export function today(now: Date, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
	const date = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone });
	return `Today is ${date}, in the owner's time zone (${timeZone}).`;
}
