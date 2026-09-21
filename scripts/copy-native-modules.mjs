// Copy official VS Code compiled .node binaries into Minicode's node_modules
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'D:/Program/Microsoft VS Code/7debcd0e2a/resources/app/node_modules.asar.unpacked/@vscode';
const DST = 'D:/minicode/node_modules/@vscode';

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

for (const [relSrc, relDst] of Object.entries(files)) {
  const s = path.join(SRC, relSrc);
  const d = path.join(DST, relDst);
  if (!fs.existsSync(s)) { console.log('SRC MISS:', relSrc); continue; }
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(s, d);
  console.log('COPIED', relDst, fs.statSync(d).size, 'bytes');
}

// Restore policy-watcher index.js to load the native binding
const pwIndex = path.join(DST, 'policy-watcher/index.js');
const nativeLoader = `/*---------------------------------------------------------------------------------------------
 *  Minicode fix: load the native @vscode/policy-watcher binding (compiled binary
 *  restored from a matching VS Code distribution).
 *--------------------------------------------------------------------------------------------*/
'use strict';

const bindings = require('bindings');
const { createWatcher } = bindings('vscode-policy-watcher');

module.exports = { createWatcher };
`;
fs.writeFileSync(pwIndex, nativeLoader);
console.log('RESTORED policy-watcher/index.js to native loader');
