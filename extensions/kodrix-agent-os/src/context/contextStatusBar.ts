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

const CONTEXT_LAYERS_KEY = 'kodrix.contextEnabledLayers' as const;
const ALL_LAYERS: ContextLayerKey[] = ['wiki', 'memory', 'learning', 'semantic'];

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
		`**${l10n.t('Kodrix 上下文摘要')}**\n\n` +
		`| ${l10n.t('层级')} | ${l10n.t('内容')} |\n|------|------|\n` +
		`| Wiki | ${summary.wikiKB.toFixed(1)} KB |\n` +
		`| Memory | ${summary.memoryCount} ${l10n.t('条')} |\n` +
		`| Learning | ${summary.learningCount} ${l10n.t('条')} |\n` +
		`| Semantic | ${summary.semanticVectors} ${l10n.t('向量')} |\n` +
		`| **${l10n.t('估算 Token')}** | **~${summary.estimatedTokens}** |\n\n` +
		`_${l10n.t('点击切换各层上下文开关')}_`,
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
				{ label: `$(book) ${l10n.t('Wiki 上下文')}`, key: 'wiki', picked: currentEnabled.includes('wiki') },
				{ label: `$(brain) ${l10n.t('Project Memory')}`, key: 'memory', picked: currentEnabled.includes('memory') },
				{ label: `$(mortar-board) ${l10n.t('Learning')}`, key: 'learning', picked: currentEnabled.includes('learning') },
				{ label: `$(search) ${l10n.t('Semantic Memory')}`, key: 'semantic', picked: currentEnabled.includes('semantic') },
			];

			const picked = await vscode.window.showQuickPick(
				layerItems.map(l => ({ label: l.label, picked: l.picked, key: l.key })),
				{ canPickMany: true, placeHolder: l10n.t('选择要注入的上下文层级') },
			);

			if (picked) {
				const selectedKeys = picked.map(p => p.key);
				await saveEnabledLayers(context, selectedKeys);
				updateStatusBar();
			}
		}),
	);
}

function getEnabledLayers(features: vscode.WorkspaceConfiguration): ContextLayerKey[] {
	const enabled: ContextLayerKey[] = [];
	if (features.get<boolean>('wiki')) { enabled.push('wiki'); }
	if (features.get<boolean>('memory')) { enabled.push('memory'); }
	if (features.get<boolean>('learning')) { enabled.push('learning'); }
	if (features.get<boolean>('semanticMemory') !== false) { enabled.push('semantic'); }
	return enabled;
}

async function saveEnabledLayers(context: vscode.ExtensionContext, layers: ContextLayerKey[]): Promise<void> {
	await context.workspaceState.update(CONTEXT_LAYERS_KEY, layers);
}

export function getEnabledContextLayers(context: vscode.ExtensionContext): ContextLayerKey[] {
	return context.workspaceState.get<ContextLayerKey[]>(CONTEXT_LAYERS_KEY) ?? ALL_LAYERS;
}
