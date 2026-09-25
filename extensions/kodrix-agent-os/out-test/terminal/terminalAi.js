"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeCommand = sanitizeCommand;
exports.ensureTerminal = ensureTerminal;
exports.sendToTerminal = sendToTerminal;
exports.runCommandInTerminal = runCommandInTerminal;
exports.registerTerminalAI = registerTerminalAI;
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const logger_1 = require("../logger");
const constants_1 = require("../shared/constants");
/** 确认 QuickPick 打开期间的 context key（Cmd+Enter 快捷键的 when 条件） */
const TERMINAL_AI_PENDING_CONTEXT = 'kodrix.terminalAI.pending';
/** 当前待运行命令（Cmd+Enter 读取） */
let pendingCommandText = '';
/** 当前打开的确认 QuickPick（aiRun 需要隐藏它） */
let pendingQuickPick;
/** 平台对应的 Shell 提示（生成命令时注入） */
function shellHint() {
    switch (process.platform) {
        case 'win32': return vscode_1.l10n.t('Windows PowerShell');
        case 'darwin': return vscode_1.l10n.t('macOS zsh（bash 兼容）');
        default: return vscode_1.l10n.t('Linux bash');
    }
}
/** 生成命令的系统提示词 */
function buildSystemPrompt(workspacePath) {
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
function sanitizeCommand(raw) {
    let text = raw.trim();
    const fence = text.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
    if (fence) {
        text = fence[1].trim();
    }
    text = text.replace(/^["'`]+|["'`]+$/g, '').trim();
    return text.split('\n').map(l => l.trimEnd()).join('\n').trim();
}
/** 选择可用的 LLM 模型（复用 IdeaFlow 的模型族顺序） */
async function pickModel() {
    for (const family of constants_1.IDEA_FLOW_MODEL_FAMILIES) {
        try {
            const [found] = await vscode.lm.selectChatModels({ family });
            if (found)
                return found;
        }
        catch {
            // 该模型族不可用，尝试下一个
        }
    }
    return undefined;
}
/** 生成命令（无模型或失败返回空串，由调用方降级） */
async function generateCommand(intent, workspacePath) {
    const model = await pickModel();
    if (!model) {
        logger_1.logger.info('Terminal AI: no chat model available, falling back to manual input');
        return '';
    }
    const cts = new vscode.CancellationTokenSource();
    const timer = setTimeout(() => cts.cancel(), constants_1.TERMINAL_AI_GEN_TIMEOUT_MS);
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
    }
    catch (err) {
        logger_1.logger.error('Terminal AI: command generation failed', err);
        return '';
    }
    finally {
        clearTimeout(timer);
        cts.dispose();
    }
}
/** 获取可用的终端（优先活动终端，否则新建） */
function ensureTerminal() {
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
function sendToTerminal(terminal, command) {
    for (const line of command.split('\n')) {
        const t = line.trim();
        if (t) {
            terminal.sendText(t, true);
        }
    }
    terminal.show();
}
/** 设置/清除待运行命令状态（同步 context key） */
async function setPending(value, qp) {
    pendingCommandText = value ?? '';
    pendingQuickPick = qp;
    await vscode.commands.executeCommand('setContext', TERMINAL_AI_PENDING_CONTEXT, value !== undefined);
}
/** Cmd+Enter：运行当前待运行命令 */
async function runPendingCommand() {
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
    vscode.window.showInformationMessage(vscode_1.l10n.t('终端已运行：{0}', command.length > 60 ? command.slice(0, 60) + '…' : command));
}
/** 阶段 3：确认 / 编辑命令（Enter / Cmd+Enter 运行 · 复制按钮 · Esc 取消） */
async function confirmCommand(initial, terminal) {
    const qp = vscode.window.createQuickPick();
    qp.title = vscode_1.l10n.t('终端 AI — 确认命令');
    qp.placeholder = vscode_1.l10n.t('Enter / Cmd+Enter 运行 · 复制按钮复制 · Esc 取消');
    qp.value = initial;
    qp.items = [
        { label: vscode_1.l10n.t('$(play) 运行到终端'), description: vscode_1.l10n.t('Enter 或 Cmd+Enter'), alwaysShow: true },
        { label: vscode_1.l10n.t('$(copy) 复制命令'), description: vscode_1.l10n.t('点击右上角复制按钮'), alwaysShow: true },
    ];
    qp.activeItems = [qp.items[0]];
    qp.buttons = [
        { iconPath: new vscode.ThemeIcon('copy'), tooltip: vscode_1.l10n.t('复制命令到剪贴板') },
    ];
    await setPending(initial, qp);
    qp.onDidChangeValue(value => {
        void setPending(value, qp);
    });
    qp.onDidTriggerButton(async () => {
        await vscode.env.clipboard.writeText(qp.value);
        vscode.window.showInformationMessage(vscode_1.l10n.t('命令已复制到剪贴板'));
    });
    qp.onDidAccept(async () => {
        const command = qp.value.trim();
        qp.hide();
        await setPending(undefined);
        if (!command) {
            return;
        }
        sendToTerminal(terminal, command);
        vscode.window.showInformationMessage(vscode_1.l10n.t('终端已运行：{0}', command.length > 60 ? command.slice(0, 60) + '…' : command));
    });
    qp.onDidHide(() => {
        void setPending(undefined);
        qp.dispose();
    });
    qp.show();
}
/** Cmd+K：终端 AI prompt 条主流程 */
async function terminalAiPrompt() {
    // 阶段 1：输入意图
    const intent = await vscode.window.showInputBox({
        title: vscode_1.l10n.t('终端 AI — 描述要执行的命令'),
        prompt: vscode_1.l10n.t('用自然语言描述操作；也可以直接输入命令'),
        placeHolder: vscode_1.l10n.t('例如：启动开发服务器并打开浏览器'),
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
    const gen = vscode.window.createQuickPick();
    gen.title = vscode_1.l10n.t('终端 AI — 正在生成命令…');
    gen.busy = true;
    gen.enabled = false;
    gen.show();
    let command = '';
    try {
        command = await generateCommand(trimmed, workspacePath);
    }
    finally {
        gen.dispose();
    }
    if (!command) {
        // 降级：无模型或生成失败，直接使用用户输入
        command = trimmed;
    }
    // 阶段 3：确认 / 编辑
    await confirmCommand(command, terminal);
}
/**
 * 在终端执行命令并捕获输出（供 Agent / 自动化使用）。
 * 完成检测优先使用 shell integration（VS Code 1.93+），不可用时按超时兜底。
 */
async function runCommandInTerminal(command, options = {}) {
    const timeoutMs = options.timeoutMs ?? constants_1.TERMINAL_AI_RUN_TIMEOUT_MS;
    const terminal = options.terminal ?? ensureTerminal();
    const output = [];
    const disposables = [];
    let settled = false;
    const cleanup = () => {
        for (const d of disposables) {
            d.dispose();
        }
    };
    return new Promise(resolve => {
        const finish = (extra) => {
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
        const win = vscode.window;
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
            disposables.push(win.onDidStartTerminalShellExecution(e => {
                if (e.terminal !== terminal) {
                    return;
                }
                e.execution.onDidEnd(() => {
                    finish({ exitCode: e.execution.exitCode });
                });
            }));
        }
        // 超时兜底
        let timer;
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
function registerTerminalAI(context) {
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.terminalAiPrompt, () => terminalAiPrompt()));
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.terminalAiRun, () => runPendingCommand()));
}
