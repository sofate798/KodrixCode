/*---------------------------------------------------------------------------------------------
 *  供应商 API Key — 存在扩展 SecretStorage，不写进 settings.json
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export function apiKeySecretId(providerId: string): string {
	return `minicode.apiKey.${providerId}`;
}

export async function saveProviderApiKey(
	context: vscode.ExtensionContext,
	providerId: string,
	apiKey: string | undefined,
): Promise<void> {
	const key = apiKey?.trim();
	if (!key) {
		return;
	}
	await context.secrets.store(apiKeySecretId(providerId), key);
}

export async function readProviderApiKey(
	context: vscode.ExtensionContext,
	providerId: string,
): Promise<string | undefined> {
	const key = await context.secrets.get(apiKeySecretId(providerId));
	return key?.trim() || undefined;
}

export async function deleteProviderApiKey(
	context: vscode.ExtensionContext,
	providerId: string,
): Promise<void> {
	await context.secrets.delete(apiKeySecretId(providerId));
}
