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
import { l10n } from 'vscode';
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
		case 'win32': return l10n.t('Windows PowerShell');
		case 'darwin': return l10n.t('macOS zsh (bash compatible)');
		default: return l10n.t('Linux bash');
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
			if (found) {return found;}
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

/** Agent 专用终端（不占用用户的活动终端：可能是 ssh 会话 / REPL / 正在跑的构建） */
let _agentTerminal: vscode.Terminal | undefined;

/**
 * 获取 Agent 专用终端。
 * 语义变更：以前复用 `vscode.window.activeTerminal`，模型命令会直接打进用户正在用的会话里，
 * 输出与用户自己的命令混在一起、还会误伤交互式进程。现在改为独占一个名为 "Kodrix Agent" 的终端。
 * （需要把命令发给用户指定终端时，显式传 `options.terminal`）
 */
export function ensureTerminal(): vscode.Terminal {
	if (_agentTerminal && _agentTerminal.exitStatus === undefined) {
		return _agentTerminal;
	}
	_agentTerminal = vscode.window.createTerminal({ name: 'Kodrix Agent' });
	return _agentTerminal;
}

/** 释放 Agent 终端引用（终端被用户关闭 / 扩展卸载时调用） */
export function releaseAgentTerminal(): void {
	_agentTerminal = undefined;
}

/** 危险命令模式（默认拦截；可用 kodrix.agentLoop.allowDangerousCommands 显式放开） */
const DANGEROUS_COMMAND_PATTERNS: { re: RegExp; why: string }[] = [
	{ re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, why: l10n.t('recursive/forced delete (rm -rf)') },
	{ re: /\bgit\s+reset\s+--hard\b/i, why: l10n.t('discard uncommitted changes (git reset --hard)') },
	{ re: /\bgit\s+clean\s+-[a-z]*[fd]/i, why: l10n.t('delete untracked files (git clean -fd)') },
	{ re: /\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b)/i, why: l10n.t('force push (git push --force)') },
	{ re: /\b(del|erase)\s+\/[a-z]*[fsq]/i, why: l10n.t('forced/silent delete (del /f /s /q)') },
	{ re: /\b(format|mkfs(\.\w+)?)\s+[a-z]:?/i, why: l10n.t('format a disk') },
	{ re: /\b(shutdown|reboot|halt)\b/i, why: l10n.t('shut down/reboot the machine') },
	{ re: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, why: l10n.t('fork bomb') },
	{ re: /\b(curl|wget)\b[^\n|]*\|\s*(ba)?sh\b/i, why: l10n.t('pipe a remote script straight into a shell') },
	{ re: /\bchmod\s+-R\s+777\b/i, why: l10n.t('recursively open all permissions') },
	{ re: /\b(npm|pnpm|yarn)\s+publish\b/i, why: l10n.t('publish a package (irreversible)') },
];

/** 判定是否危险命令（返回原因；null 表示安全） */
export function dangerousCommandReason(command: string): string | null {
	for (const { re, why } of DANGEROUS_COMMAND_PATTERNS) {
		if (re.test(command)) {
			return why;
		}
	}
	return null;
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
	vscode.window.showInformationMessage(l10n.t('Terminal ran: {0}', command.length > 60 ? command.slice(0, 60) + '…' : command));
}

/** 阶段 3：确认 / 编辑命令（Enter / Cmd+Enter 运行 · 复制按钮 · Esc 取消） */
async function confirmCommand(initial: string, terminal: vscode.Terminal): Promise<void> {
	const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
	qp.title = l10n.t('Terminal AI — confirm command');
	qp.placeholder = l10n.t('Enter / Cmd+Enter to run · Copy button to copy · Esc to cancel');
	qp.value = initial;
	qp.items = [
		{ label: l10n.t('$(play) Run in Terminal'), description: l10n.t('Enter or Cmd+Enter'), alwaysShow: true },
		{ label: l10n.t('$(copy) Copy Command'), description: l10n.t('Click the copy button in the top-right corner'), alwaysShow: true },
	];
	qp.activeItems = [qp.items[0]];
	qp.buttons = [
		{ iconPath: new vscode.ThemeIcon('copy'), tooltip: l10n.t('Copy the command to the clipboard') },
	];

	await setPending(initial, qp);

	qp.onDidChangeValue(value => {
		void setPending(value, qp);
	});

	qp.onDidTriggerButton(async () => {
		await vscode.env.clipboard.writeText(qp.value);
		vscode.window.showInformationMessage(l10n.t('Command copied to clipboard'));
	});

	qp.onDidAccept(async () => {
		const command = qp.value.trim();
		qp.hide();
		await setPending(undefined);
		if (!command) {
			return;
		}
		sendToTerminal(terminal, command);
		vscode.window.showInformationMessage(l10n.t('Terminal ran: {0}', command.length > 60 ? command.slice(0, 60) + '…' : command));
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
		title: l10n.t('Terminal AI — describe the command to run'),
		prompt: l10n.t('Describe the action in natural language; or type a command directly'),
		placeHolder: l10n.t('e.g., start the dev server and open the browser'),
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
	gen.title = l10n.t('Terminal AI — generating command…');
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
	/** 是否由用户取消（而非自然超时）：取消时已向终端发送 Ctrl+C */
	cancelled?: boolean;
}

/** shell integration API 的类型视图（能力检测用，避免强依赖高版本 API） */
interface ShellExecutionEvent {
	terminal: vscode.Terminal;
	execution: {
		onDidEnd(cb: () => unknown): vscode.Disposable;
		exitCode?: number;
		/** 本次执行的命令行（用于确认"结束的是我们发出的那条命令"） */
		commandLine?: { value?: string };
	};
}

/**
 * 在终端执行命令并捕获输出（供 Agent / 自动化使用）。
 * 完成检测优先使用 shell integration（VS Code 1.93+），不可用时按超时兜底。
 */
export async function runCommandInTerminal(
	command: string,
	options: { terminal?: vscode.Terminal; timeoutMs?: number; token?: vscode.CancellationToken; allowDangerous?: boolean } = {},
): Promise<CommandResult> {
	if (!vscode.workspace.isTrusted) {
		// 不受信任工作区里的命令可能来自工作区内的文件/提示词，直接拒绝执行
		throw new Error(l10n.t('Terminal command execution is disabled in untrusted workspaces (trust the workspace first).'));
	}
	// 危险命令拦截（默认开启；kodrix.agentLoop.allowDangerousCommands 可显式放开）
	const allowDangerous = options.allowDangerous
		?? vscode.workspace.getConfiguration('kodrix.agentLoop').get<boolean>('allowDangerousCommands', false);
	if (!allowDangerous) {
		const reason = dangerousCommandReason(command);
		if (reason) {
			logger.warn(`[TerminalAI] 已拦截危险命令（${reason}）：${command.slice(0, 200)}`);
			throw new Error(l10n.t('Dangerous command blocked ({0}). If you really need to run it, enable kodrix.agentLoop.allowDangerousCommands in settings, or run it manually in the terminal.', reason));
		}
	}
	const timeoutMs = options.timeoutMs ?? TERMINAL_AI_RUN_TIMEOUT_MS;
	const terminal = options.terminal ?? ensureTerminal();
	const output: string[] = [];
	const disposables: vscode.Disposable[] = [];
	let settled = false;
	let incompleteTimer: ReturnType<typeof setTimeout> | undefined;

	/** 向终端发送 Ctrl+C，中断当前前台命令（超时/取消时调用） */
	const interruptRunningCommand = (why: string): void => {
		try {
			terminal.sendText('\u0003', false);
			logger.info(`[TerminalAI] 已向终端发送 Ctrl+C（${why}）`);
		} catch {
			/* 终端可能已关闭：忽略 */
		}
	};

	const cleanup = (): void => {
		for (const d of disposables) {
			d.dispose();
		}
		if (incompleteTimer) {
			clearTimeout(incompleteTimer);
			incompleteTimer = undefined;
		}
	};

	return new Promise<CommandResult>(resolve => {
		const finish = (extra?: Partial<CommandResult>): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			clearTimeout(timer);
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
			const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();
			const expected = normalize(command);
			disposables.push(win.onDidStartTerminalShellExecution!(e => {
				if (e.terminal !== terminal) {
					return;
				}
				// 校验命令行：同一终端里若有人手输命令、或上一条命令尚未结束，
				// 只按"终端相同"就认账会把它的结束当成本次命令的结果（退出码/输出错配）
				const actual = e.execution.commandLine?.value;
				if (actual && expected) {
					const a = normalize(actual);
					if (a !== expected && !a.includes(expected) && !expected.includes(a)) {
						logger.info(`[TerminalAI] 忽略非本次命令的 execution 结束：${a.slice(0, 120)}`);
						return;
					}
				}
				disposables.push(e.execution.onDidEnd(() => {
					finish({ exitCode: e.execution.exitCode });
				}));
			}));
		}

		// 超时兜底：同时向终端发 Ctrl+C，避免"Agent 已结束但命令还在跑"
		const timer = setTimeout(() => {
			interruptRunningCommand('超时');
			finish({ timedOut: true });
		}, timeoutMs);

		// 取消：同样中断前台命令（此前只是停止等待，dev server / 迁移脚本会继续跑）
		if (options.token) {
			disposables.push(options.token.onCancellationRequested(() => {
				if (settled) {
					return;
				}
				interruptRunningCommand('已取消');
				finish({ timedOut: true, cancelled: true });
			}));
		}

		// 无 shell integration 时：短等待后返回已捕获输出（尽力而为，标记 incomplete）
		// 定时器存入 incompleteTimer，由 finish→cleanup 统一清理（此前是游离定时器，泄漏且无法取消）
		if (!supportsShellIntegration) {
			incompleteTimer = setTimeout(() => finish({ incomplete: true, timedOut: false }), 2000);
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
