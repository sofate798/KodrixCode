/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Copy official VS Code compiled .node binaries into Kodrix's node_modules.
// SRC: VSCODE_UNPACKED_NODE_MODULES env, or first CLI arg.
// Does NOT rewrite policy-watcher/index.js — keep restore-pw-shim.mjs (ABI shim).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.VSCODE_UNPACKED_NODE_MODULES
	|| process.argv[2]
	|| 'D:/Program/Microsoft VS Code/7debcd0e2a/resources/app/node_modules.asar.unpacked/@vscode';
const DST = path.join(root, 'node_modules/@vscode');

const files = {
	'deviceid/build/Release/windows.node': 'deviceid/build/Release/windows.node',
	'native-watchdog/build/Release/watchdog.node': 'native-watchdog/build/Release/watchdog.node',
	'policy-watcher/build/Release/vscode-policy-watcher.node': 'policy-watcher/build/Release/vscode-policy-watcher.node',
	'spdlog/build/Release/spdlog.node': 'spdlog/build/Release/spdlog.node',
	'sqlite3/build/Release/vscode-sqlite3.node': 'sqlite3/build/Release/vscode-sqlite3.node',
	'windows-ca-certs/build/Release/crypt32.node': 'windows-ca-certs/build/Release/crypt32.node',
	'windows-mutex/build/Release/CreateMutex.node': 'windows-mutex/build/Release/CreateMutex.node',
	'windows-process-tree/build/Release/windows_process_tree.node': 'windows-process-tree/build/Release/windows_process_tree.node',
	'windows-registry/build/Release/winregistry.node': 'windows-registry/build/Release/winregistry.node',
};

console.log('SRC=', SRC);
console.log('DST=', DST);

for (const [relSrc, relDst] of Object.entries(files)) {
	const s = path.join(SRC, relSrc);
	const d = path.join(DST, relDst);
	if (!fs.existsSync(s)) { console.log('SRC MISS:', relSrc); continue; }
	fs.mkdirSync(path.dirname(d), { recursive: true });
	fs.copyFileSync(s, d);
	console.log('COPIED', relDst, fs.statSync(d).size, 'bytes');
}

console.log('Done (.node only; policy-watcher index.js left untouched — use restore-pw-shim.mjs)');
