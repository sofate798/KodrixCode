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
const constants_1 = require("../shared/constants");
const featureFlags_1 = require("../utils/featureFlags");
const PRESET_HOOKS = {
    version: 1,
    hooks: {
        afterFileEdit: [
            {
                command: 'echo Kodrix: file edited — run lint if configured',
                description: vscode_1.l10n.t('Remind to run lint after edits (replace with your project lint command)'),
            },
        ],
        stop: [
            {
                command: 'echo Kodrix: agent session completed',
                description: vscode_1.l10n.t('Log a line when the Agent finishes'),
            },
        ],
        beforeSubmitPrompt: [
            {
                command: 'echo Kodrix: prompt submitted',
                description: vscode_1.l10n.t('Audit before submitting a prompt (replace with a secrets-scanning script)'),
            },
        ],
    },
};
/**
 * 真正会被执行的 hooks 位置：`.github/hooks/hooks.json`（见 paths.getGithubHooksDir）。
 * 此前预置包写到 `.kodrix/hooks/` 与 `.cursor/hooks.json` —— 前者无人读取，后者只有 Cursor 读，
 * 于是"装完 hook 什么都不发生"。
 */
function getEffectiveHooksPath() {
    const dir = (0, paths_1.getGithubHooksDir)();
    if (!dir) {
        return undefined;
    }
    return path.join(dir, 'hooks.json');
}
/** Cursor 兼容位置：仅当用户还要在 Cursor 里用同一份 hook 时才需要 */
function getCursorHooksPath() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return undefined;
    }
    return path.join(folder.uri.fsPath, '.cursor', 'hooks.json');
}
async function installHooksPresets(context) {
    const target = await vscode.window.showQuickPick([
        { label: vscode_1.l10n.t('Session Learning (recommended)'), description: vscode_1.l10n.t('Distill project knowledge automatically on Agent Stop'), action: 'session' },
        { label: vscode_1.l10n.t('Workspace .github/hooks/hooks.json (the effective location)'), path: getEffectiveHooksPath(), scope: 'project' },
        { label: vscode_1.l10n.t('User ~/.kodrix/hooks/'), path: path.join((0, paths_1.getHooksDir)(), 'hooks.json'), scope: 'user' },
        { label: vscode_1.l10n.t('Workspace .cursor/hooks.json (for Cursor only; not read by Kodrix)'), path: getCursorHooksPath(), scope: 'cursor' },
    ].filter(o => o.action === 'session' || o.path), { placeHolder: vscode_1.l10n.t('Select Hooks installation type (Kodrix reads .github/hooks/)') });
    if (!target) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('Please open a workspace first'));
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

${vscode_1.l10n.t('Preset Hooks installed. Consider switching to **Session Learning** (\`Kodrix: Install Session Learning Hook\`), which automatically feeds the session transcript into the Learning Engine on Agent **Stop**.')}

${vscode_1.l10n.t('Replace \`command\` with the path to your actual script, for example:')}

\`\`\`json
"command": "node .github/hooks/scripts/lint-after-edit.mjs"
\`\`\`
`, 'utf-8');
    }
    vscode.window.showInformationMessage(vscode_1.l10n.t('Hooks preset package installed: {0}', target.path));
}
function registerHooks(context) {
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.hooks.installPresets', async () => {
        // 功能开关 kodrix.features.hooks（默认开）：关闭时在入口拦截并指路设置项
        if (!(0, featureFlags_1.isKodrixFeatureEnabled)(constants_1.FEATURE_FLAGS.hooks)) {
            vscode.window.showWarningMessage((0, featureFlags_1.featureDisabledNotice)(constants_1.FEATURE_FLAGS.hooks));
            return;
        }
        await installHooksPresets(context);
    }));
}
