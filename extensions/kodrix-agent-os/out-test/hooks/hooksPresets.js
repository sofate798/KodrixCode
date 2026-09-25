"use strict";
/*---------------------------------------------------------------------------------------------
 *  Hooks 预置包 — Kiro 风格 + Session Learning Stop Hook
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
exports.installHooksPresets = installHooksPresets;
exports.registerHooks = registerHooks;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const sessionLearning_1 = require("../learning/sessionLearning");
const paths_1 = require("../paths");
const PRESET_HOOKS = {
    version: 1,
    hooks: {
        afterFileEdit: [
            {
                command: 'echo Kodrix: file edited — run lint if configured',
                description: '编辑后提醒运行 lint（可替换为项目 lint 命令）',
            },
        ],
        stop: [
            {
                command: 'echo Kodrix: agent session completed',
                description: 'Agent 完成时记录日志',
            },
        ],
        beforeSubmitPrompt: [
            {
                command: 'echo Kodrix: prompt submitted',
                description: '提交前审计（可替换为 secrets 扫描脚本）',
            },
        ],
    },
};
function getProjectHooksPath() {
    const ws = (0, paths_1.getWorkspaceKodrixDir)();
    if (!ws) {
        return undefined;
    }
    return path.join(ws, 'hooks', 'hooks.json');
}
function getCursorHooksPath() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return undefined;
    }
    return path.join(folder.uri.fsPath, '.cursor', 'hooks.json');
}
async function installHooksPresets(context) {
    const target = await vscode.window.showQuickPick([
        { label: vscode_1.l10n.t('Session Learning（推荐）'), description: vscode_1.l10n.t('Agent Stop 时自动蒸馏项目知识'), action: 'session' },
        { label: vscode_1.l10n.t('工作区 .kodrix/hooks/'), path: getProjectHooksPath(), scope: 'project' },
        { label: vscode_1.l10n.t('工作区 .cursor/hooks.json（Cursor 兼容）'), path: getCursorHooksPath(), scope: 'cursor' },
        { label: vscode_1.l10n.t('用户 ~/.kodrix/hooks/'), path: path.join((0, paths_1.getHooksDir)(), 'hooks.json'), scope: 'user' },
    ].filter(o => o.action === 'session' || o.path), { placeHolder: vscode_1.l10n.t('选择 Hooks 安装类型') });
    if (!target) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('请先打开工作区'));
        return;
    }
    if (target.action === 'session') {
        await (0, sessionLearning_1.installSessionLearningHook)(context);
        return;
    }
    if (!target.path) {
        return;
    }
    (0, paths_1.ensureDir)(path.dirname(target.path));
    fs.writeFileSync(target.path, JSON.stringify(PRESET_HOOKS, null, 2), 'utf-8');
    const hooksDir = path.join(path.dirname(target.path), 'scripts');
    (0, paths_1.ensureDir)(hooksDir);
    const readme = path.join(hooksDir, 'README.md');
    if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme, `# Kodrix Hooks

预置 Hooks 已安装。推荐改用 **Session Learning**（\`Kodrix: 安装 Session Learning Hook\`），
在 Agent **Stop** 时自动将会话 transcript 送入 Learning Engine。

将 \`command\` 替换为实际脚本路径，例如：

\`\`\`json
"command": "node .kodrix/hooks/scripts/lint-after-edit.mjs"
\`\`\`
`, 'utf-8');
    }
    vscode.window.showInformationMessage(vscode_1.l10n.t('Hooks 预置包已安装：{0}', target.path));
}
function registerHooks(context) {
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.hooks.installPresets', () => installHooksPresets(context)));
}
