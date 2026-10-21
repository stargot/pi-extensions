/**
 * Shell command classification shared by the subagents prime policy (solo
 * budget) and the read-only guard: which commands in a line read files, which write
 * them, which mutate state. Heuristics over the command text — a tripwire for
 * a cooperating model, not a sandbox: `python -c`/`node -e` can still do
 * anything.
 *
 * Deliberately dependency-free so tests can run standalone.
 */

/** Commands of a `;` / `&&` / `||` / newline sequence, each split into its pipe stages. */
export function shellPipelines(command: string): string[][] {
	return command
		.split(/&&|\|\||;|\r?\n/)
		.map((segment) =>
			segment
				.split("|")
				.map((stage) => stage.trim())
				.filter(Boolean),
		)
		.filter((stages) => stages.length > 0);
}

const SHELL_REDIRECT = /(?<![0-9&>=-])>>?\s*([^\s|;&<>]+)/g;
const SHELL_WRITER =
	/\b(?:Set-Content|Add-Content|Out-File|tee)\s+(?:-(?:LiteralPath|FilePath|Path)\s+)?(?:-Append\s+)?([^\s|;&-][^\s|;&]*)/gi;
const NULL_SINKS = new Set(["/dev/null", "$null", "nul", "null"]);

/**
 * Files a shell command writes via redirection or a writer cmdlet. Null sinks
 * are ignored; quotes are stripped. `2> err.txt` (stderr capture) is not
 * reported.
 */
export function shellWriteTargets(command: string): string[] {
	const targets = new Set<string>();
	for (const pattern of [SHELL_REDIRECT, SHELL_WRITER]) {
		for (const match of command.matchAll(pattern)) {
			const target = (match[1] ?? "").replace(/^["']|["']$/g, "");
			if (target && !NULL_SINKS.has(target.toLowerCase())) targets.add(target);
		}
	}
	return [...targets];
}

const MUTATING_COMMANDS =
	/^(rm|rmdir|del|erase|mv|move|cp|copy|mkdir|md|touch|chmod|chown|ln|truncate|dd|Remove-Item|Move-Item|Copy-Item|New-Item|Rename-Item|Set-Content|Add-Content|Clear-Content|Out-File|Set-Item|ri|mi|ni)(\s|$)/i;
const IN_PLACE_EDIT = /^(sed|perl)\s+(.*\s)?-i/i;
const GIT_MUTATING =
	/^git\s+(add|commit|push|pull|fetch|reset|checkout|switch|restore|rebase|merge|clean|apply|am|cherry-pick|revert|rm|mv|init|clone|worktree|submodule|gc|prune|update-ref)(\s|$)/i;
const GIT_STASH_WRITE = /^git\s+stash(?!\s+(list|show)(\s|$))/i;
const GIT_REF_WRITE =
	/^git\s+(branch\s+(.*\s)?(-d|-m|-c|-f|--delete|--move|--copy|--force)|tag\s+(.*\s)?(-a|-d|-f|-s|--delete|--force))(\s|$)/i;
const PACKAGE_MUTATING =
	/^(npm|pnpm|yarn|bun)\s+(i|install|add|remove|rm|uninstall|update|up|upgrade|publish|link|ci)(\s|$)|^(pip|pip3|uv|poetry|pipx|cargo|go|gem|scoop|winget|choco|apt|apt-get|brew)\s+(pip\s+)?(install|add|remove|uninstall|update|upgrade|sync|publish|get)(\s|$)/i;
const CURL_WRITE =
	/^curl\s(.*\s)?((-X|--request)\s*(POST|PUT|PATCH|DELETE)|(-d|--data\S*|-F|--form|-T|--upload-file|-o|-O|--output|--remote-name)(\s|=|$))/i;
const WGET_WRITE = /^wget\s(?!.*(-O\s*-|-qO-|--output-document=-))/i;

const MUTATORS = [
	MUTATING_COMMANDS,
	IN_PLACE_EDIT,
	GIT_MUTATING,
	GIT_STASH_WRITE,
	GIT_REF_WRITE,
	PACKAGE_MUTATING,
	CURL_WRITE,
	WGET_WRITE,
];

const WRAPPER = /^(xargs(\s+-\S+)*|sudo|nohup|time|env(\s+\w+=\S+)*)\s+/i;

/** `xargs rm`, `sudo npm i`, `env A=1 git push` — the command they run. */
function stripWrappers(stage: string): string {
	let inner = stage;
	for (let match = WRAPPER.exec(inner); match; match = WRAPPER.exec(inner)) inner = inner.slice(match[0].length);
	return inner;
}

/**
 * First reason this command would change files, git state, installed
 * packages or remote state — or undefined when it looks read-only. Every
 * pipe stage of every sequenced command is checked.
 */
export function shellMutation(command: string): string | undefined {
	const targets = shellWriteTargets(command);
	if (targets.length > 0) return `writes ${targets.join(", ")}`;
	for (const stages of shellPipelines(command)) {
		for (const stage of stages) {
			const inner = stripWrappers(stage);
			if (MUTATORS.some((pattern) => pattern.test(inner))) return `runs \`${stage.slice(0, 80)}\``;
		}
	}
	return undefined;
}
