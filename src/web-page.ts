// The web portal page, its service worker and its web app manifest, served by src/web.ts at GET /, GET /sw.js
// and GET /manifest.webmanifest. The page and the worker live in
// src/app.html and src/sw.js so they can be written as ordinary JavaScript; both are read once at startup.
// LIBRARIES holds the browser builds of the page's two script dependencies, by the path src/web.ts serves each at.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const { resolve } = createRequire(import.meta.url);

export const PAGE = readFileSync(join(import.meta.dirname, "app.html"), "utf8");
export const SERVICE_WORKER = readFileSync(join(import.meta.dirname, "sw.js"), "utf8");
// The web app manifest at /manifest.webmanifest. iOS and iPadOS give a Home Screen web app Web Push only
// when its manifest asks for a standalone display; without one, the page has no PushManager there.
export const MANIFEST = JSON.stringify({
	name: "cua-bot",
	short_name: "cua-bot",
	start_url: "/",
	scope: "/",
	display: "standalone",
	background_color: "#F4F6F8",
	theme_color: "#F4F6F8",
});
export const LIBRARIES = new Map([
	["/marked.js", readFileSync(join(dirname(resolve("marked")), "marked.umd.js"), "utf8")],
	["/purify.js", readFileSync(resolve("dompurify/purify.min.js"), "utf8")],
]);
