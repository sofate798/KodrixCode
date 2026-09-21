// Restore the fixed policy-watcher shim (native binding is ABI-incompatible).
import fs from 'node:fs';
const p = 'D:/minicode/node_modules/@vscode/policy-watcher/index.js';
const shim = `/*---------------------------------------------------------------------------------------------
 *  Minicode Dev Shim — Mock @vscode/policy-watcher (native binding unavailable or ABI-incompatible)
 *  FIXED: immediately signals an initial (empty) update so NativePolicyService's
 *  first-update await resolves instead of stalling main-process startup.
 *--------------------------------------------------------------------------------------------*/

function createWatcher(productName, definitions, callback, options) {
	callback({});
	return {
		dispose() {
			// no-op cleanup
		}
	};
}

module.exports = { createWatcher };
`;
fs.writeFileSync(p, shim);
console.log('policy-watcher/index.js restored to fixed shim');
