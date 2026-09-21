/*---------------------------------------------------------------------------------------------
 *  Minicode — AI 供应商管理 Webview
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { applyPreset, loadPresets } from './migrateConfig';
import { testOpenAICompatibleConnection, testOllamaConnection } from './modelDiscovery';
import { anthropicMessagesUrl, parseModelNames } from './endpointUrls';
import { notifyMinicodeModelsChanged } from './languageModelProvider';
import { deleteProviderApiKey, readProviderApiKey, saveProviderApiKey } from './providerSecrets';
import {
	getActiveProviderId,
	loadModelRoutes,
	loadStoredProviders,
	removeStoredProvider,
	saveModelRoutes,
	upsertStoredProvider,
	StoredProvider,
} from './providerStore';
import { applyModelRoutes } from './cursorDefaults';
import { primaryModelFromProvider, syncFromStoredProvider } from './providerSync';
import { ProviderPreset } from './types';
import { logWarn } from './logger';

let activePanel: vscode.WebviewPanel | undefined;

/** 仅允许 http/https 外部链接，防止 Webview 触发任意 scheme（file://、命令注入等） */
function isSafeExternalUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

function getHtml(webview: vscode.Webview, extensionPath: string): string {
	const htmlPath = path.join(extensionPath, 'resources', 'provider-workbench.html');
	try {
		const html = fs.readFileSync(htmlPath, 'utf-8');
		return html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
	} catch (err) {
		logWarn('加载 Provider Workbench HTML 资源失败', err);
		return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>`
			+ `<body style="font-family:sans-serif;padding:24px">`
			+ `<h2>AI 供应商管理</h2><p>资源加载失败，请重新编译扩展。</p></body></html>`;
	}
}

function pushState(
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
	presets: ProviderPreset[],
): void {
	panel.webview.postMessage({
		type: 'init',
		providers: loadStoredProviders(context),
		activeId: getActiveProviderId(context),
		presets,
		routes: loadModelRoutes(),
	});
}

async function testProvider(
	provider: StoredProvider,
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
): Promise<void> {
	const apiKey = await readProviderApiKey(context, provider.id);
	if (provider.api_type === 'ollama') {
		const result = await testOllamaConnection(provider.base_url);
		panel.webview.postMessage({
			type: 'testResult',
			id: provider.id,
			ok: result.ok,
			models: result.models,
			latencyMs: result.latencyMs,
			error: result.error,
		});
		return;
	}

	if (provider.api_type === 'anthropic') {
		const started = Date.now();
		try {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				'anthropic-version': '2023-06-01',
			};
			if (apiKey) {
				headers['x-api-key'] = apiKey;
			}
			const model = provider.models[0] || provider.model;
			const response = await fetch(anthropicMessagesUrl(provider.base_url), {
				method: 'POST',
				headers,
				body: JSON.stringify({
					model,
					max_tokens: 1,
					messages: [{ role: 'user', content: 'ping' }],
				}),
				signal: AbortSignal.timeout(15_000),
			});
			panel.webview.postMessage({
				type: 'testResult',
				id: provider.id,
				ok: response.ok,
				models: provider.models,
				latencyMs: Date.now() - started,
				error: response.ok ? undefined : `HTTP ${response.status}`,
			});
		} catch (err) {
			panel.webview.postMessage({
				type: 'testResult',
				id: provider.id,
				ok: false,
				models: provider.models,
				latencyMs: Date.now() - started,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return;
	}

	const result = await testOpenAICompatibleConnection(provider.base_url, apiKey);
	panel.webview.postMessage({
		type: 'testResult',
		id: provider.id,
		ok: result.ok,
		models: result.models,
		latencyMs: result.latencyMs,
		error: result.error,
	});
}

function setupMessageHandler(
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
	presets: ProviderPreset[],
): vscode.Disposable {
	return panel.webview.onDidReceiveMessage(msg => {
		(async () => {
			switch (msg.type) {
				case 'ready':
				case 'refresh':
					pushState(panel, context, presets);
					break;
				case 'activate': {
					const provider = loadStoredProviders(context).find(p => p.id === msg.id);
					if (provider) {
						await context.globalState.update('minicode.activeProviderId', provider.id);
						await syncFromStoredProvider(provider);
						notifyMinicodeModelsChanged();
						vscode.window.showInformationMessage(
							`已将「${provider.name}」设为当前供应商。在 Chat 模型列表中选择 Minicode。`,
						);
					}
					pushState(panel, context, presets);
					break;
				}
				case 'remove': {
					const provider = loadStoredProviders(context).find(p => p.id === msg.id);
					const choice = await vscode.window.showWarningMessage(
						`移除「${provider?.name || '供应商'}」？`,
						{ modal: true },
						'移除',
					);
					if (choice === '移除') {
						await removeStoredProvider(context, msg.id);
						await deleteProviderApiKey(context, msg.id);
						notifyMinicodeModelsChanged();
					}
					pushState(panel, context, presets);
					break;
				}
				case 'test': {
					const provider = loadStoredProviders(context).find(p => p.id === msg.id);
					if (provider) {
						await testProvider(provider, panel, context);
					}
					break;
				}
				case 'addCustom': {
					const name = typeof msg.name === 'string' ? msg.name.trim() : '';
					const baseUrl = typeof msg.baseUrl === 'string' ? msg.baseUrl.trim() : '';
					const models = parseModelNames(typeof msg.modelsText === 'string' ? msg.modelsText : '');
					const apiType = msg.apiType === 'anthropic' ? 'anthropic' : 'openai';
					const category = msg.category === 'local' ? 'local' : 'cloud';
					if (!name || !baseUrl || !models.length) {
						vscode.window.showWarningMessage('请填写名称、base_url，以及至少一个模型名。');
						break;
					}
					const presetId = typeof msg.presetId === 'string' && msg.presetId ? msg.presetId : undefined;
					const id = typeof msg.id === 'string' && msg.id
						? msg.id
						: (presetId ? `minicode-${presetId}` : `minicode-custom-${Date.now()}`);
					const apiKey = typeof msg.apiKey === 'string' ? msg.apiKey : '';
					const needsKey = category === 'cloud';
					if (apiKey.trim()) {
						await saveProviderApiKey(context, id, apiKey);
					}
					const savedKey = await readProviderApiKey(context, id);
					if (needsKey && !savedKey) {
						vscode.window.showWarningMessage('云端供应商需要填写 API Key。');
						break;
					}
					const existing = loadStoredProviders(context).find(p => p.id === id);
					const stored: StoredProvider = {
						id,
						presetId,
						name,
						category,
						api_type: apiType,
						base_url: baseUrl,
						model: models[0],
						models,
						groupName: name,
						needs_api_key: needsKey,
						pendingApiKey: false,
						registeredAt: existing?.registeredAt ?? Date.now(),
					};
					await upsertStoredProvider(context, stored);
					notifyMinicodeModelsChanged();
					await syncFromStoredProvider(stored);
					vscode.window.showInformationMessage(
						`已保存「${name}」（${models.length} 个模型）。Chat 中选择 Minicode / ${models[0]}，无需登录 GitHub。`,
					);
					pushState(panel, context, presets);
					break;
				}
				case 'openManageModels':
					await vscode.commands.executeCommand('github.copilot.chat.openModelPicker');
					break;
				case 'openWebsite':
					if (typeof msg.url === 'string' && isSafeExternalUrl(msg.url)) {
						await vscode.env.openExternal(vscode.Uri.parse(msg.url));
					} else if (msg.url) {
						logWarn(`拒绝打开不安全的 URL: ${String(msg.url)}`);
						vscode.window.showWarningMessage('已阻止打开不受信任的链接（仅允许 http/https）。');
					}
					break;
				case 'fillRoutesFromActive': {
					const activeId = getActiveProviderId(context);
					const provider = loadStoredProviders(context).find(p => p.id === activeId);
					const primary = provider ? primaryModelFromProvider(provider) : undefined;
					if (!primary) {
						vscode.window.showWarningMessage('请先配置并设为当前供应商。');
						break;
					}
					await syncFromStoredProvider(provider!);
					await applyModelRoutes();
					panel.webview.postMessage({
						type: 'routesSaved',
						message: `已用当前供应商主模型「${primary}」填充全部路由`,
					});
					pushState(panel, context, presets);
					break;
				}
				case 'applyPreset': {
					const preset = presets.find(p => p.id === msg.presetId);
					if (preset) {
						let apiKey: string | undefined;
						if (preset.needs_api_key) {
							apiKey = await vscode.window.showInputBox({
								prompt: `${preset.name} API Key（可稍后在 Manage Models 中配置）`,
								password: true,
								ignoreFocusOut: true,
							}) || undefined;
						}
						await applyPreset(preset, apiKey, context);
						pushState(panel, context, presets);
					}
					break;
				}
			case 'saveRoutes': {
				await saveModelRoutes(msg.routes || {});
				await applyModelRoutes();
				panel.webview.postMessage({ type: 'routesSaved', message: '多模型路由已保存并应用' });
				break;
			}
			default:
				logWarn(`Provider Workbench: 未知消息类型 "${(msg as { type?: string }).type}"`, msg);
			}
		})().catch(err => vscode.window.showErrorMessage(`Provider Workbench error: ${err instanceof Error ? err.message : String(err)}`));
	});
}

export function openProviderWorkbench(context: vscode.ExtensionContext): void {
	const presets = loadPresets(context.extensionPath);
	const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

	if (activePanel) {
		activePanel.reveal(column);
		pushState(activePanel, context, presets);
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'minicodeProviderWorkbench',
		'AI 供应商管理',
		column,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	activePanel = panel;
	panel.webview.html = getHtml(panel.webview, context.extensionPath);
	context.subscriptions.push(setupMessageHandler(panel, context, presets));
	panel.onDidDispose(() => {
		activePanel = undefined;
	}, undefined, context.subscriptions);
}
