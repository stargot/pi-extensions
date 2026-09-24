/**
 * Smoke runner: boot `pi --list-models` with every extension registered in
 * package.json → pi.extensions (the single source of truth — the old npm
 * script duplicated the list by hand and drifted).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const extensions = pkg.pi?.extensions ?? [];
if (extensions.length === 0) {
	console.error("package.json has no pi.extensions — nothing to smoke.");
	process.exit(1);
}

const args = ["--list-models", ...extensions.flatMap((e) => ["-e", e])];
// shell: true on Windows — pi resolves through an npm .cmd shim.
const result = spawnSync("pi", args, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
