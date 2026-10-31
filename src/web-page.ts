// The web app page, served by src/web.ts at GET /. The document lives in src/app.html so its
// inline script can be written as ordinary JavaScript; it is read once at startup.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PAGE = readFileSync(join(import.meta.dirname, "app.html"), "utf8");
