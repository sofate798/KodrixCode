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

/** Minimal complete defaultChatAgent — empty providerScopes breaks GitHub sign-in. */
const DEFAULT_CHAT_AGENT = {
	extensionId: 'GitHub.copilot',
	chatExtensionId: 'GitHub.copilot-chat',
	chatExtensionOutputId: 'GitHub.copilot-chat.GitHub Copilot Chat.log',
	chatExtensionOutputExtensionStateCommand: 'github.copilot.debug.extensionState',
	documentationUrl: 'https://aka.ms/github-copilot-overview',
	termsStatementUrl: 'https://aka.ms/github-copilot-terms-statement',
	privacyStatementUrl: 'https://aka.ms/github-copilot-privacy-statement',
	skusDocumentationUrl: 'https://aka.ms/github-copilot-plans',
	publicCodeMatchesUrl: 'https://aka.ms/github-copilot-match-public-code',
	managePlanUrl: 'https://aka.ms/github-copilot-manage-plan',
	upgradePlanUrl: 'https://aka.ms/github-copilot-upgrade-plan',
	signUpUrl: 'https://aka.ms/github-sign-up',
	provider: {
		default: { id: 'github', name: 'GitHub' },
		enterprise: { id: 'github-enterprise', name: 'GitHub Enterprise' },
		google: { id: 'google', name: 'Google' },
		apple: { id: 'apple', name: 'Apple' },
		microsoft: { id: 'microsoft', name: 'Microsoft' },
	},
	providerExtensionId: 'vscode.github-authentication',
	providerUriSetting: 'github-enterprise.uri',
	providerScopes: [
		['read:user', 'user:email', 'repo', 'workflow'],
		['user:email'],
		['read:user'],
	],
	entitlementUrl: 'https://api.github.com/copilot_internal/user',
	entitlementSignupLimitedUrl: 'https://api.github.com/copilot_internal/subscribe_limited_user',
	tokenEntitlementUrl: 'https://api.github.com/copilot_internal/v2/token',
	mcpRegistryDataUrl: 'https://api.github.com/copilot/mcp_registry',
	managedSettingsUrl: 'https://api.github.com/copilot_internal/managed_settings',
	chatQuotaExceededContext: 'github.copilot.chat.quotaExceeded',
	completionsQuotaExceededContext: 'github.copilot.completions.quotaExceeded',
	walkthroughCommand: 'github.copilot.open.walkthrough',
	completionsMenuCommand: 'github.copilot.toggleStatusMenu',
	chatRefreshTokenCommand: 'github.copilot.refreshToken',
	generateCommitMessageCommand: 'github.copilot.git.generateCommitMessage',
	resolveMergeConflictsCommand: 'github.copilot.git.resolveMergeConflicts',
	completionsAdvancedSetting: 'github.copilot.advanced',
	completionsEnablementSetting: 'github.copilot.enable',
	nextEditSuggestionsSetting: 'github.copilot.nextEditSuggestions.enabled',
};

const TRUSTED_EXTENSION_AUTH_ACCESS = {
	github: ['GitHub.copilot-chat', 'GitHub.copilot', 'GitHub.copilot-nightly'],
	'github-enterprise': ['GitHub.copilot-chat', 'GitHub.copilot', 'GitHub.copilot-nightly'],
	microsoft: ['vscode.github-authentication'],
};

/** Open VSX — required for Extensions view search/install in OSS forks. */
const OPEN_VSX_GALLERY = {
	serviceUrl: 'https://open-vsx.org/vscode/gallery',
	itemUrl: 'https://open-vsx.org/vscode/item',
	latestUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest',
	resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
	extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest',
	controlUrl: 'https://raw.githubusercontent.com/EclipseFdn/publish-extensions/refs/heads/master/extension-control/extensions.json',
	nlsBaseUrl: '',
};

let changed = false;

const scopesOk = Array.isArray(j.defaultChatAgent?.providerScopes)
	&& j.defaultChatAgent.providerScopes.length > 0
	&& Array.isArray(j.defaultChatAgent.providerScopes[0])
	&& j.defaultChatAgent.providerScopes[0].length > 0;

if (!j.defaultChatAgent || !scopesOk || !j.defaultChatAgent.entitlementUrl || !j.defaultChatAgent.tokenEntitlementUrl) {
	j.defaultChatAgent = { ...DEFAULT_CHAT_AGENT, ...j.defaultChatAgent, providerScopes: DEFAULT_CHAT_AGENT.providerScopes };
	// Ensure critical URL/scope fields are never left empty by a partial merge
	j.defaultChatAgent.providerScopes = DEFAULT_CHAT_AGENT.providerScopes;
	j.defaultChatAgent.entitlementUrl ??= DEFAULT_CHAT_AGENT.entitlementUrl;
	j.defaultChatAgent.tokenEntitlementUrl ??= DEFAULT_CHAT_AGENT.tokenEntitlementUrl;
	j.defaultChatAgent.entitlementSignupLimitedUrl ??= DEFAULT_CHAT_AGENT.entitlementSignupLimitedUrl;
	j.defaultChatAgent.mcpRegistryDataUrl ??= DEFAULT_CHAT_AGENT.mcpRegistryDataUrl;
	j.defaultChatAgent.managedSettingsUrl ??= DEFAULT_CHAT_AGENT.managedSettingsUrl;
	j.defaultChatAgent.providerExtensionId ??= DEFAULT_CHAT_AGENT.providerExtensionId;
	j.defaultChatAgent.completionsEnablementSetting ??= DEFAULT_CHAT_AGENT.completionsEnablementSetting;
	j.defaultChatAgent.chatRefreshTokenCommand ??= DEFAULT_CHAT_AGENT.chatRefreshTokenCommand;
	changed = true;
	console.log('FIXED defaultChatAgent (scopes + entitlement URLs)');
} else {
	console.log('defaultChatAgent OK');
}

if (!j.trustedExtensionAuthAccess) {
	j.trustedExtensionAuthAccess = TRUSTED_EXTENSION_AUTH_ACCESS;
	changed = true;
	console.log('ADDED trustedExtensionAuthAccess');
} else {
	console.log('trustedExtensionAuthAccess OK');
}

if (!j.extensionsGallery?.serviceUrl) {
	j.extensionsGallery = { ...OPEN_VSX_GALLERY, ...j.extensionsGallery };
	changed = true;
	console.log('ADDED extensionsGallery (Open VSX)');
} else {
	console.log('extensionsGallery OK');
}

const trustedDomains = Array.isArray(j.linkProtectionTrustedDomains) ? j.linkProtectionTrustedDomains : [];
if (!trustedDomains.includes('https://open-vsx.org')) {
	j.linkProtectionTrustedDomains = [...trustedDomains, 'https://open-vsx.org'];
	changed = true;
	console.log('ADDED open-vsx.org to linkProtectionTrustedDomains');
} else {
	console.log('linkProtectionTrustedDomains OK');
}

const autoUpdates = Array.isArray(j.builtInExtensionsEnabledWithAutoUpdates)
	? j.builtInExtensionsEnabledWithAutoUpdates
	: [];
if (!autoUpdates.some(id => String(id).toLowerCase() === 'github.copilot-chat')) {
	j.builtInExtensionsEnabledWithAutoUpdates = [...autoUpdates, 'GitHub.copilot-chat'];
	changed = true;
	console.log('ADDED GitHub.copilot-chat to builtInExtensionsEnabledWithAutoUpdates');
} else {
	console.log('builtInExtensionsEnabledWithAutoUpdates OK');
}

if (changed) {
	fs.writeFileSync(p, JSON.stringify(j, null, '\t') + '\n');
}

const chk = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log('providerScopes[0] =', JSON.stringify(chk.defaultChatAgent?.providerScopes?.[0]));
console.log('entitlementUrl =', chk.defaultChatAgent?.entitlementUrl);
console.log('trustedExtensionAuthAccess.github =', chk.trustedExtensionAuthAccess?.github);
