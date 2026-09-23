/*---------------------------------------------------------------------------------------------
 *  ACP 外部 Agent 注册 — Devin Desktop / Agent Client Protocol 风格
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureDir, getAcpAgentsPath, getKodrixDir } from '../paths';
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

	vscode.window.showInformationMessage(`ACP Agent 已注册：${name}（~/.kodrix/acp/agents.json）`);
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
			'配置文件：`~/.kodrix/acp/agents.json`',
		].join('\n'),
		language: 'markdown',
	});
	await vscode.window.showTextDocument(doc);
}

export interface AcpRunResult {
	id: string;
	agentId: string;
	agentName: string;
	task: string;
	status: 'completed' | 'failed' | 'cancelled' | 'timeout';
	output: string;
	error?: string;
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
}

function getRunsDir(): string {
	return path.join(getKodrixDir(), 'acp', 'runs');
}

function writeRun(run: AcpRunResult): void {
	ensureDir(getRunsDir());
	fs.writeFileSync(path.join(getRunsDir(), `${run.id}.json`), JSON.stringify(run, null, 2), 'utf-8');
}

/** 读取历史委派运行（新→旧） */
export function listAcpRuns(): AcpRunResult[] {
	if (!fs.existsSync(getRunsDir())) {
		return [];
	}
	try {
		return fs.readdirSync(getRunsDir())
			.filter(f => f.endsWith('.json'))
			.map(f => {
				try {
					return JSON.parse(fs.readFileSync(path.join(getRunsDir(), f), 'utf-8')) as AcpRunResult;
				} catch {
					return undefined;
				}
			})
			.filter((r): r is AcpRunResult => r !== undefined)
			.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
	} catch {
		return [];
	}
}

/** 委派任务给外部 ACP Agent（stdio JSONL 简化协议：stdin 发 task 行，stdout 收 text/纯文本行） */
export async function dispatchAcpTask(agent: AcpAgentEntry, task: string, timeoutMs = 600_000): Promise<AcpRunResult> {
	const id = `acp-run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
	const run: AcpRunResult = {
		id,
		agentId: agent.id,
		agentName: agent.name,
		task,
		status: 'failed',
		output: '',
		startedAt: new Date().toISOString(),
	};
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const started = Date.now();
	return await new Promise<AcpRunResult>(resolve => {
		let child: ReturnType<typeof spawn> | undefined;
		try {
			child = spawn(agent.command, [], { shell: true, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (err) {
			run.status = 'failed';
			run.error = err instanceof Error ? err.message : String(err);
			run.finishedAt = new Date().toISOString();
			run.durationMs = Date.now() - started;
			writeRun(run);
			resolve(run);
			return;
		}
		let timedOut = false;
		/** stdout 跨 chunk 行缓冲（避免 JSONL 被截断） */
		let stdoutBuf = '';
		/** 输出上限，防止外部 agent 无限输出撑爆内存 */
		const OUTPUT_MAX_CHARS = 2 * 1024 * 1024;
		const ERROR_MAX_CHARS = 1 * 1024 * 1024;
		let outputTruncated = false;
		let errorTruncated = false;
		const appendOutput = (text: string): void => {
			if (outputTruncated || !text) {
				return;
			}
			const next = run.output ? `${run.output}\n${text}` : text;
			if (next.length > OUTPUT_MAX_CHARS) {
				run.output = next.slice(0, OUTPUT_MAX_CHARS);
				outputTruncated = true;
				run.error = (run.error ? run.error + '\n' : '') + `输出已截断（>${OUTPUT_MAX_CHARS} 字符）`;
				return;
			}
			run.output = next;
		};
		const appendError = (text: string): void => {
			if (errorTruncated || !text) {
				return;
			}
			const next = run.error ? `${run.error}\n${text}` : text;
			if (next.length > ERROR_MAX_CHARS) {
				run.error = next.slice(0, ERROR_MAX_CHARS) + `\nstderr 已截断（>${ERROR_MAX_CHARS} 字符）`;
				errorTruncated = true;
				return;
			}
			run.error = next;
		};
		const consumeStdoutLine = (line: string): void => {
			const lineText = line.trim();
			if (!lineText) {
				return;
			}
			try {
				const msg = JSON.parse(lineText);
				if (msg && typeof msg === 'object' && typeof msg.content === 'string') {
					appendOutput(msg.content);
					return;
				}
			} catch { /* 非 JSONL 行按纯文本收集 */ }
			appendOutput(lineText);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try { child?.kill(); } catch { /* 已退出 */ }
		}, timeoutMs);
		child.stdout?.on('data', (chunk: Buffer) => {
			stdoutBuf += String(chunk);
			const parts = stdoutBuf.split(/\r?\n/);
			stdoutBuf = parts.pop() ?? '';
			for (const line of parts) {
				consumeStdoutLine(line);
			}
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			appendError(String(chunk).trim());
		});
		child.on('error', (err: Error) => {
			clearTimeout(timer);
			run.status = 'failed';
			run.error = err.message;
			run.finishedAt = new Date().toISOString();
			run.durationMs = Date.now() - started;
			writeRun(run);
			resolve(run);
		});
		child.on('close', (code: number | null) => {
			clearTimeout(timer);
			// flush 尾部未完成行
			if (stdoutBuf.trim()) {
				consumeStdoutLine(stdoutBuf);
				stdoutBuf = '';
			}
			if (timedOut) {
				run.status = 'timeout';
				run.error = (run.error ? run.error + '\n' : '') + `超时（>${timeoutMs}ms）`;
			} else {
				run.status = code === 0 ? 'completed' : 'failed';
				if (code !== 0 && !run.error) {
					run.error = `退出码 ${code}`;
				}
			}
			run.finishedAt = new Date().toISOString();
			run.durationMs = Date.now() - started;
			writeRun(run);
			resolve(run);
		});
		child.stdin?.on('error', () => { /* 外部 agent 未读 stdin 时忽略 */ });
		try {
			child.stdin?.write(`${JSON.stringify({ type: 'task', task })}\n`, 'utf-8');
		} catch { /* 同上 */ }
	});
}

function renderAcpRunMarkdown(run: AcpRunResult): string {
	return [
		`# ACP 委派结果：${run.agentName}`,
		'',
		`- 任务: ${run.task}`,
		`- 状态: ${run.status}`,
		`- 开始: ${run.startedAt} · 耗时: ${run.durationMs ?? '—'}ms`,
		(run.error ? `- 错误: ${run.error}` : ''),
		'',
		'## 输出',
		'',
		run.output || '（无输出）',
	].filter(x => x !== '').join('\n');
}

async function dispatchAcpCommand(): Promise<void> {
	const registry = loadRegistry();
	const enabled = registry.agents.filter(a => a.enabled);
	if (!enabled.length) {
		await vscode.window.showWarningMessage('无已启用的 ACP Agent。请先「注册 ACP 外部 Agent」。');
		return;
	}
	const picked = await vscode.window.showQuickPick(
		enabled.map(a => ({ label: a.name, description: a.command, agent: a })),
		{ placeHolder: '选择外部 Agent 委派任务' },
	);
	if (!picked) {
		return;
	}
	const task = await vscode.window.showInputBox({
		prompt: `任务描述（交给 ${picked.label}）`,
		placeHolder: '例如：分析 src/ 下的重复代码并输出报告',
	});
	if (!task?.trim()) {
		return;
	}
	const run = await dispatchAcpTask(picked.agent, task.trim());
	const doc = await vscode.workspace.openTextDocument({ content: renderAcpRunMarkdown(run), language: 'markdown' });
	await vscode.window.showTextDocument(doc, { preview: false });
	if (run.status === 'completed') {
		await vscode.window.showInformationMessage(`ACP Agent ${run.agentName} 任务完成`);
	} else {
		await vscode.window.showWarningMessage(`ACP Agent ${run.agentName} 任务${run.status === 'timeout' ? '超时' : '失败'}`);
	}
}

async function listAcpRunsCommand(): Promise<void> {
	const runs = listAcpRuns();
	const doc = await vscode.workspace.openTextDocument({
		content: [
			'# ACP 委派历史',
			'',
			...(runs.length ? runs.map(r => `- **${r.agentName}** (${r.status}) ${r.startedAt} — ${r.task}`) : ['（暂无委派记录）']),
			'',
			'记录目录：`~/.kodrix/acp/runs/`',
		].join('\n'),
		language: 'markdown',
	});
	await vscode.window.showTextDocument(doc);
}

export function registerAcp(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.acp.register', () => registerAcpAgent()),
		vscode.commands.registerCommand('kodrix.acp.list', () => listAcpAgents()),
		vscode.commands.registerCommand('kodrix.acp.dispatch', () => dispatchAcpCommand()),
		vscode.commands.registerCommand('kodrix.acp.runs', () => listAcpRunsCommand()),
	);
	ensureDir(getAcpAgentsPath().replace(/[/\\][^/\\]+$/, ''));
}
