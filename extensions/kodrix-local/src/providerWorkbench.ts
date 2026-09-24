/*---------------------------------------------------------------------------------------------
 *  Kodrix — AI 供应商管理 Webview
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { applyPreset, loadPresets } from './migrateConfig';
import { testOpenAICompatibleConnection, testOllamaConnection } from './modelDiscovery';
import { anthropicMessagesUrl, parseModelNames } from './endpointUrls';
import { notifyKodrixModelsChanged } from './languageModelProvider';
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
	const resourcesDir = path.join(extensionPath, 'resources');
	const htmlPath = path.join(resourcesDir, 'provider-workbench.html');
	try {
		const html = fs.readFileSync(htmlPath, 'utf-8');
		const codiconsCssUri = webview.asWebviewUri(
			vscode.Uri.file(path.join(resourcesDir, 'codicons', 'codicon.css')),
		);
		return html
			.replace(/\{\{cspSource\}\}/g, webview.cspSource)
			.replace(/\{\{codiconsCssUri\}\}/g, codiconsCssUri.toString());
	} catch (err) {
		logWarn('加载 Provider Workbench HTML 资源失败', err);
		return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>`
			+ `<body style="font-family:sans-serif;padding:24px">`
			+ `<h2>AI 供应商管理</h2><p>资源加载失败，请重新编译扩展。</p></body></html>`;
	}
}

function webviewOptions(extensionPath: string): vscode.WebviewOptions & vscode.WebviewPanelOptions {
	return {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [vscode.Uri.file(path.join(extensionPath, 'resources'))],
	};
}

function pushState(
	webview: vscode.Webview,
	context: vscode.ExtensionContext,
	presets: ProviderPreset[],
): void {
	webview.postMessage({
		type: 'init',
		providers: loadStoredProviders(context),
		activeId: getActiveProviderId(context),
		presets,
		routes: loadModelRoutes(),
	});
}

async function testProvider(
	provider: StoredProvider,
	webview: vscode.Webview,
	context: vscode.ExtensionContext,
): Promise<void> {
	const apiKey = await readProviderApiKey(context, provider.id);
	if (provider.api_type === 'ollama') {
		const result = await testOllamaConnection(provider.base_url);
		webview.postMessage({
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
			webview.postMessage({
				type: 'testResult',
				id: provider.id,
				ok: response.ok,
				models: provider.models,
				latencyMs: Date.now() - started,
				error: response.ok ? undefined : `HTTP ${response.status}`,
			});
		} catch (err) {
			webview.postMessage({
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
	webview.postMessage({
		type: 'testResult',
		id: provider.id,
		ok: result.ok,
		models: result.models,
		latencyMs: result.latencyMs,
		error: result.error,
	});
}

function setupMessageHandler(
	webview: vscode.Webview,
	context: vscode.ExtensionContext,
	presets: ProviderPreset[],
): vscode.Disposable {
	return webview.onDidReceiveMessage(msg => {
		(async () => {
			switch (msg.type) {
				case 'ready':
				case 'refresh':
					pushState(webview, context, presets);
					break;
				case 'activate': {
					const provider = loadStoredProviders(context).find(p => p.id === msg.id);
					if (provider) {
						await context.globalState.update('kodrix.activeProviderId', provider.id);
						await syncFromStoredProvider(provider);
						notifyKodrixModelsChanged();
						vscode.window.showInformationMessage(
							`已将「${provider.name}」设为当前供应商。在 Chat 模型列表中选择 Kodrix。`,
						);
					}
					pushState(webview, context, presets);
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
						notifyKodrixModelsChanged();
					}
					pushState(webview, context, presets);
					break;
				}
				case 'test': {
					const provider = loadStoredProviders(context).find(p => p.id === msg.id);
					if (provider) {
						await testProvider(provider, webview, context);
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
						: (presetId ? `kodrix-${presetId}` : `kodrix-custom-${Date.now()}`);
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
					notifyKodrixModelsChanged();
					await syncFromStoredProvider(stored);
					vscode.window.showInformationMessage(
						`已保存「${name}」（${models.length} 个模型）。Chat 中选择 Kodrix / ${models[0]}，无需登录 GitHub。`,
					);
					pushState(webview, context, presets);
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
					webview.postMessage({
						type: 'routesSaved',
						message: `已用当前供应商主模型「${primary}」填充全部路由`,
					});
					pushState(webview, context, presets);
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
						pushState(webview, context, presets);
					}
					break;
				}
			case 'saveRoutes': {
				await saveModelRoutes(msg.routes || {});
				await applyModelRoutes();
				webview.postMessage({ type: 'routesSaved', message: '多模型路由已保存并应用' });
				break;
			}
			default:
				logWarn(`Provider Workbench: 未知消息类型 "${(msg as { type?: string }).type}"`, msg);
			}
		})().catch(err => vscode.window.showErrorMessage(`Provider Workbench error: ${err instanceof Error ? err.message : String(err)}`));
	});
}

export const PROVIDER_SETTINGS_RENDERER_VIEW_TYPE = 'kodrix.providerSettings';

export function registerProviderSettingsRenderer(context: vscode.ExtensionContext): vscode.Disposable {
	const presets = loadPresets(context.extensionPath);
	return vscode.window.registerSettingsEditorRenderer(PROVIDER_SETTINGS_RENDERER_VIEW_TYPE, {
		async resolveSettingsEditorSetting(_setting, webviewHost, _token) {
			const { webview } = webviewHost;
			webview.options = {
				...webview.options,
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'resources'))],
			};
			webview.html = getHtml(webview, context.extensionPath);
			const messageDisposable = setupMessageHandler(webview, context, presets);
			webviewHost.onDidDispose(() => messageDisposable.dispose());
		},
	});
}

export function openProviderWorkbench(context: vscode.ExtensionContext): void {
	const presets = loadPresets(context.extensionPath);
	const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

	if (activePanel) {
		activePanel.reveal(column);
		pushState(activePanel.webview, context, presets);
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'kodrixProviderWorkbench',
		'AI 供应商管理',
		column,
		webviewOptions(context.extensionPath),
	);
	activePanel = panel;
	panel.webview.html = getHtml(panel.webview, context.extensionPath);
	context.subscriptions.push(setupMessageHandler(panel.webview, context, presets));
	panel.onDidDispose(() => {
		activePanel = undefined;
	}, undefined, context.subscriptions);
}
