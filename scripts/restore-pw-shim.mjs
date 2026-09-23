/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Restore the fixed policy-watcher shim (native binding is ABI-incompatible).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = path.join(root, 'node_modules/@vscode/policy-watcher/index.js');
const shim = `/*---------------------------------------------------------------------------------------------
 *  Kodrix Dev Shim — Mock @vscode/policy-watcher (native binding unavailable or ABI-incompatible)
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
console.log('policy-watcher/index.js restored to fixed shim →', p);
