import fs from 'node:fs';
const p = 'D:/minicode/product.json';
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
