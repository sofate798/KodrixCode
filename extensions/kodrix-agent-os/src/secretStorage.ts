/*---------------------------------------------------------------------------------------------
 *  Agent OS API Key 安全存储 — 通过 VS Code SecretStorage 存取，不写入 settings.json
 *
 *  迁移目标：kodrix.tabCompletion.fimApiKey / kodrix.semanticEmbedding.apiKey
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** FIM 补全 API Key 的 SecretStorage 键名 */
export const FIM_API_KEY_SECRET = 'kodrix.agent-os.tabCompletion.fimApiKey';

/** 语义检索 Embedding API Key 的 SecretStorage 键名 */
export const EMBEDDING_API_KEY_SECRET = 'kodrix.agent-os.semanticEmbedding.apiKey';

/** 从 SecretStorage 读取 FIM API Key */
export async function getFimApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	const key = await context.secrets.get(FIM_API_KEY_SECRET);
	return key?.trim() || undefined;
}

/** 存储 FIM API Key 到 SecretStorage（传 undefined 则删除） */
export async function setFimApiKey(context: vscode.ExtensionContext, apiKey: string | undefined): Promise<void> {
	const trimmed = apiKey?.trim();
	if (trimmed) {
		await context.secrets.store(FIM_API_KEY_SECRET, trimmed);
	} else {
		await context.secrets.delete(FIM_API_KEY_SECRET);
	}
}

/** 从 SecretStorage 读取 Embedding API Key */
export async function getEmbeddingApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	const key = await context.secrets.get(EMBEDDING_API_KEY_SECRET);
	return key?.trim() || undefined;
}

/** 存储 Embedding API Key 到 SecretStorage（传 undefined 则删除） */
export async function setEmbeddingApiKey(context: vscode.ExtensionContext, apiKey: string | undefined): Promise<void> {
	const trimmed = apiKey?.trim();
	if (trimmed) {
		await context.secrets.store(EMBEDDING_API_KEY_SECRET, trimmed);
	} else {
		await context.secrets.delete(EMBEDDING_API_KEY_SECRET);
	}
}
