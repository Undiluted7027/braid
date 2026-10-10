// Lets Node load the Worker's own modules in tests: `cloudflare:workers` becomes a stand-in, and
// imports written without an extension (the bundler's style) are found as .ts files.
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);
