/*---------------------------------------------------------------------------------------------
 *  自然语言命令面板 — 动态 QuickPick + 自然语言输入
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { classifyIntent } from './agentRouter';

// 命令映射表
const COMMAND_MAP: Record<string, { command: string; labelKey: string; descKey: string; icon?: string }> = {
	agent: { command: 'workbench.action.chat.open', labelKey: 'Agent Mode', descKey: 'Multi-file editing and autonomous reasoning', icon: '$(robot)' },
	spec: { command: 'kodrix.spec.create', labelKey: 'Create Spec', descKey: 'Requirements → design → tasks trio', icon: '$(file-code)' },
	plan: { command: 'kodrix.agent.plan', labelKey: 'Plan Mode', descKey: 'Read-only analysis and planning', icon: '$(checklist)' },
	ask: { command: 'workbench.action.chat.open', labelKey: 'Ask Mode', descKey: 'Q&A and exploration', icon: '$(question)' },
	terminal: { command: 'kodrix.terminal.aiPrompt', labelKey: 'Terminal AI', descKey: 'Generate and run commands from natural language', icon: '$(terminal)' },
	wiki: { command: 'kodrix.wiki.generate', labelKey: 'Generate Repo Wiki', descKey: 'Project docs and architecture analysis', icon: '$(book)' },
	checkpoint: { command: 'kodrix.checkpoint.list', labelKey: 'Checkpoint Management', descKey: 'View / roll back / create checkpoints', icon: '$(history)' },
	models: { command: 'kodrix.modelRouter.status', labelKey: 'Model Provider Management', descKey: 'Configure AI models and APIs', icon: '$(gear)' },
	settings: { command: 'workbench.action.openSettings', labelKey: 'Kodrix Settings', descKey: 'Open Kodrix configuration', icon: '$(settings-gear)' },
};

// 路由目标到 QuickPick key 的映射
const ROUTE_TARGET_TO_KEY: Record<string, string> = {
	agent: 'agent',
	spec: 'spec',
	plan: 'plan',
	ask: 'ask',
	terminal: 'terminal',
	wiki: 'wiki',
	checkpoint: 'checkpoint',
	models: 'models',
	settings: 'settings',
};

export function registerNaturalCommandPalette(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.router.naturalPalette', async () => {
			const items = Object.entries(COMMAND_MAP).map(([key, val]) => ({
				label: `${val.icon} ${l10n.t(val.labelKey)}`,
				description: l10n.t(val.descKey),
				target: key,
				command: val.command,
			}));

			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: l10n.t('Type natural language or pick a command...'),
				matchOnDescription: true,
			});

			if (picked) {
				// 对于 agent/spec/plan/ask 模式，需要通过 chat 打开
				if (picked.target === 'agent') {
					await vscode.commands.executeCommand('workbench.action.chat.open', {
						mode: 'agent',
					});
				} else if (picked.target === 'ask') {
					await vscode.commands.executeCommand('workbench.action.chat.open', {
						mode: 'ask',
					});
				} else if (picked.target === 'settings') {
					await vscode.commands.executeCommand(picked.command, 'kodrix.');
				} else {
					await vscode.commands.executeCommand(picked.command);
				}
			}
		}),
	);

	// 注册自然语言输入模式：在命令面板中支持自然语言 → 自动路由
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.router.naturalInput', async () => {
			const input = await vscode.window.showInputBox({
				prompt: l10n.t('Describe what you want to do in natural language...'),
				placeHolder: l10n.t('e.g., open the terminal, view checkpoints, model configuration...'),
			});

			if (!input?.trim()) {
				return;
			}

			const route = classifyIntent(input);
			const targetKey = ROUTE_TARGET_TO_KEY[route.target];

			if (targetKey && COMMAND_MAP[targetKey]) {
				const entry = COMMAND_MAP[targetKey];
				if (route.target === 'settings') {
					await vscode.commands.executeCommand(entry.command, 'kodrix.');
				} else {
					await vscode.commands.executeCommand(entry.command);
				}
				vscode.window.setStatusBarMessage(
					`$(hubot) ${l10n.t('Routed to')} ${l10n.t(entry.labelKey)}（${route.reason}）`,
					3000,
				);
			} else {
				// 默认走 agent 模式
				await vscode.commands.executeCommand('workbench.action.chat.open', {
					mode: 'agent',
					query: input,
					isPartialQuery: false,
				});
			}
		}),
	);
}
