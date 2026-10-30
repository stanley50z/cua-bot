// Read-only check against the paired Mac: list the driver tools, take one screenshot, print its path.
import { readFileSync } from "node:fs";
import { captureScreenshot, listDriverToolNames, prepareComputerTools } from "../src/computer.ts";

const names = await listDriverToolNames();
console.log(`driver tools (${names.length}):`);
for (const name of names) console.log(name);
const childTools = await prepareComputerTools();
if (!childTools.includes("space_bash") || childTools.includes("computer_use")) {
	throw new Error(`child tools wrong: ${childTools.join(",")}`);
}
console.log(`child tools (${childTools.length}), includes space_bash`);
const path = await captureScreenshot();
const bytes = readFileSync(path);
if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
	throw new Error(`screenshot is not a PNG: ${path}`);
}
console.log(path);
