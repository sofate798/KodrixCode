/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* ------------------------------------------------------------------
 * Kodrix command-contract checker (static, dependency-free).
 *
 * Verifies two contracts that until now were only cross-checked by hand:
 *
 *   A1  every command that an extension *declares* under its own
 *       `kodrix.*` namespace in package.json#contributes.commands also has a
 *       real `registerCommand(...)` call site in that extension's sources.
 *   A2  every command id *referenced* from package.json#contributes.menus /
 *       #contributes.keybindings is either declared by one of the Kodrix
 *       extensions or belongs to an allow-listed foreign namespace.
 *
 * Run with plain node (no npm install):
 *   node .github/workflows/_shared/check-kodrix-command-contract.mjs [--json]
 *
 * Exit codes: 0 = contracts hold, 1 = violation found, 2 = checker itself broke.
 * ------------------------------------------------------------------ */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

const EXTENSIONS = ['kodrix-local', 'kodrix-agent-os', 'kodrix-skills'];
const OWN_NAMESPACE = 'kodrix.';

/** Foreign command namespaces that legitimately appear in menus/keybindings. */
const ALLOWED_FOREIGN_PREFIXES = [
	'workbench.',
	'editor.',
	'vscode.',
	'copyFile',
	'compareFile',
	'deleteFile',
	'explorer.',
	'terminal.',
	'scm.',
	'view.',
	'notebook.',
	'toggle',
	'setContext',
	'runCommands',
	'npm.',
	'git.',
	'simpleBrowser.',
	'application.',
];

const errors = [];
const notes = [];

function fail(file, message, extra = {}) {
	errors.push({ file, message, ...extra });
}

/* ------------------------------------------------------------------ */
/* 1. Collect package.json declarations                               */
/* ------------------------------------------------------------------ */

const declared = new Map();  // commandId -> [{ ext, file }]
const references = [];       // { ext, file, section, id }
const manifests = new Map(); // ext -> package.json

for (const ext of EXTENSIONS) {
	const rel = `extensions/${ext}/package.json`;
	const abs = join(REPO, rel);
	if (!existsSync(abs)) {
		fail(rel, `manifest missing — extension folder ${ext} disappeared?`);
		continue;
	}
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(abs, 'utf8'));
	} catch (e) {
		fail(rel, `manifest is not valid JSON: ${e.message}`);
		continue;
	}
	manifests.set(ext, { pkg, rel, abs });

	for (const cmd of pkg?.contributes?.commands ?? []) {
		const id = typeof cmd.command === 'string' ? cmd.command : undefined;
		if (!id) {
			fail(rel, `contributes.commands entry without a "command" string: ${JSON.stringify(cmd)}`);
			continue;
		}
		if (!declared.has(id)) {
			declared.set(id, []);
		}
		declared.get(id).push({ ext, file: rel });
	}

	const menus = pkg?.contributes?.menus ?? {};
	for (const [location, items] of Object.entries(menus)) {
		if (!Array.isArray(items)) {
			continue;
		}
		for (const item of items) {
			if (typeof item?.command === 'string') {
				references.push({ ext, file: rel, section: `menus.${location}`, id: item.command });
			}
			if (Array.isArray(item?.submenu)) {
				// submenu entries carry their own ids; handled through commandPalette below
				continue;
			}
		}
	}

	for (const kb of pkg?.contributes?.keybindings ?? []) {
		if (typeof kb?.command === 'string') {
			references.push({ ext, file: rel, section: 'keybindings', id: kb.command });
		}
	}
}

/* ------------------------------------------------------------------ */
/* 2. Build an identifier -> command-id map from TypeScript sources   */
/* ------------------------------------------------------------------ */

function* walk(dir) {
	if (!existsSync(dir)) {
		return;
	}
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (entry === 'node_modules' || entry === 'out' || entry === 'out-test' || entry === 'dist') {
				continue;
			}
			yield* walk(full);
		} else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
			yield full;
		}
	}
}

/** Names that must never be treated as registration sites. */
function isTestFile(relPath) {
	return /(^|\/)test\//.test(relPath) || relPath.endsWith('.test.ts');
}

const constMap = new Map();      // 'COMMANDS.foo' | 'FOO' -> command id
const registrationSites = new Map(); // command id -> [{ file, line }]
const allRegisteredIds = new Set();

const OBJECT_CONST_RE = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:{[\s\S]*?}\s*as\s+const|{[\s\S]*?})\s*;/g;
const STRING_CONST_RE = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(['"])((?:[^\\]|\\.)*?)\2/g;
const REGISTER_CALL_RE = /registerCommand[0-9]?\s*\(\s*([^,()]+?)\s*(?:,|\n)/g;

function sourceFiles(ext) {
	const srcDir = join(REPO, 'extensions', ext, 'src');
	if (!existsSync(srcDir)) {
		fail(`extensions/${ext}/src`, 'source directory missing — cannot cross-check registrations');
		return [];
	}
	return [...walk(srcDir)];
}

/* ------------------------------------------------------------------ */
/* 2a. Pass 1: harvest string constants (must happen before pass 2 —  */
/*     constants live in shared/ which sorts after the call sites).    */
/* ------------------------------------------------------------------ */

for (const ext of EXTENSIONS) {
	for (const file of sourceFiles(ext)) {
		const text = readFileSync(file, 'utf8');

		// const NAME = { key: 'value', ... } [as const];
		for (const match of text.matchAll(OBJECT_CONST_RE)) {
			const name = match[1];
			for (const pair of match[0].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(['"])((?:[^\\]|\\.)*?)\2/g)) {
				if (pair[3].includes('.')) {
					constMap.set(`${name}.${pair[1]}`, pair[3]);
				}
			}
		}
		// const NAME = 'value';
		for (const match of text.matchAll(STRING_CONST_RE)) {
			if (match[3].includes('.')) {
				constMap.set(match[1], match[3]);
			}
		}
	}
}

/* ------------------------------------------------------------------ */
/* 2b. Pass 2: collect registerCommand() call sites (non-test files)   */
/* ------------------------------------------------------------------ */

for (const ext of EXTENSIONS) {
	for (const file of sourceFiles(ext)) {
		const relPath = relative(REPO, file).replace(/\\/g, '/');
		if (isTestFile(relPath)) {
			continue;
		}
		const text = readFileSync(file, 'utf8');

		for (const match of text.matchAll(REGISTER_CALL_RE)) {
			const rawArg = match[1].trim();
			const line = text.slice(0, match.index).split('\n').length;
			let id;
			const literal = rawArg.match(/^(['"])((?:[^\\]|\\.)*?)\1$/);
			if (literal) {
				id = literal[2];
			} else {
				const symbolic = rawArg.match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*!?$/);
				if (symbolic) {
					id = constMap.get(symbolic[1]);
				} else {
					const single = rawArg.match(/([A-Za-z_$][\w$]*)\s*!?$/);
					if (single) {
						id = constMap.get(single[1]);
					}
				}
			}
			if (!id) {
				// Dynamic / unresolvable id: keep the raw expression so we can report it.
				notes.push(`${relPath}:${line} registerCommand(<${rawArg}>) — id not statically resolvable`);
				continue;
			}
			allRegisteredIds.add(id);
			if (!registrationSites.has(id)) {
				registrationSites.set(id, []);
			}
			registrationSites.get(id).push({ file: relPath, line });
		}
	}
}

/* ------------------------------------------------------------------ */
/* 3. Contract A1 — declared own-namespace commands must be registered */
/* ------------------------------------------------------------------ */

const declaredCounts = {};
for (const [id, owners] of declared) {
	if (owners.length > 1) {
		// A3: two Kodrix extensions shipping the same id silently shadow each other.
		fail(owners[0].file,
			`command "${id}" is declared by more than one Kodrix extension (${owners.map(o => o.ext).join(', ')}) — the second one never wins`,
			{ ext: owners.map(o => o.ext).join(','), command: id });
	}
	for (const owner of owners) {
		declaredCounts[owner.ext] = (declaredCounts[owner.ext] ?? 0) + 1;
	}
	if (!id.startsWith(OWN_NAMESPACE)) {
		continue; // foreign command declared for palette ordering, not our contract
	}
	if (!allRegisteredIds.has(id)) {
		for (const owner of owners) {
			fail(owner.file,
				`command "${id}" is declared in contributes.commands but has no registerCommand() call site in any Kodrix extension source`,
				{ ext: owner.ext, command: id });
		}
	}
}

/* A4: a command without a title is unopenable from the command palette. */
for (const [ext, manifest] of manifests) {
	for (const cmd of manifest.pkg?.contributes?.commands ?? []) {
		if (typeof cmd.command !== 'string') {
			continue;
		}
		const title = cmd.title ?? cmd.shortTitle;
		if (!title || (typeof title === 'object' && !title.value)) {
			fail(manifest.rel, `command "${cmd.command}" is declared without a title`, { ext });
		}
	}
}

/* ------------------------------------------------------------------ */
/* 4. Contract A2 — referenced commands must be declared or allow-listed */
/* ------------------------------------------------------------------ */

for (const ref of references) {
	if (declared.has(ref.id)) {
		continue;
	}
	if (ALLOWED_FOREIGN_PREFIXES.some(p => ref.id.startsWith(p))) {
		continue;
	}
	fail(ref.file,
		`${ref.section} references command "${ref.id}" which no Kodrix extension declares in contributes.commands`,
		{ ext: ref.ext, command: ref.id, section: ref.section });
}

/* ------------------------------------------------------------------ */
/* 5. Report                                                          */
/* ------------------------------------------------------------------ */

const summary = EXTENSIONS.map(ext => {
	const total = manifests.get(ext)?.pkg?.contributes?.commands?.length ?? 0;
	const own = declaredCounts[ext] ?? 0;
	return { ext, total, own };
});

console.log('Kodrix command contract check');
console.log('=============================');
for (const s of summary) {
	console.log(`  ${s.ext.padEnd(18)} declared=${String(s.total).padStart(3)}  own-namespace (${OWN_NAMESPACE}*)=${s.own}`);
}
console.log(`  registration sites resolved: ${allRegisteredIds.size} distinct command ids`);

if (notes.length) {
	console.log('');
	console.log(`  ${notes.length} registerCommand() call site(s) use a non-static id (not counted, review manually):`);
	for (const note of notes.slice(0, 20)) {
		console.log(`    - ${note}`);
	}
}

if (errors.length) {
	console.error('');
	console.error(`CONTRACT CHECK FAILED — ${errors.length} violation(s):`);
	for (const err of errors) {
		console.error(`  [${err.ext ?? '?'}] ${err.file} :: ${err.message}`);
		if (process.env.GITHUB_ACTIONS) {
			console.log(`::error file=${err.file},title=Kodrix command contract::${err.message}`);
		}
	}
	if (process.env.KODRIX_CONTRACT_JSON) {
		console.log(JSON.stringify({ errors, summary }, null, 2));
	}
	process.exit(1);
}

console.log('');
console.log(`PASS — every declared ${OWN_NAMESPACE}* command has a registerCommand() site and every menu/keybinding reference resolves.`);
