// Compare documentation selections for a local TUI command using sendUserMessage.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const docsPath = "docs/extensions.md";
const examplePath = "examples/extensions/send-user-message.ts";
const root = new URL("../", import.meta.url);
const docs = readFileSync(new URL(docsPath, root), "utf8");
const example = readFileSync(new URL(examplePath, root), "utf8");
const headings = [
	["# Extensions", "## Table of Contents"],
	["## Extension Locations", "## Available Imports"],
	["## Available Imports", "### Tool parameter schemas and TypeBox"],
	["## Writing an Extension", "### Async factory functions"],
	["### Long-lived resources and shutdown", "### Extension Styles"],
	["## ExtensionContext", "### ctx.cwd"],
	["### ctx.isIdle() / ctx.abort() / ctx.hasPendingMessages()", "### ctx.shutdown()"],
	["## ExtensionCommandContext", "### ctx.getSystemPromptOptions()"],
	["### pi.sendUserMessage(content, options?)", "### pi.appendEntry(customType, data?)"],
	["### pi.registerCommand(name, options)", "### pi.getCommands()"],
	["### Dialogs", "#### Timed Dialogs with Countdown"],
	["## Error Handling", "## Examples Reference"],
];
const selections = headings.map(([start, end]) => {
	const from = docs.indexOf(`\n${start}\n`) + 1;
	const to = docs.indexOf(`\n${end}\n`, from);
	assert.ok(from > 0 && to > from, `Missing section: ${start} -> ${end}`);
	return {
		path: docsPath,
		heading: start,
		lines: [docs.slice(0, from).split("\n").length, docs.slice(0, to).split("\n").length - 1],
		text: docs.slice(from, to),
	};
});
const oldText = [docs, example].join("\n");
const revisedText = [...selections.map(({ text }) => text), example].join("\n");
for (const contract of [
	"same operating-system permissions",
	"Only install from sources you trust",
	"Do not start background resources",
	"can deadlock if called from event handlers",
	"When streaming without `deliverAs`, the message is rejected",
	"### pi.registerCommand(name, options)",
	'ctx.ui.notify("Done!", "info")',
	'pi.registerCommand("ask",',
]) {
	assert.ok(revisedText.includes(contract), `Selection lost contract/example: ${contract}`);
}
assert.ok(revisedText.length < oldText.length);
const measure = (text) => ({
	characters: [...text].length,
	estimatedTokens: Math.ceil([...text].length / 4),
	sha256: createHash("sha256").update(text).digest("hex"),
});
console.log(JSON.stringify({
	scenario: "Local TUI /ask command; compare sections with the complete linked send-user-message example",
	tokenEstimate: "ceil(Unicode characters / 4), not a model tokenizer or latency measurement",
	sources: [
		{ path: docsPath, ...measure(docs) },
		{ path: examplePath, ...measure(example) },
	],
	old: { selection: [docsPath, examplePath], ...measure(oldText) },
	revised: {
		selection: [...selections.map(({ text: _text, ...selection }) => selection), { path: examplePath, lines: "all" }],
		...measure(revisedText),
	},
}, null, 2));
