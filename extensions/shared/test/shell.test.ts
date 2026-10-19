import assert from "node:assert/strict";
import { test } from "node:test";
import { shellMutation, shellPipelines, shellWriteTargets } from "../shell.ts";

test("shellPipelines: sequences split into pipe stages", () => {
	assert.deepEqual(shellPipelines("cd a && git diff | head; npm test\nls"), [
		["cd a"],
		["git diff", "head"],
		["npm test"],
		["ls"],
	]);
});

test("shellWriteTargets: redirects and writer cmdlets, null sinks ignored", () => {
	assert.deepEqual(shellWriteTargets("cat > notes.md <<'EOF'"), ["notes.md"]);
	assert.deepEqual(shellWriteTargets("Out-File -FilePath o.txt"), ["o.txt"]);
	assert.deepEqual(shellWriteTargets("npm test 2>&1 > /dev/null"), []);
});

test("shellMutation: read-only commands pass", () => {
	for (const command of [
		"git status --short",
		"git diff HEAD~1 | head -50",
		"git log --oneline -5",
		"git stash list",
		"git branch -a",
		"npm test",
		"npx tsc --noEmit",
		"rg -n foo src",
		"curl -s https://osv.dev/v1/query",
		"wget -qO- https://example.com",
		"sed -n 1,20p a.ts",
	]) {
		assert.equal(shellMutation(command), undefined, command);
	}
});

test("shellMutation: file, git, package and remote mutations are reported", () => {
	for (const command of [
		"echo x > a.txt",
		"rm -rf dist",
		"Remove-Item a.txt",
		"sed -i 's/a/b/' f.ts",
		"git add -A",
		"git commit -m wip",
		"git stash",
		"git branch -D old",
		"git push origin main",
		"npm install left-pad",
		"uv pip install requests",
		"curl -X POST https://api.example.com",
		"curl -o out.bin https://example.com/x",
		"wget https://example.com/x.zip",
		"git diff | xargs rm",
		"ls; mkdir tmp",
	]) {
		assert.ok(shellMutation(command), command);
	}
});
