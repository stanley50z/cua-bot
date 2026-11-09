// The web portal page and its service worker, served by src/web.ts at GET / and GET /sw.js. They live in
// src/app.html and src/sw.js so they can be written as ordinary JavaScript; both are read once at startup.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PAGE = readFileSync(join(import.meta.dirname, "app.html"), "utf8");
export const SERVICE_WORKER = readFileSync(join(import.meta.dirname, "sw.js"), "utf8");
