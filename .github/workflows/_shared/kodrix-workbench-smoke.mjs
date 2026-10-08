/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* ------------------------------------------------------------------
 * Kodrix workbench smoke driver (nightly, best-effort layer).
 *
 * What this proves that the hand-written `vscode-mock` harness cannot:
 * a genuine VS Code main process boots a real workbench window, a real
 * extension host starts, the extension is *scanned* from its manifest
 * and activated, and its commands land in the real command registry.
 *
 * What this deliberately does NOT try to prove: activation of
 * `kodrix-local` / `kodrix-agent-os`. They declare proposed APIs
 * (`settingsEditorRenderer`, `chatContextProvider`), and proposed APIs
 * are unavailable on a publicly downloadable (stable) VS Code, so those
 * two can only be smoke-tested against a build of this fork — a 30–90
 * min compile that does not belong in this layer. Their manifests are
 * covered statically by check-kodrix-command-contract.mjs and
 * check-kodrix-contributions.mjs instead. Set
 * KODRIX_SMOKE_INCLUDE_PROPOSED=1 to additionally load them as
 * informational (never asserted) dev paths.
 *
 * Expected environment (set by .github/workflows/nightly.yml):
 *   KODRIX_TEST_ELECTRON_ENTRY   absolute path to a require()-able
 *                                @vscode/test-electron entry (CJS)
 *   KODRIX_SMOKE_EXTENSIONS      comma separated extension folder names,
 *                                first one is the asserted target
 *   KODRIX_SMOKE_RESULT_FILE     optional path for a machine readable summary
 *
 * Exit codes: 0 ok, 1 smoke failed, 2 harness/setup could not even start.
 * ------------------------------------------------------------------ */

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const require = createRequire(import.meta.url);

const LAYER = 'LAYER=workbench-smoke';

function die(code, message) {
	console.error(`${LAYER} ${message}`);
	process.exit(code);
}

const entry = process.env.KODRIX_TEST_ELECTRON_ENTRY;
if (!entry) {
	die(2, 'KODRIX_TEST_ELECTRON_ENTRY is not set — the job did not install @vscode/test-electron');
}

let runTests;
try {
	({ runTests } = require(entry));
} catch (error) {
	die(2, `could not require @vscode/test-electron from ${entry}: ${error.message}`);
}

const extensionNames = (process.env.KODRIX_SMOKE_EXTENSIONS || 'kodrix-skills')
	.split(',')
	.map(name => name.trim())
	.filter(Boolean);

if (extensionNames.length === 0) {
	die(2, 'KODRIX_SMOKE_EXTENSIONS is empty');
}

const target = extensionNames[0];
const targetDir = join(REPO, 'extensions', target);

let manifest;
try {
	manifest = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8'));
} catch (error) {
	die(2, `cannot read extensions/${target}/package.json: ${error.message}`);
}

const declaredCommands = (manifest.contributes?.commands ?? [])
	.map(command => command.command)
	.filter(Boolean);

if (declaredCommands.length === 0) {
	die(2, `extensions/${target} declares no commands — nothing to assert`);
}

const extensionId = `${manifest.publisher}.${manifest.name}`;
const mainEntry = join(targetDir, `${(manifest.main ?? './out/extension').replace(/^\.\//, '')}.js`);

try {
	require.resolve(mainEntry);
} catch {
	die(2, `${target} is not compiled: ${mainEntry} is missing (the smoke job must compile the extension first)`);
}

const suitePath = join(HERE, 'kodrix-smoke-suite.cjs');
const userDataDir = join(tmpdir(), `kodrix-smoke-userdata-${process.pid}`);
const workspaceDir = join(tmpdir(), `kodrix-smoke-workspace-${process.pid}`);
mkdirSync(workspaceDir, { recursive: true });
const launchArgs = [
	'--extensionDevelopmentPath=' + targetDir,
	'--disable-extensions',
	'--disable-workspace-trust',
	'--disable-updates',
	'--disable-telemetry',
	'--skip-welcome',
	'--skip-release-notes',
	'--no-cached-data',
	'--use-inmemory-secretstorage',
	'--disable-gpu',
	'--no-sandbox',
	'--user-data-dir=' + userDataDir,
	workspaceDir,
];

if (process.env.KODRIX_SMOKE_LOGS_PATH) {
	launchArgs.push(`--logsPath=${process.env.KODRIX_SMOKE_LOGS_PATH}`);
}

if (process.env.KODRIX_SMOKE_INCLUDE_PROPOSED === '1') {
	for (const name of extensionNames.slice(1)) {
		launchArgs.splice(0, 0, `--extensionDevelopmentPath=${join(REPO, 'extensions', name)}`);
	}
	console.log(`${LAYER} extra dev paths enabled (informational only, never asserted): ${extensionNames.slice(1).join(', ')}`);
}

console.log(`${LAYER} target extension      : ${extensionId} (from extensions/${target})`);
console.log(`${LAYER} declared commands     : ${declaredCommands.length}`);
console.log(`${LAYER} booting a real workbench (downloads VS Code stable on first run, ~1-2 min)`);

let exitCode;
try {
	exitCode = await runTests({
		version: process.env.KODRIX_SMOKE_VSCODE_VERSION || 'stable',
		extensionDevelopmentPath: targetDir,
		extensionTestsPath: suitePath,
		launchArgs,
		extensionTestsEnv: {
			...process.env,
			KODRIX_SMOKE_EXTENSION_ID: extensionId,
			KODRIX_SMOKE_EXPECTED_COMMANDS: JSON.stringify(declaredCommands),
			KODRIX_SMOKE_RESULT_FILE: process.env.KODRIX_SMOKE_RESULT_FILE || '',
		},
	});
} catch (error) {
	die(1, `workbench run failed: ${error?.message ?? error}`);
}

if (typeof exitCode === 'number' && exitCode !== 0) {
	die(1, `workbench run exited with code ${exitCode}`);
}

console.log(`${LAYER} PASS — real workbench booted, ${extensionId} activated inside a genuine extension host and its commands resolved from the live command registry.`);
