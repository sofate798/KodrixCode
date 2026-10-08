/*---------------------------------------------------------------------------------------------
 *  Context Status Bar — 状态栏上下文摘要 + 一键切换层级开关
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { getContextSummary } from './contextIntelligence';
import { onContextChanged } from './contextEvents';
import { COMMANDS, CONFIG_FEATURES } from '../shared/constants';

/** 上下文层级键 */
type ContextLayerKey = 'wiki' | 'memory' | 'learning' | 'semantic';

/** 层级 → kodrix.features.* 配置键（唯一写入目标；装配侧读的就是这些键） */
const LAYER_CONFIG_KEYS: Record<ContextLayerKey, string> = {
	wiki: 'wiki',
	memory: 'memory',
	learning: 'learning',
	semantic: 'semanticMemory',
};

let _statusBarItem: vscode.StatusBarItem | undefined;

export function registerContextStatusBar(context: vscode.ExtensionContext): void {
	_statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	_statusBarItem.command = COMMANDS.contextToggleSummary;
	context.subscriptions.push(_statusBarItem);

	updateStatusBar();

	// 监听上下文变更
	context.subscriptions.push(onContextChanged(() => updateStatusBar()));

	// 监听配置变更（功能开关可能变化）
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_FEATURES)) {
				updateStatusBar();
			}
		}),
	);
}

function updateStatusBar(): void {
	if (!_statusBarItem) { return; }
	const summary = getContextSummary();

	// 紧凑格式：🧠 W·M·L·S ≈ tokens
	_statusBarItem.text = `$(brain) W${summary.wikiKB.toFixed(1)}k·M${summary.memoryCount}·L${summary.learningCount}·S${summary.semanticVectors} ≈${summary.estimatedTokens}t`;
	_statusBarItem.tooltip = new vscode.MarkdownString(
		`**${l10n.t('Kodrix Context Summary')}**\n\n` +
		`| ${l10n.t('Layers')} | ${l10n.t('Content')} |\n|------|------|\n` +
		`| Wiki | ${summary.wikiKB.toFixed(1)} KB |\n` +
		`| Memory | ${summary.memoryCount} ${l10n.t('items')} |\n` +
		`| Learning | ${summary.learningCount} ${l10n.t('items')} |\n` +
		`| Semantic | ${summary.semanticVectors} ${l10n.t('Vectors')} |\n` +
		`| **${l10n.t('Estimated Tokens')}** | **~${summary.estimatedTokens}** |\n\n` +
		`_${l10n.t('Click to toggle each context layer on/off')}_`,
	);
	_statusBarItem.show();
}

/** 注册一键切换命令 */
export function registerToggleContextLayersCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.contextToggleSummary, async () => {
			const features = vscode.workspace.getConfiguration(CONFIG_FEATURES);
			const currentEnabled = getEnabledLayers(features);

			const layerItems: { label: string; key: ContextLayerKey; picked: boolean }[] = [
				{ label: `$(book) ${l10n.t('Wiki Context')}`, key: 'wiki', picked: currentEnabled.includes('wiki') },
				{ label: `$(brain) ${l10n.t('Project Memory')}`, key: 'memory', picked: currentEnabled.includes('memory') },
				{ label: `$(mortar-board) ${l10n.t('Learning')}`, key: 'learning', picked: currentEnabled.includes('learning') },
				{ label: `$(search) ${l10n.t('Semantic Memory')}`, key: 'semantic', picked: currentEnabled.includes('semantic') },
			];

			const picked = await vscode.window.showQuickPick(
				layerItems.map(l => ({ label: l.label, picked: l.picked, key: l.key })),
				{ canPickMany: true, placeHolder: l10n.t('Select the context levels to inject') },
			);

			if (picked) {
				const selectedKeys = picked.map(p => p.key);
				await applyEnabledLayers(selectedKeys);
				updateStatusBar();
			}
		}),
	);
}

function getEnabledLayers(features: vscode.WorkspaceConfiguration): ContextLayerKey[] {
	const enabled: ContextLayerKey[] = [];
	for (const layer of Object.keys(LAYER_CONFIG_KEYS) as ContextLayerKey[]) {
		// 默认开启：只有显式 false 才算关闭（semanticMemory 历史上也允许 undefined 表示开启）
		if (features.get<boolean>(LAYER_CONFIG_KEYS[layer]) !== false) {
			enabled.push(layer);
		}
	}
	return enabled;
}

/**
 * 把勾选结果写回 `kodrix.features.*`（唯一事实来源）。
 * 此前写的是 workspaceState 的自定义键，而装配侧读的是配置项、且那个键全仓无消费者，
 * 于是"取消勾选"完全无效 —— 现在开关真的能关掉对应层的注入。
 */
async function applyEnabledLayers(layers: ContextLayerKey[]): Promise<void> {
	const features = vscode.workspace.getConfiguration(CONFIG_FEATURES);
	for (const layer of Object.keys(LAYER_CONFIG_KEYS) as ContextLayerKey[]) {
		const key = LAYER_CONFIG_KEYS[layer];
		const shouldEnable = layers.includes(layer);
		if (features.get<boolean>(key, true) !== shouldEnable) {
			await features.update(key, shouldEnable, vscode.ConfigurationTarget.Global);
		}
	}
}
