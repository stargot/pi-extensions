/**
 * session-recall CLI: поиск по сессиям без pi.
 *
 *   node extensions/session-recall/cli.ts <query...> [--limit N] [--full] [--json] [--dir <sessions-dir>]
 *
 * Синтаксис запроса тот же, что у /recall: слова, "фразы", role:, project:, tool:.
 */
import { formatDate, type IndexCache, parseQuery, refreshIndex, search } from "./search.ts";
import { resolveSessionsDir } from "../shared/sessions.ts";

function main(argv: string[]): number {
	let limit = 20;
	let full = false;
	let json = false;
	let dir = resolveSessionsDir();
	const words: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--limit") limit = Number(argv[++i] ?? limit) || limit;
		else if (arg === "--full") full = true;
		else if (arg === "--json") json = true;
		else if (arg === "--dir") dir = argv[++i] ?? dir;
		else if (arg === "-h" || arg === "--help") {
			process.stdout.write("usage: cli.ts <query...> [--limit N] [--full] [--json] [--dir <sessions>]\n");
			return 0;
		} else words.push(arg);
	}
	const queryText = words.join(" ").trim();
	if (!queryText) {
		process.stderr.write("recall: empty query\n");
		return 2;
	}

	const cache: IndexCache = new Map();
	const index = refreshIndex(dir, cache);
	const { hits, total } = search(index.units, parseQuery(queryText), { limit });

	if (json) {
		process.stdout.write(`${JSON.stringify({ query: queryText, files: index.files, total, hits }, null, 2)}\n`);
		return 0;
	}
	process.stdout.write(`${total} results for "${queryText}" in ${index.files} sessions\n\n`);
	for (const hit of hits) {
		const u = hit.unit;
		const role = u.role === "tool" ? `tool:${u.tool ?? "?"}` : u.role;
		process.stdout.write(`${formatDate(u.timestamp)}  ${u.project}  ${role}${u.sessionName ? `  ${u.sessionName}` : ""}\n`);
		process.stdout.write(`  ${u.file}  #${u.entryId}\n`);
		process.stdout.write(full ? `${u.text}\n\n` : `  ${hit.snippet}\n\n`);
	}
	return 0;
}

process.exit(main(process.argv.slice(2)));
