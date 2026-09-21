/*---------------------------------------------------------------------------------------------
 *  ACP 外部 Agent 注册 — Devin Desktop / Agent Client Protocol 风格
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';
import { ensureDir, getAcpAgentsPath } from '../paths';
import { logger } from '../logger';
import { isRecord } from '../utils/jsonValidator';

export interface AcpAgentEntry {
	id: string;
	name: string;
	command: string;
	description?: string;
	protocol: 'acp';
	enabled: boolean;
	registeredAt: string;
}

interface AcpRegistry {
	agents: AcpAgentEntry[];
}

function loadRegistry(): AcpRegistry {
	const p = getAcpAgentsPath();
	if (!fs.existsSync(p)) {
		return { agents: [] };
	}
	try {
		const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
		if (isRecord(raw) && Array.isArray(raw.agents)) {
			return raw as unknown as AcpRegistry;
		}
		logger.warn('[AcpRegistry] loadRegistry: invalid shape — resetting');
		return { agents: [] };
	} catch {
		return { agents: [] };
	}
}

function saveRegistry(data: AcpRegistry): void {
	const p = getAcpAgentsPath();
	ensureDir(p.replace(/[/\\][^/\\]+$/, ''));
	fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

export async function registerAcpAgent(): Promise<void> {
	const name = await vscode.window.showInputBox({ prompt: 'Agent 名称', placeHolder: 'My Custom Agent' });
	if (!name?.trim()) {
		return;
	}
	const command = await vscode.window.showInputBox({
		prompt: '启动命令（ACP 兼容）',
		placeHolder: 'npx my-agent-cli --acp',
	});
	if (!command?.trim()) {
		return;
	}
	const description = await vscode.window.showInputBox({ prompt: '描述（可选）' }) || undefined;

	const registry = loadRegistry();
	const entry: AcpAgentEntry = {
		id: `acp-${Date.now()}`,
		name: name.trim(),
		command: command.trim(),
		description,
		protocol: 'acp',
		enabled: true,
		registeredAt: new Date().toISOString(),
	};
	registry.agents.push(entry);
	saveRegistry(registry);

	vscode.window.showInformationMessage(`ACP Agent 已注册：${name}（~/.minicode/acp/agents.json）`);
}

export async function listAcpAgents(): Promise<void> {
	const registry = loadRegistry();
	if (!registry.agents.length) {
		vscode.window.showInformationMessage('尚无 ACP Agent。使用「注册 ACP 外部 Agent」添加。');
		return;
	}

	const doc = await vscode.workspace.openTextDocument({
		content: [
			'# ACP 外部 Agent 列表',
			'',
			...registry.agents.map(a =>
				`- **${a.name}** (\`${a.id}\`)\n  - 命令: \`${a.command}\`\n  - 状态: ${a.enabled ? '启用' : '禁用'}\n  - ${a.description || ''}`,
			),
			'',
			'配置文件：`~/.minicode/acp/agents.json`',
		].join('\n'),
		language: 'markdown',
	});
	await vscode.window.showTextDocument(doc);
}

export function registerAcp(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('minicode.acp.register', () => registerAcpAgent()),
		vscode.commands.registerCommand('minicode.acp.list', () => listAcpAgents()),
	);
	ensureDir(getAcpAgentsPath().replace(/[/\\][^/\\]+$/, ''));
}
