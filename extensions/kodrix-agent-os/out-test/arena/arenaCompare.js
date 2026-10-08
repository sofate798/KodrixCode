"use strict";
/*---------------------------------------------------------------------------------------------
 *  Arena 双模型对比 — Windsurf Arena 风格
 *
 *  大厂工程化标准：
 *   1. CancellationTokenSource 必须在 finally 中 dispose，防止资源泄漏
 *   2. 所有配置键使用共享常量，消除魔术字符串
 *   3. 原子文件写入（先写临时文件再 rename）
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
exports.compareModels = compareModels;
exports.registerArena = registerArena;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const paths_1 = require("../paths");
const constants_1 = require("../shared/constants");
/**
 * 执行单个模型推理，返回模型输出文本。
 *
 * 关键优化：CancellationTokenSource 使用 try/finally 确保资源释放。
 */
async function runModelPrompt(model, prompt, label) {
    const cts = new vscode.CancellationTokenSource();
    try {
        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        const response = await model.sendRequest(messages, {}, cts.token);
        let text = '';
        for await (const chunk of response.stream) {
            if (chunk instanceof vscode.LanguageModelTextPart) {
                text += chunk.value;
            }
        }
        return text || vscode_1.l10n.t('({0} no response)', label);
    }
    finally {
        cts.dispose();
    }
}
async function compareModels(prompt) {
    const enabled = vscode.workspace.getConfiguration(constants_1.CONFIG_FEATURES)
        .get(constants_1.FEATURE_FLAGS.arena, true);
    if (!enabled) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('Arena is off. Enable {0} in settings', `${constants_1.CONFIG_FEATURES}.${constants_1.FEATURE_FLAGS.arena}`));
        return;
    }
    const userPrompt = prompt || await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('Arena: enter the same prompt to compare two models in parallel'),
        placeHolder: vscode_1.l10n.t('How do I implement JWT refresh tokens?'),
    });
    if (!userPrompt?.trim()) {
        return;
    }
    const models = await vscode.lm.selectChatModels({});
    if (models.length < 1) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('No language model available. Configure one in Manage Models.'));
        return;
    }
    const cfg = vscode.workspace.getConfiguration(constants_1.CONFIG_ARENA);
    const modelAName = cfg.get(constants_1.ARENA_CONFIG.modelA, '');
    const modelBName = cfg.get(constants_1.ARENA_CONFIG.modelB, '');
    let modelA = modelAName
        ? models.find(m => m.name.includes(modelAName) || m.id.includes(modelAName))
        : models[0];
    let modelB = modelBName
        ? models.find(m => m.name.includes(modelBName) || m.id.includes(modelBName))
        : models[1];
    if (!modelA) {
        const picked = await vscode.window.showQuickPick(models.map(m => ({ label: m.name, model: m })), { placeHolder: vscode_1.l10n.t('Select model A') });
        modelA = picked?.model;
    }
    if (!modelB) {
        const picked = await vscode.window.showQuickPick(models.filter(m => m !== modelA).map(m => ({ label: m.name, model: m })), { placeHolder: vscode_1.l10n.t('Select model B') });
        modelB = picked?.model;
    }
    if (!modelA || !modelB) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('Two different models are required for comparison'));
        return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode_1.l10n.t('Arena comparing…') }, async () => {
        const [resultA, resultB] = await Promise.all([
            runModelPrompt(modelA, userPrompt, 'A'),
            runModelPrompt(modelB, userPrompt, 'B'),
        ]);
        const base = (0, paths_1.getWorkspaceKodrixDir)() || path.join(os.homedir(), '.kodrix');
        const arenaDir = path.join(base, 'arena');
        (0, paths_1.ensureDir)(arenaDir);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outPath = path.join(arenaDir, `compare-${stamp}.md`);
        const md = `${vscode_1.l10n.t('# Arena Comparison')}

> Prompt: ${userPrompt}

## ${vscode_1.l10n.t('Model A — {0}', modelA.name)}

${resultA}

---

## ${vscode_1.l10n.t('Model B — {0}', modelB.name)}

${resultB}

---

## ${vscode_1.l10n.t('Your Choice')}

- [ ] ${vscode_1.l10n.t('Model A is better')}
- [ ] ${vscode_1.l10n.t('Model B is better')}
- [ ] ${vscode_1.l10n.t('Each has strengths; merge the two')}
`;
        // 原子写入：先写临时文件，再 rename（防止进程崩溃产生不完整文件）
        const tmpPath = outPath + '.tmp';
        fs.writeFileSync(tmpPath, md, 'utf-8');
        fs.renameSync(tmpPath, outPath);
        const doc = await vscode.workspace.openTextDocument(outPath);
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage(vscode_1.l10n.t('Arena comparison finished: {0}', path.basename(outPath)));
    });
}
function registerArena(context) {
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.arenaCompare, () => compareModels()));
}
