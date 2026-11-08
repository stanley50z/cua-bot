// Read-only check against a Space: list the driver tools, take one screenshot, print its path. The Space is the
// default, or the one named (by name or id) as the first argument:  node test/computer.smoke.ts "Mac mini (Tailscale)"
import { readFileSync } from "node:fs";
import { createRegistry } from "@earendil-works/pi-durable";
import { captureScreenshot, createComputerExtension, listDriverToolNames, prepareComputerTools } from "../src/computer.ts";

const space = process.argv[2];
createComputerExtension(createRegistry());
const names = await listDriverToolNames(space);
console.log(`driver tools (${names.length}):`);
for (const name of names) console.log(name);
const childTools = await prepareComputerTools(space);
if (!childTools.includes("space_bash") || childTools.includes("computer_use")) {
	throw new Error(`child tools wrong: ${childTools.join(",")}`);
}
console.log(`child tools (${childTools.length}), includes space_bash`);
const path = await captureScreenshot(space);
const bytes = readFileSync(path);
if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
	throw new Error(`screenshot is not a PNG: ${path}`);
}
console.log(path);
process.exit(0);
