/*---------------------------------------------------------------------------------------------
 *  Terminal AI — 终端 AI prompt 条（对标 Cursor：Cmd+K 生成命令 · Cmd+Enter 运行）
 *
 *  能力：
 *    1. Cmd+K（terminalFocus 时）唤起终端 AI：输入自然语言意图 → LLM 生成命令
 *    2. 命令确认 / 编辑（Enter 或 Cmd+Enter 运行 · 复制按钮 · Esc 取消）
 *    3. 无可用 LLM 时自动降级为手动输入命令
 *    4. runCommandInTerminal：程序化命令执行封装（供 Agent / 自动化使用），
 *       支持输出捕获（shell integration / terminal data）、超时与取消
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { logger } from '../logger';
import {
	COMMANDS,
	IDEA_FLOW_MODEL_FAMILIES,
	TERMINAL_AI_GEN_TIMEOUT_MS,
	TERMINAL_AI_RUN_TIMEOUT_MS,
} from '../shared/constants';

/** 确认 QuickPick 打开期间的 context key（Cmd+Enter 快捷键的 when 条件） */
const TERMINAL_AI_PENDING_CONTEXT = 'kodrix.terminalAI.pending';

/** 当前待运行命令（Cmd+Enter 读取） */
let pendingCommandText = '';
/** 当前打开的确认 QuickPick（aiRun 需要隐藏它） */
let pendingQuickPick: vscode.QuickPick<vscode.QuickPickItem> | undefined;

/** 平台对应的 Shell 提示（生成命令时注入） */
function shellHint(): string {
	switch (process.platform) {
		case 'win32': return 'Windows PowerShell';
		case 'darwin': return 'macOS zsh（bash 兼容）';
		default: return 'Linux bash';
	}
}

/** 生成命令的系统提示词 */
function buildSystemPrompt(workspacePath: string | undefined): string {
	return [
		'你是终端命令助手。根据用户意图生成可直接在终端执行的一条或多条命令。',
		`当前 Shell：${shellHint()}`,
		workspacePath ? `当前工作区：${workspacePath}` : '',
		'要求：',
		'- 只输出命令本身，不要解释、不要编号、不要 Markdown 围栏',
		'- 多条命令用换行分隔，或用 && 连接',
		'- 优先使用工作区内的包管理器（根据 package.json / requirements.txt 判断 npm / pnpm / yarn / pip）',
		'- 命令必须安全：默认不执行删除、覆盖、格式化等破坏性操作，除非用户明确要求',
	].filter(Boolean).join('\n');
}

/** 清理 LLM 输出：去围栏、去首尾引号、trim */
export function sanitizeCommand(raw: string): string {
	let text = raw.trim();
	const fence = text.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
	if (fence) {
		text = fence[1].trim();
	}
	text = text.replace(/^["'`]+|["'`]+$/g, '').trim();
	return text.split('\n').map(l => l.trimEnd()).join('\n').trim();
}

/** 选择可用的 LLM 模型（复用 IdeaFlow 的模型族顺序） */
async function pickModel(): Promise<vscode.LanguageModelChat | undefined> {
	for (const family of IDEA_FLOW_MODEL_FAMILIES) {
		try {
			const [found] = await vscode.lm.selectChatModels({ family });
			if (found) return found;
		} catch {
			// 该模型族不可用，尝试下一个
		}
	}
	return undefined;
}

/** 生成命令（无模型或失败返回空串，由调用方降级） */
async function generateCommand(intent: string, workspacePath: string | undefined): Promise<string> {
	const model = await pickModel();
	if (!model) {
		logger.info('Terminal AI: no chat model available, falling back to manual input');
		return '';
	}
	const cts = new vscode.CancellationTokenSource();
	const timer = setTimeout(() => cts.cancel(), TERMINAL_AI_GEN_TIMEOUT_MS);
	try {
		const messages = [
			vscode.LanguageModelChatMessage.User(`${buildSystemPrompt(workspacePath)}\n\n用户意图：${intent}`),
		];
		const response = await model.sendRequest(messages, {}, cts.token);
		let fullText = '';
		for await (const chunk of response.stream) {
			if (chunk instanceof vscode.LanguageModelTextPart) {
				fullText += chunk.value;
			}
		}
		return sanitizeCommand(fullText);
	} catch (err) {
		logger.error('Terminal AI: command generation failed', err);
		return '';
	} finally {
		clearTimeout(timer);
		cts.dispose();
	}
}

/** 获取可用的终端（优先活动终端，否则新建） */
export function ensureTerminal(): vscode.Terminal {
	const active = vscode.window.activeTerminal;
	if (active) {
		active.show();
		return active;
	}
	const terminal = vscode.window.createTerminal({ name: 'Kodrix Terminal' });
	terminal.show();
	return terminal;
}

/** 将命令发送到终端（多行逐行执行） */
export function sendToTerminal(terminal: vscode.Terminal, command: string): void {
	for (const line of command.split('\n')) {
		const t = line.trim();
		if (t) {
			terminal.sendText(t, true);
		}
	}
	terminal.show();
}

/** 设置/清除待运行命令状态（同步 context key） */
async function setPending(value: string | undefined, qp?: vscode.QuickPick<vscode.QuickPickItem>): Promise<void> {
	pendingCommandText = value ?? '';
	pendingQuickPick = qp;
	await vscode.commands.executeCommand('setContext', TERMINAL_AI_PENDING_CONTEXT, value !== undefined);
}

/** Cmd+Enter：运行当前待运行命令 */
async function runPendingCommand(): Promise<void> {
	const qp = pendingQuickPick;
	const command = pendingCommandText.trim();
	if (qp) {
		qp.hide();
	}
	await setPending(undefined);
	if (!command) {
		return;
	}
	const terminal = ensureTerminal();
	sendToTerminal(terminal, command);
	vscode.window.showInformationMessage(`终端已运行：${command.length > 60 ? command.slice(0, 60) + '…' : command}`);
}

/** 阶段 3：确认 / 编辑命令（Enter / Cmd+Enter 运行 · 复制按钮 · Esc 取消） */
async function confirmCommand(initial: string, terminal: vscode.Terminal): Promise<void> {
	const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
	qp.title = '终端 AI — 确认命令';
	qp.placeholder = 'Enter / Cmd+Enter 运行 · 复制按钮复制 · Esc 取消';
	qp.value = initial;
	qp.items = [
		{ label: '$(play) 运行到终端', description: 'Enter 或 Cmd+Enter', alwaysShow: true },
		{ label: '$(copy) 复制命令', description: '点击右上角复制按钮', alwaysShow: true },
	];
	qp.activeItems = [qp.items[0]];
	qp.buttons = [
		{ iconPath: new vscode.ThemeIcon('copy'), tooltip: '复制命令到剪贴板' },
	];

	await setPending(initial, qp);

	qp.onDidChangeValue(value => {
		void setPending(value, qp);
	});

	qp.onDidTriggerButton(async () => {
		await vscode.env.clipboard.writeText(qp.value);
		vscode.window.showInformationMessage('命令已复制到剪贴板');
	});

	qp.onDidAccept(async () => {
		const command = qp.value.trim();
		qp.hide();
		await setPending(undefined);
		if (!command) {
			return;
		}
		sendToTerminal(terminal, command);
		vscode.window.showInformationMessage(`终端已运行：${command.length > 60 ? command.slice(0, 60) + '…' : command}`);
	});

	qp.onDidHide(() => {
		void setPending(undefined);
		qp.dispose();
	});

	qp.show();
}

/** Cmd+K：终端 AI prompt 条主流程 */
async function terminalAiPrompt(): Promise<void> {
	// 阶段 1：输入意图
	const intent = await vscode.window.showInputBox({
		title: '终端 AI — 描述要执行的命令',
		prompt: '用自然语言描述操作；也可以直接输入命令',
		placeHolder: '例如：启动开发服务器并打开浏览器',
		ignoreFocusOut: true,
	});
	if (intent === undefined) {
		return;
	}
	const trimmed = intent.trim();
	if (!trimmed) {
		return;
	}

	const terminal = ensureTerminal();
	const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

	// 阶段 2：生成命令（busy 态）
	const gen = vscode.window.createQuickPick<vscode.QuickPickItem>();
	gen.title = '终端 AI — 正在生成命令…';
	gen.busy = true;
	gen.enabled = false;
	gen.show();

	let command = '';
	try {
		command = await generateCommand(trimmed, workspacePath);
	} finally {
		gen.dispose();
	}
	if (!command) {
		// 降级：无模型或生成失败，直接使用用户输入
		command = trimmed;
	}

	// 阶段 3：确认 / 编辑
	await confirmCommand(command, terminal);
}

// ── 命令执行封装（供 Agent / 自动化使用） ─────────────────────────────

/** 命令执行结果 */
export interface CommandResult {
	/** 退出码（shell integration 提供；不可用时为 undefined） */
	exitCode: number | undefined;
	/** 捕获的终端输出（能力可用时） */
	output: string;
	/** 是否超时 / 被取消 */
	timedOut: boolean;
	/**
	 * 无 shell integration 时短等待后尽力返回（退出码不可靠，命令可能仍在跑）。
	 * 调用方应按 incomplete / exitCode 区分，勿当成「执行失败」。
	 */
	incomplete?: boolean;
}

/** shell integration API 的类型视图（能力检测用，避免强依赖高版本 API） */
interface ShellExecutionEvent {
	terminal: vscode.Terminal;
	execution: { onDidEnd(cb: () => unknown): vscode.Disposable; exitCode?: number };
}

/**
 * 在终端执行命令并捕获输出（供 Agent / 自动化使用）。
 * 完成检测优先使用 shell integration（VS Code 1.93+），不可用时按超时兜底。
 */
export async function runCommandInTerminal(
	command: string,
	options: { terminal?: vscode.Terminal; timeoutMs?: number; token?: vscode.CancellationToken } = {},
): Promise<CommandResult> {
	const timeoutMs = options.timeoutMs ?? TERMINAL_AI_RUN_TIMEOUT_MS;
	const terminal = options.terminal ?? ensureTerminal();
	const output: string[] = [];
	const disposables: vscode.Disposable[] = [];
	let settled = false;

	const cleanup = (): void => {
		for (const d of disposables) {
			d.dispose();
		}
	};

	return new Promise<CommandResult>(resolve => {
		const finish = (extra?: Partial<CommandResult>): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			if (timer) {
				clearTimeout(timer);
			}
			resolve({ exitCode: undefined, output: output.join(''), timedOut: false, ...extra });
		};

		const win = vscode.window as unknown as {
			onDidWriteTerminalData?: (cb: (e: { terminal: vscode.Terminal; data: string }) => unknown) => vscode.Disposable;
			onDidStartTerminalShellExecution?: (cb: (e: ShellExecutionEvent) => unknown) => vscode.Disposable;
		};

		const supportsShellIntegration = typeof win.onDidStartTerminalShellExecution === 'function';

		// 输出捕获：terminal data（VS Code 1.94+）
		if (typeof win.onDidWriteTerminalData === 'function') {
			disposables.push(win.onDidWriteTerminalData(e => {
				if (e.terminal === terminal) {
					output.push(e.data);
				}
			}));
		}

		// 完成检测：shell integration execution 结束（VS Code 1.93+）
		if (supportsShellIntegration) {
			disposables.push(win.onDidStartTerminalShellExecution!(e => {
				if (e.terminal !== terminal) {
					return;
				}
				e.execution.onDidEnd(() => {
					finish({ exitCode: e.execution.exitCode });
				});
			}));
		}

		// 超时兜底
		let timer: NodeJS.Timeout | undefined;
		timer = setTimeout(() => {
			finish({ timedOut: true });
		}, timeoutMs);

		// 取消
		if (options.token) {
			options.token.onCancellationRequested(() => finish({ timedOut: true }));
		}

		// 无 shell integration 时：短等待后返回已捕获输出（尽力而为，标记 incomplete）
		if (!supportsShellIntegration) {
			setTimeout(() => finish({ incomplete: true, timedOut: false }), 2000);
		}

		// 发送命令（确保监听已注册后再执行）
		terminal.sendText(command, true);
	});
}

/** 注册终端 AI 命令 */
export function registerTerminalAI(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.terminalAiPrompt, () => terminalAiPrompt()),
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.terminalAiRun, () => runPendingCommand()),
	);
}
