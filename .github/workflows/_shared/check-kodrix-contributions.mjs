/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* ------------------------------------------------------------------
 * Kodrix contribution-point contract checker (static, dependency-free).
 *
 * Second layer of the nightly gate: everything the three Kodrix
 * extensions *declare* in package.json#contributes that is backed by a
 * runtime provider must still be referenced by shipped (non-test)
 * sources, and every declared proposed API must still exist in this
 * fork's proposal registry.
 *
 * Rationale: a drift here does not fail any existing test — the mock
 * harness never reads these contribution points — and in a real build
 * the extension simply stops contributing the view / settings page /
 * chat participant, silently.
 *
 * Run with plain node (no npm install):
 *   node .github/workflows/_shared/check-kodrix-contributions.mjs
 *
 * Exit codes: 0 = contracts hold, 1 = violation found, 2 = checker broke.
 * ------------------------------------------------------------------ */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

const EXTENSIONS = ['kodrix-local', 'kodrix-agent-os', 'kodrix-skills'];
const PROPOSAL_REGISTRY = 'src/vs/platform/extensions/common/extensionsApiProposals.ts';
const BUILTIN_VIEW_CONTAINERS = ['explorer', 'scm', 'debug', 'test', 'remote'];

const errors = [];
const checked = [];

function fail(file, message, extra = {}) {
	errors.push({ file, message, ...extra });
}

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

function isTestFile(relPath) {
	return /(^|\/)test\//.test(relPath) || relPath.endsWith('.test.ts');
}

/** Every string literal used in shipped sources of one extension. */
function shippedStringLiterals(ext) {
	const literals = new Set();
	const srcDir = join(REPO, 'extensions', ext, 'src');
	if (!existsSync(srcDir)) {
		fail(`extensions/${ext}/src`, 'source directory missing — cannot verify contribution points');
		return literals;
	}
	for (const file of walk(srcDir)) {
		const relPath = relative(REPO, file).replace(/\\/g, '/');
		if (isTestFile(relPath)) {
			continue;
		}
		const text = readFileSync(file, 'utf8');
		for (const match of text.matchAll(/(['"])((?:[^\\]|\\.)*?)\1/g)) {
			literals.add(match[2]);
		}
	}
	return literals;
}

/* ------------------------------------------------------------------ */
/* Proposal registry of this fork                                     */
/* ------------------------------------------------------------------ */

const knownProposals = new Set();
{
	const abs = join(REPO, PROPOSAL_REGISTRY);
	if (!existsSync(abs)) {
		fail(PROPOSAL_REGISTRY, 'proposal registry missing — cannot verify enabledApiProposals');
	} else {
		const text = readFileSync(abs, 'utf8');
		for (const match of text.matchAll(/^\t([A-Za-z][\w]*):\s*\{/gm)) {
			knownProposals.add(match[1]);
		}
	}
}

/* ------------------------------------------------------------------ */
/* Per-extension checks                                               */
/* ------------------------------------------------------------------ */

for (const ext of EXTENSIONS) {
	const rel = `extensions/${ext}/package.json`;
	const abs = join(REPO, rel);
	if (!existsSync(abs)) {
		fail(rel, 'manifest missing');
		continue;
	}
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(abs, 'utf8'));
	} catch (e) {
		fail(rel, `manifest is not valid JSON: ${e.message}`);
		continue;
	}

	const literals = shippedStringLiterals(ext);
	let extChecked = 0;

	const requireLiteral = (kind, id) => {
		if (typeof id !== 'string' || id.length === 0) {
			fail(rel, `${kind} entry without an id/viewType`);
			return;
		}
		extChecked++;
		if (!literals.has(id)) {
			fail(rel,
				`${kind} "${id}" is declared in package.json but the string never appears in shipped sources of ${ext} — in a real build this contribution silently stops working`,
				{ ext, kind, id });
		}
	};

	// 1. proposed APIs must exist in this fork's registry
	for (const proposal of pkg.enabledApiProposals ?? []) {
		extChecked++;
		if (!knownProposals.has(proposal)) {
			fail(rel,
				`enabledApiProposals declares "${proposal}" which is not in ${PROPOSAL_REGISTRY} — the extension host will refuse to activate ${ext}`,
				{ ext, proposal });
		}
	}

	// 2. contribution points backed by a runtime provider
	for (const renderer of pkg.contributes?.settingsEditorRenderers ?? []) {
		requireLiteral('settingsEditorRenderers.viewType', renderer.viewType);
	}
	for (const participant of pkg.contributes?.chatParticipants ?? []) {
		requireLiteral('chatParticipants.id', participant.id);
	}
	for (const provider of pkg.contributes?.languageModelChatProviders ?? []) {
		requireLiteral('languageModelChatProviders.vendor', provider.vendor);
	}

	// 3. views: the container must exist (builtin or declared) and the view id must be implemented
	const declaredContainers = new Set(BUILTIN_VIEW_CONTAINERS);
	for (const items of Object.values(pkg.contributes?.viewsContainers ?? {})) {
		for (const container of items ?? []) {
			declaredContainers.add(container.id);
		}
	}
	for (const [container, views] of Object.entries(pkg.contributes?.views ?? {})) {
		extChecked++;
		if (!declaredContainers.has(container)) {
			fail(rel,
				`contributes.views targets container "${container}" which is neither a built-in container nor declared in contributes.viewsContainers`,
				{ ext, container });
		}
		for (const view of views ?? []) {
			requireLiteral(`contributes.views.${container}`, view.id);
		}
	}

	checked.push({ ext, checks: extChecked });
}

/* ------------------------------------------------------------------ */
/* Report                                                             */
/* ------------------------------------------------------------------ */

console.log('Kodrix contribution-point contract check');
console.log('========================================');
console.log(`  fork proposal registry entries: ${knownProposals.size}`);
for (const c of checked) {
	console.log(`  ${c.ext.padEnd(18)} contribution references verified: ${c.checks}`);
}

if (errors.length) {
	console.error('');
	console.error(`CONTRIBUTION CHECK FAILED — ${errors.length} violation(s):`);
	for (const err of errors) {
		console.error(`  [${err.ext ?? '?'}] ${err.file} :: ${err.message}`);
	}
	if (process.env.GITHUB_ACTIONS) {
		for (const err of errors) {
			console.log(`::error file=${err.file},title=Kodrix contribution contract::${err.message}`);
		}
	}
	process.exit(1);
}

console.log('');
console.log('PASS — declared proposed APIs exist in the fork and every provider-backed contribution is still referenced by shipped sources.');
