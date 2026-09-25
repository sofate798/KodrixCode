/*---------------------------------------------------------------------------------------------
 *  自然语言命令面板 — 动态 QuickPick + 自然语言输入
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { classifyIntent } from './agentRouter';

// 命令映射表
const COMMAND_MAP: Record<string, { command: string; labelKey: string; descKey: string; icon?: string }> = {
	agent: { command: 'workbench.action.chat.open', labelKey: 'Agent 模式', descKey: '多文件编辑与自主推理', icon: '$(robot)' },
	spec: { command: 'kodrix.spec.create', labelKey: '创建 Spec', descKey: '需求→设计→任务三件套', icon: '$(file-code)' },
	plan: { command: 'kodrix.agent.plan', labelKey: 'Plan 模式', descKey: '只读分析与规划', icon: '$(checklist)' },
	ask: { command: 'workbench.action.chat.open', labelKey: 'Ask 模式', descKey: '问答与探索', icon: '$(question)' },
	terminal: { command: 'kodrix.terminal.aiPrompt', labelKey: '终端 AI', descKey: '自然语言生成并运行命令', icon: '$(terminal)' },
	wiki: { command: 'kodrix.wiki.generate', labelKey: '生成 Repo Wiki', descKey: '项目文档与架构分析', icon: '$(book)' },
	checkpoint: { command: 'kodrix.checkpoint.list', labelKey: '检查点管理', descKey: '查看/回滚/创建检查点', icon: '$(history)' },
	models: { command: 'kodrix.modelRouter.status', labelKey: '模型供应商管理', descKey: '配置 AI 模型与 API', icon: '$(gear)' },
	settings: { command: 'workbench.action.openSettings', labelKey: 'Kodrix 设置', descKey: '打开 Kodrix 配置', icon: '$(settings-gear)' },
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
				placeHolder: l10n.t('输入自然语言或选择命令...'),
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
				prompt: l10n.t('用自然语言描述你想做的事...'),
				placeHolder: l10n.t('例如：打开终端、查看检查点、模型配置...'),
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
					`$(hubot) ${l10n.t('已路由到')} ${l10n.t(entry.labelKey)}（${route.reason}）`,
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
