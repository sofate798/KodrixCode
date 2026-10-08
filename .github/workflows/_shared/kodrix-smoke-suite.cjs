/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* ------------------------------------------------------------------
 * Kodrix workbench smoke suite — loaded by a REAL VS Code extension
 * host through `--extensionTestsPath`. Plain CommonJS on purpose: it
 * must not depend on mocha, on the repo's build graph, or on
 * src/test/vscode-mock.ts.
 *
 * Contract of `run()`: resolve ⇒ pass, throw ⇒ the host exits non-zero
 * and the driver reports a failure for this layer.
 * ------------------------------------------------------------------ */

'use strict';

const vscode = require('vscode');

const LAYER = 'LAYER=workbench-smoke';
const EXTENSION_ID = process.env.KODRIX_SMOKE_EXTENSION_ID;
const EXPECTED = JSON.parse(process.env.KODRIX_SMOKE_EXPECTED_COMMANDS || '[]');

function assert(condition, message) {
	if (!condition) {
		throw new Error(`${LAYER} ${message}`);
	}
}

async function waitFor(predicate, timeoutMs, what) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		try {
			last = await predicate();
			if (last) {
				return last;
			}
		} catch (error) {
			last = error;
		}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error(`${LAYER} timed out after ${timeoutMs}ms waiting for ${what} (last value: ${String(last && last.message ? last.message : last)})`);
}

async function run() {
	assert(typeof vscode !== 'undefined' && vscode, 'vscode API object was not provided by the host');
	assert(EXTENSION_ID, 'KODRIX_SMOKE_EXTENSION_ID is not set');
	assert(EXPECTED.length > 0, 'KODRIX_SMOKE_EXPECTED_COMMANDS is empty');

	// 1. The main process produced a real window and a live extension host.
	console.log(`${LAYER} host app     : ${vscode.env.appName} ${vscode.version} (${vscode.env.appHost})`);
	assert(!!vscode.version, 'extension host reports no vscode.version — workbench did not really start');

	// 2. The extension was scanned from its own manifest, not from a stub.
	const extension = await waitFor(
		() => vscode.extensions.getExtension(EXTENSION_ID),
		20_000,
		`${EXTENSION_ID} to appear in vscode.extensions`
	);
	console.log(`${LAYER} scanned      : ${extension.id} v${extension.packageJSON.version} (bundled=${extension.extensionKind === vscode.ExtensionKind.UI})`);

	// 3. It activates for real.
	await extension.activate();
	assert(extension.isActive, `${EXTENSION_ID} reported isActive=false after activate() resolved`);
	console.log(`${LAYER} activated    : yes`);

	// 4. Every command the manifest declares is present in the live registry.
	const live = new Set(await vscode.commands.getCommands(true));
	const missing = EXPECTED.filter(command => !live.has(command));
	console.log(`${LAYER} registry     : ${live.size} commands visible, checking ${EXPECTED.length} declared by ${EXTENSION_ID}`);
	if (missing.length) {
		throw new Error(`${LAYER} ${missing.length}/${EXPECTED.length} declared commands are missing from the real command registry: ${missing.join(', ')}`);
	}

	// Note: we deliberately do NOT executeCommand() anything here. Several
	// Kodrix commands open modal input boxes and would block the host until
	// the job times out; registry membership + a successful activate() is the
	// part that a mock harness cannot fake.

	if (process.env.KODRIX_SMOKE_RESULT_FILE) {
		require('fs').writeFileSync(process.env.KODRIX_SMOKE_RESULT_FILE, JSON.stringify({
			extensionId: EXTENSION_ID,
			appName: vscode.env.appName,
			vscodeVersion: vscode.version,
			registryCommands: live.size,
			checkedCommands: EXPECTED.length,
		}, null, 2));
	}

	console.log(`${LAYER} suite        : all assertions passed`);
}

exports.run = run;
