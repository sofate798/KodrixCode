"use strict";
/*---------------------------------------------------------------------------------------------
 *  User Profile — 全局用户偏好画像（对标 Cursor 的全局偏好记忆）
 *
 *  能力：
 *    1. 用户级画像文件（~/.kodrix/user-profile.json，跨项目共享，不随工作区隔离）
 *    2. 画像注入：Crew / 后台 Agent 执行时自动附加到上下文中（语言/语气/技术栈/风格/约束）
 *    3. 管理命令：查看/编辑画像、重置画像
 *    4. 零外部依赖（os + fs），便于单元测试
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
exports.getUserKodrixDir = getUserKodrixDir;
exports.getUserProfilePath = getUserProfilePath;
exports.loadUserProfile = loadUserProfile;
exports.saveUserProfile = saveUserProfile;
exports.getProfileInjection = getProfileInjection;
exports.registerUserProfile = registerUserProfile;
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const logger_1 = require("../logger");
const constants_1 = require("../shared/constants");
/** 用户级 Kodrix 目录 */
function getUserKodrixDir() {
    return path.join(os.homedir(), '.kodrix');
}
/** 用户画像文件路径（跨项目全局） */
function getUserProfilePath() {
    return path.join(getUserKodrixDir(), constants_1.USER_PROFILE_FILE);
}
/** 读取用户画像（不存在/损坏时返回默认） */
function loadUserProfile() {
    const p = getUserProfilePath();
    try {
        if (!fs.existsSync(p)) {
            return { ...constants_1.USER_PROFILE_DEFAULT };
        }
        const raw = fs.readFileSync(p, 'utf-8');
        const parsed = JSON.parse(raw);
        return { ...constants_1.USER_PROFILE_DEFAULT, ...parsed };
    }
    catch (err) {
        logger_1.logger.warn('[UserProfile] 读取画像失败（使用默认）', err);
        return { ...constants_1.USER_PROFILE_DEFAULT };
    }
}
/** 保存用户画像 */
function saveUserProfile(profile) {
    const p = getUserProfilePath();
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        profile.updatedAt = new Date().toISOString();
        fs.writeFileSync(p, JSON.stringify(profile, null, 2), 'utf-8');
    }
    catch (err) {
        logger_1.logger.error('[UserProfile] 保存画像失败', err);
        throw err;
    }
}
/** 生成注入到 Agent 上下文中的用户画像片段（Markdown） */
function getProfileInjection() {
    const p = loadUserProfile();
    const lines = ['## 用户偏好画像（跨项目全局，必须遵循）'];
    lines.push(`- 产出语言：${p.language?.trim() || '未设置'}`);
    lines.push(`- 语气：${p.tone?.trim() || '未设置'}`);
    if (p.techStack?.length) {
        lines.push(`- 技术栈：${p.techStack.join(', ')}`);
    }
    if (p.codingStyle?.trim()) {
        lines.push(`- 代码风格：${p.codingStyle.trim()}`);
    }
    if (p.keyConstraints?.length) {
        lines.push(`- 关键约束：${p.keyConstraints.join('；')}`);
    }
    lines.push('所有产出（代码 / 文档 / 方案 / 消息）一律遵循以上偏好，如无冲突不要另行询问。');
    return lines.join('\n');
}
/** 注册用户画像命令 */
function registerUserProfile(context) {
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.userProfileView, async () => {
        // 打开**真实文件**并注册保存即生效：此前打开的是 untitled 文档，提示却写"编辑保存后生效"，
        // 用户改完保存只会存成"无标题-N"，画像根本没变。
        const profilePath = getUserProfilePath();
        if (!fs.existsSync(profilePath)) {
            saveUserProfile({ ...constants_1.USER_PROFILE_DEFAULT });
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(profilePath));
        await vscode.window.showTextDocument(doc, { preview: false });
    }), vscode.commands.registerCommand(constants_1.COMMANDS.userProfileReset, async () => {
        // 按钮文案与比较值同源，且给出显式「取消」（破坏性操作不该只能点 ✕）
        const resetLabel = vscode_1.l10n.t('Reset');
        const ok = await vscode.window.showWarningMessage(vscode_1.l10n.t('Reset the global user preference profile? This action cannot be undone.'), { modal: true }, resetLabel, vscode_1.l10n.t('Cancel'));
        if (ok !== resetLabel) {
            return;
        }
        saveUserProfile({ ...constants_1.USER_PROFILE_DEFAULT });
        await vscode.window.showInformationMessage(vscode_1.l10n.t('User preference profile reset to defaults'));
    }), 
    // 保存画像文件 → 立即校验并生效（字段缺失用默认值补齐；JSON 坏了不覆盖当前值）
    vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.uri.fsPath !== getUserProfilePath()) {
            return;
        }
        try {
            const parsed = JSON.parse(doc.getText());
            if (!parsed || typeof parsed !== 'object') {
                throw new Error('内容不是 JSON 对象');
            }
            saveUserProfile({ ...constants_1.USER_PROFILE_DEFAULT, ...parsed });
            void vscode.window.showInformationMessage(vscode_1.l10n.t('User preference profile updated (will be injected into future Agent contexts)'));
        }
        catch (err) {
            void vscode.window.showWarningMessage(vscode_1.l10n.t('Profile not applied: JSON parse failed ({0}). Fix it and save again.', err instanceof Error ? err.message : String(err)));
        }
    }));
}
