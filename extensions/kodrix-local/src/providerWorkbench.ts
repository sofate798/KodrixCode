/*---------------------------------------------------------------------------------------------
 *  Kodrix — AI 供应商管理 Webview
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { loadPresets } from './migrateConfig';
import { failureGuidance, reapplyStoredProvider, removeByokProviderGroup, resolveModelsForPreset } from './byokRegister';
import { testOpenAICompatibleConnection, testOllamaConnection } from './modelDiscovery';
import { anthropicMessagesUrl, parseModelNames } from './endpointUrls';
import { notifyKodrixModelsChanged } from './languageModelProvider';
import { describeRequestError, httpStatusHint } from './requestErrors';
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

// httpStatusHint 与网络层错误描述统一由 requestErrors 提供，连接测试与真实请求共用同一口径

/** 仅允许 http/https 外部链接，防止 Webview 触发任意 scheme（file://、命令注入等） */
function isSafeExternalUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

/** `{{l10n:源文案}}` 占位（与 agent-os webviewHtml.ts 同一约定），文案里允许 {0}~{9} 运行时占位符 */
const L10N_PLACEHOLDER_RE = /\{\{l10n:((?:[^{}]|\{\d+\})*)\}\}/g;

function localizeWebviewText(source: string): string {
	const text = source.trim();
	if (!text) { return ''; }
	try {
		return l10n.t(text);
	} catch {
		return text;
	}
}

/** webview 脚本侧动态文案字典：宿主侧本地化后经 `{{l10nDict}}` 注入（键名与 provider-workbench.html 的 L10N.* 对应） */
function buildWebviewL10nDict(): Record<string, string> {
	return {
		emptyProviders: l10n.t('No providers configured yet. Switch to "Add Endpoint" or run the command Kodrix: Browse Model Provider Presets.'),
		apiKeyPending: l10n.t('API Key pending'),
		current: l10n.t('Current'),
		local: l10n.t('Local'),
		cloud: l10n.t('Cloud'),
		models: l10n.t('Models'),
		setActive: l10n.t('Set Active'),
		edit: l10n.t('Edit'),
		testConnection: l10n.t('Test Connection'),
		remove: l10n.t('Remove'),
		localModels: l10n.t('Local Models'),
		cloudApis: l10n.t('Cloud APIs'),
		website: l10n.t('Website'),
		validatedModel: l10n.t('Verified "{0}"'),
		validatedGeneric: l10n.t('Model verified'),
		providerModelCount: l10n.t(' ({0} models from this provider)'),
		connectOk: l10n.t('Connection successful ({0}ms)'),
		connectFailed: l10n.t('Connection failed'),
		unknownError: l10n.t('Unknown error'),
		saved: l10n.t('Saved'),
	};
}

function getHtml(webview: vscode.Webview, extensionPath: string): string {
	const resourcesDir = path.join(extensionPath, 'resources');
	const htmlPath = path.join(resourcesDir, 'provider-workbench.html');
	try {
		const html = fs.readFileSync(htmlPath, 'utf-8');
		const codiconsCssUri = webview.asWebviewUri(
			vscode.Uri.file(path.join(resourcesDir, 'codicons', 'codicon.css')),
		);
		const l10nDictJson = JSON.stringify(buildWebviewL10nDict()).replace(/</g, '\\u003c');
		const nonce = crypto.randomBytes(16).toString('base64');
		return html
			.replace(/\{\{cspSource\}\}/g, webview.cspSource)
			.replace(/\{\{nonce\}\}/g, nonce)
			.replace(/\{\{codiconsCssUri\}\}/g, codiconsCssUri.toString())
			.replace(/\{\{htmlLang\}\}/g, vscode.env.language)
			.replace(/\{\{l10nDict\}\}/g, l10nDictJson)
			.replace(L10N_PLACEHOLDER_RE, (_m, source: string) => localizeWebviewText(source));
	} catch (err) {
		logWarn('加载 Provider Workbench HTML 资源失败', err);
		return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>`
			+ `<body style="font-family:sans-serif;padding:24px">`
			+ `<h2>${l10n.t('AI Provider Management')}</h2><p>${l10n.t('Failed to load resources. Please rebuild the extension.')}</p></body></html>`;
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
	// 预设名称/hint 来自数据文件（英文源），经运行时 l10n.t 回填中文（键见 l10n/data-keys.json）
	const localizedPresets = presets.map(p => ({
		...p,
		name: l10n.t(p.name),
		hint: p.hint ? l10n.t(p.hint) : p.hint,
	}));
	webview.postMessage({
		type: 'init',
		providers: loadStoredProviders(context),
		activeId: getActiveProviderId(context),
		presets: localizedPresets,
		routes: loadModelRoutes(),
	});
}

async function testProvider(
	provider: StoredProvider,
	webview: vscode.Webview,
	context: vscode.ExtensionContext,
): Promise<void> {
	const apiKey = await readProviderApiKey(context, provider.id);
	if (provider.api_type === 'gemini') {
		webview.postMessage({
			type: 'testResult',
			id: provider.id,
			ok: false,
			models: provider.models,
			error: l10n.t('Kodrix Provider Management does not support the native Gemini API. Copilot BYOK in this project offers Gemini access; or switch to a compatible endpoint per the provider\'s docs.'),
		});
		return;
	}
	if (provider.api_type === 'ollama') {
		const result = await testOllamaConnection(provider.base_url, provider.models[0] || provider.model);
		webview.postMessage({
			type: 'testResult',
			id: provider.id,
			ok: result.ok,
			models: result.models,
			testedModel: result.testedModel,
			latencyMs: result.latencyMs,
			error: result.error,
		});
		return;
	}

	if (provider.api_type === 'anthropic') {
		const started = Date.now();
		const model = provider.models[0] || provider.model;
		try {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				'anthropic-version': '2023-06-01',
			};
			if (apiKey) {
				headers['x-api-key'] = apiKey;
			}
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
				testedModel: model,
				latencyMs: Date.now() - started,
				error: response.ok ? undefined : `HTTP ${response.status}，${httpStatusHint(response.status)}`,
			});
		} catch (err) {
			webview.postMessage({
				type: 'testResult',
				id: provider.id,
				ok: false,
				models: provider.models,
				testedModel: model,
				latencyMs: Date.now() - started,
				error: describeRequestError(provider.name, provider.base_url, err),
			});
		}
		return;
	}

	const result = await testOpenAICompatibleConnection(
		provider.base_url,
		apiKey,
		provider.models[0] || provider.model,
	);
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
						const apiKey = await readProviderApiKey(context, provider.id);
						const res = await reapplyStoredProvider(context, provider, presets, apiKey);
						notifyKodrixModelsChanged();
						if (res.usableViaKodrix && res.byokRegistered) {
							vscode.window.showInformationMessage(
								l10n.t('"{0}" is now the current provider. Pick Kodrix in the Chat model list.', provider.name),
							);
						} else if (res.usableViaKodrix) {
							vscode.window.showInformationMessage(
								l10n.t(
									'"{0}" is now the current provider (Kodrix channel available). The Copilot-side model list was not synced; if you want to use it in Copilot, make sure Copilot is loaded.',
									provider.name,
								),
							);
						} else if (res.byokRegistered) {
							vscode.window.showInformationMessage(
								l10n.t('"{0}" is now the current provider (via Copilot BYOK).', provider.name),
							);
						} else {
							vscode.window.showErrorMessage(
								l10n.t('"{0}" could not be activated: neither channel is available. {1}', provider.name, failureGuidance(res.failureReason)),
							);
						}
					}
					pushState(webview, context, presets);
					break;
				}
				case 'remove': {
					const provider = loadStoredProviders(context).find(p => p.id === msg.id);
					const choice = await vscode.window.showWarningMessage(
						l10n.t('Remove "{0}"?', provider?.name || l10n.t('Providers')),
						{ modal: true },
						l10n.t('Remove'),
					);
					if (choice === l10n.t('Remove')) {
						await removeStoredProvider(context, msg.id);
						await deleteProviderApiKey(context, msg.id);
						if (provider) {
							await removeByokProviderGroup(provider);
						}
						notifyKodrixModelsChanged();
					}
					pushState(webview, context, presets);
					break;
				}
				case 'test': {
					const provider = loadStoredProviders(context).find(p => p.id === msg.id);
					if (provider) {
						if (provider.category === 'cloud') {
							const proceed = await vscode.window.showWarningMessage(
								l10n.t('The connection test sends a minimal model request to the cloud provider and may still incur costs. Continue?'),
								{ modal: true },
								l10n.t('Continue Testing'),
							);
							if (proceed !== l10n.t('Continue Testing')) {
								break;
							}
						}
						await testProvider(provider, webview, context);
					}
					break;
				}
				case 'addCustom': {
					const name = typeof msg.name === 'string' ? msg.name.trim() : '';
					const baseUrl = typeof msg.baseUrl === 'string' ? msg.baseUrl.trim() : '';
					const apiType = msg.apiType === 'anthropic' ? 'anthropic' : 'openai';
					const category = msg.category === 'local' ? 'local' : 'cloud';
					if (!name || !baseUrl) {
						vscode.window.showWarningMessage(l10n.t('Fill in the name and base_url.'));
						break;
					}
					const presetId = typeof msg.presetId === 'string' && msg.presetId ? msg.presetId : undefined;
					const id = typeof msg.id === 'string' && msg.id
						? msg.id
						: (presetId ? `kodrix-${presetId}` : `kodrix-custom-${Date.now()}`);
					const apiKey = typeof msg.apiKey === 'string' ? msg.apiKey : '';
					let models = parseModelNames(typeof msg.modelsText === 'string' ? msg.modelsText : '');
					let triedDiscovery = false;
					if (!models.length && category === 'local' && apiType === 'openai') {
						// 本地 OpenAI 兼容服务（llama.cpp / LM Studio / vLLM 等）通常不预置模型名：
						// 与命令面板的预设流程共用同一探测逻辑，探测到多个模型时交给用户挑选。
						triedDiscovery = true;
						const discovered = await resolveModelsForPreset(
							{ id: presetId || id, category, name, api_type: apiType, base_url: baseUrl, model: '', models: [] },
							baseUrl,
							apiKey.trim() || await readProviderApiKey(context, id),
						);
						if (discovered?.length) {
							models = discovered;
						}
					}
					if (!models.length) {
						vscode.window.showWarningMessage(triedDiscovery
							? l10n.t('Fill in at least one model name (auto-detection found none).')
							: l10n.t('Fill in at least one model name.'));
						break;
					}
					const needsKey = category === 'cloud';
					if (apiKey.trim()) {
						await saveProviderApiKey(context, id, apiKey);
					}
					const savedKey = await readProviderApiKey(context, id);
					if (needsKey && !savedKey) {
						vscode.window.showWarningMessage(l10n.t('Cloud providers require an API Key.'));
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
						l10n.t('Saved "{0}" ({1} models). Pick Kodrix / {2} in Chat — no GitHub sign-in needed.', name, String(models.length), models[0]),
					);
					if (category === 'cloud') {
						vscode.window.showInformationMessage(
							l10n.t('Cloud models send request content to the provider; usage may incur costs. Review the provider\'s data and billing policies.'),
						);
					}
					pushState(webview, context, presets);
					break;
				}
				case 'openWebsite':
					if (typeof msg.url === 'string' && isSafeExternalUrl(msg.url)) {
						await vscode.env.openExternal(vscode.Uri.parse(msg.url));
					} else if (msg.url) {
						logWarn(`拒绝打开不安全的 URL: ${String(msg.url)}`);
						vscode.window.showWarningMessage(l10n.t('Blocked opening an untrusted link (only http/https are allowed).'));
					}
					break;
				case 'fillRoutesFromActive': {
					const activeId = getActiveProviderId(context);
					const provider = loadStoredProviders(context).find(p => p.id === activeId);
					const primary = provider ? primaryModelFromProvider(provider) : undefined;
					if (!primary) {
						vscode.window.showWarningMessage(l10n.t('Configure a provider and set it as current first.'));
						break;
					}
					await syncFromStoredProvider(provider!);
					await applyModelRoutes();
					webview.postMessage({
						type: 'routesSaved',
						message: l10n.t('Filled all routes with the current provider\'s primary model "{0}"', primary),
					});
					pushState(webview, context, presets);
					break;
				}
				case 'saveRoutes': {
				await saveModelRoutes(msg.routes || {});
				await applyModelRoutes();
				webview.postMessage({ type: 'routesSaved', message: l10n.t('Multi-model routes saved and applied') });
				break;
			}
			default:
				logWarn(`Provider Workbench: 未知消息类型 "${(msg as { type?: string }).type}"`, msg);
			}
		})().catch(err => {
			// 面板里的未预期异常：给用户一句能看懂的话，完整原因进日志，不把英文堆栈前缀丢给用户
			logWarn('AI 供应商管理面板处理消息时出错', err);
			void vscode.window.showErrorMessage(
				l10n.t('AI Provider Management: the operation did not complete ({0}). Details were written to the Kodrix output log.', err instanceof Error ? err.message : String(err)),
			);
		});
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
		l10n.t('AI Provider Management'),
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
