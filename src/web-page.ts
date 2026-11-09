// The web portal page and its service worker, served by src/web.ts at GET / and GET /sw.js. They live in
// src/app.html and src/sw.js so they can be written as ordinary JavaScript; both are read once at startup.
// LIBRARIES holds the browser builds of the page's two script dependencies, by the path src/web.ts serves each at.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const { resolve } = createRequire(import.meta.url);

export const PAGE = readFileSync(join(import.meta.dirname, "app.html"), "utf8");
export const SERVICE_WORKER = readFileSync(join(import.meta.dirname, "sw.js"), "utf8");
export const LIBRARIES = new Map([
	["/marked.js", readFileSync(join(dirname(resolve("marked")), "marked.umd.js"), "utf8")],
	["/purify.js", readFileSync(resolve("dompurify/purify.min.js"), "utf8")],
]);
