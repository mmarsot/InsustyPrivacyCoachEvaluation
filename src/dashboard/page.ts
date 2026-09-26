import { readFileSync } from "node:fs";

/** The dashboard's single page (static HTML + vanilla JS, no build step). */
export const PAGE_HTML = readFileSync(new URL("./page.html", import.meta.url), "utf8");
