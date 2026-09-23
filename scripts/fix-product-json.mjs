/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = path.join(root, 'product.json');
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
if (!j.defaultChatAgent) {
	j.defaultChatAgent = {
		extensionId: 'GitHub.copilot',
		chatExtensionId: 'GitHub.copilot-chat',
		provider: {
			default: { id: 'github', name: 'GitHub' },
			enterprise: { id: 'github-enterprise', name: 'GitHub Enterprise' }
		},
		providerScopes: []
	};
	fs.writeFileSync(p, JSON.stringify(j, null, '\t') + '\n');
	console.log('ADDED defaultChatAgent');
} else {
	console.log('already exists');
}
const chk = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log('defaultChatAgent.extensionId =', chk.defaultChatAgent?.extensionId);
