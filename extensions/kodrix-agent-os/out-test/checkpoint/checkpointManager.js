"use strict";
/*---------------------------------------------------------------------------------------------
 *  Checkpoint Manager — 检查点回滚（对标 Cursor Checkpoint）
 *
 *  能力：
 *    1. 手动创建检查点：保存当前打开文件快照 + 标签（可随时回滚）
 *    2. 自动捕获：文件保存时自动记录版本，滚动保留最近 N 条
 *    3. 查看检查点：按时间 / 标签列出，可预览文件清单
 *    4. 回滚：将快照内容写回原文件（支持目录重建与文件重建）
 *    5. 操作日志：Crew / Idea Flow / 终端等动作记录，供检查点回顾
 *
 *  存储：.kodrix/checkpoints/<id>/manifest.json · auto/（自动捕获）· operations.jsonl
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
exports.createCheckpoint = createCheckpoint;
exports.listCheckpoints = listCheckpoints;
exports.getCheckpointFiles = getCheckpointFiles;
exports.restoreCheckpoint = restoreCheckpoint;
exports.recordOperation = recordOperation;
exports.listOperations = listOperations;
exports.autoCaptureFileSave = autoCaptureFileSave;
exports.registerCheckpoints = registerCheckpoints;
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("../logger");
const constants_1 = require("../shared/constants");
/** 检查点根目录（工作区 .kodrix/checkpoints） */
function getCheckpointRoot() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return undefined;
    }
    return path.join(folder.uri.fsPath, constants_1.WORKSPACE_KODRIX_DIR, 'checkpoints');
}
/** 相对路径判断（仅工作区内文件） */
function workspaceRelative(fsPath) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return undefined;
    }
    const rel = path.relative(folder.uri.fsPath, fsPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return undefined;
    }
    return rel;
}
/**
 * 校验 manifest 中的 relPath 不会逃出工作区（防路径穿越）。
 * 创建时已过滤；恢复时必须再校验（manifest 可能被篡改/损坏）。
 */
function resolveSafeRestorePath(workspace, relPath) {
    if (!relPath || typeof relPath !== 'string') {
        return undefined;
    }
    // 拒绝绝对路径、空段、以及含 .. 的穿越
    const normalized = path.normalize(relPath);
    if (path.isAbsolute(normalized) || normalized.split(/[\\/]/).includes('..')) {
        return undefined;
    }
    const resolved = path.resolve(workspace, normalized);
    const wsNorm = path.normalize(workspace);
    if (resolved !== wsNorm && !resolved.startsWith(wsNorm + path.sep)) {
        return undefined;
    }
    return resolved;
}
/** 是否应跳过 .kodrix 内部文件 */
function isKodrixInternal(relPath) {
    return relPath.split(/[\\/]/)[0] === constants_1.WORKSPACE_KODRIX_DIR;
}
function readManifest(id) {
    const root = getCheckpointRoot();
    if (!root) {
        return undefined;
    }
    const p = path.join(root, id, 'manifest.json');
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
    catch {
        return undefined;
    }
}
/**
 * 创建检查点：收集当前打开的（工作区内）文本文档内容快照。
 * 返回检查点 id；无工作区时返回 undefined。
 */
async function createCheckpoint(label) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const root = getCheckpointRoot();
    if (!folder || !root) {
        return undefined;
    }
    const id = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme !== 'file') {
            continue;
        }
        const rel = workspaceRelative(doc.uri.fsPath);
        if (!rel || isKodrixInternal(rel)) {
            continue;
        }
        try {
            const stat = fs.statSync(doc.uri.fsPath);
            if (stat.size > constants_1.CHECKPOINT_MAX_FILE_BYTES) {
                continue;
            }
            // 快照取磁盘已保存内容，避免用 dirty 缓冲覆盖外部更新
            const content = fs.readFileSync(doc.uri.fsPath, 'utf-8');
            files.push({ relPath: rel, content });
        }
        catch {
            continue;
        }
        if (files.length >= constants_1.CHECKPOINT_MAX_FILES_PER_SNAPSHOT) {
            logger_1.logger.warn(`[Checkpoint] 已达单次快照上限 ${constants_1.CHECKPOINT_MAX_FILES_PER_SNAPSHOT} 个文件，其余打开文档未纳入`);
            break;
        }
    }
    const manifest = {
        id,
        label: label?.trim() || '手动检查点',
        createdAt: new Date().toISOString(),
        files,
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    logger_1.logger.info(`[Checkpoint] 已创建「${manifest.label}」(${files.length} 个文件)`);
    return id;
}
/** 列出检查点（新→旧） */
function listCheckpoints() {
    const root = getCheckpointRoot();
    if (!root || !fs.existsSync(root)) {
        return [];
    }
    try {
        return fs.readdirSync(root)
            .filter(name => name !== 'auto' && name !== 'operations.jsonl')
            .map(name => {
            const m = readManifest(name);
            return {
                id: name,
                label: m?.label ?? '（无标签）',
                createdAt: m?.createdAt ?? name,
                fileCount: m?.files.length ?? 0,
            };
        })
            .filter(c => c.fileCount > 0)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    catch {
        return [];
    }
}
/** 获取检查点文件清单 */
function getCheckpointFiles(id) {
    return readManifest(id)?.files ?? [];
}
/** 回滚：将快照内容写回原文件 */
async function restoreCheckpoint(id) {
    const manifest = readManifest(id);
    if (!manifest) {
        throw new Error(`检查点不存在：${id}`);
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        throw new Error('没有打开的工作区');
    }
    let restored = 0;
    let skipped = 0;
    for (const f of manifest.files) {
        const abs = resolveSafeRestorePath(folder.uri.fsPath, f.relPath);
        if (!abs) {
            skipped++;
            logger_1.logger.warn(`[Checkpoint] 跳过不安全路径：${f.relPath}`);
            continue;
        }
        try {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, f.content, 'utf-8');
            restored++;
        }
        catch (err) {
            skipped++;
            logger_1.logger.error(`[Checkpoint] 恢复 ${f.relPath} 失败`, err);
        }
    }
    logger_1.logger.info(`[Checkpoint] 回滚「${manifest.label}」完成：${restored} 恢复，${skipped} 跳过`);
    return { restored, skipped };
}
/** operations.jsonl 滚动上限（行数） */
const OPERATIONS_MAX_LINES = 2000;
/** 记录操作日志（供检查点回顾 / 历史追踪） */
function recordOperation(op) {
    const root = getCheckpointRoot();
    if (!root) {
        return;
    }
    try {
        fs.mkdirSync(root, { recursive: true });
        const p = path.join(root, 'operations.jsonl');
        fs.appendFileSync(p, JSON.stringify(op) + '\n', 'utf-8');
        // 滚动清理，避免无限增长
        try {
            const stat = fs.statSync(p);
            if (stat.size > 512 * 1024) {
                const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
                if (lines.length > OPERATIONS_MAX_LINES) {
                    fs.writeFileSync(p, lines.slice(-OPERATIONS_MAX_LINES).join('\n') + '\n', 'utf-8');
                }
            }
        }
        catch { /* 滚动失败不影响主路径 */ }
    }
    catch (err) {
        logger_1.logger.error('[Checkpoint] 记录操作失败', err);
    }
}
/** 读取最近操作日志 */
function listOperations(limit = 50) {
    const root = getCheckpointRoot();
    if (!root) {
        return [];
    }
    const p = path.join(root, 'operations.jsonl');
    if (!fs.existsSync(p)) {
        return [];
    }
    try {
        const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
        return lines.slice(-limit)
            .map(l => {
            try {
                return JSON.parse(l);
            }
            catch {
                return undefined;
            }
        })
            .filter((x) => x !== undefined);
    }
    catch {
        return [];
    }
}
/** 自动捕获：文件保存时记录版本（滚动保留 maxEntries 条） */
function autoCaptureFileSave(doc) {
    if (!vscode.workspace.getConfiguration(constants_1.CHECKPOINT_CONFIG)
        .get(constants_1.CHECKPOINT_CONFIG_KEYS.autoCapture, true)) {
        return;
    }
    if (doc.uri.scheme !== 'file') {
        return;
    }
    const rel = workspaceRelative(doc.uri.fsPath);
    if (!rel || isKodrixInternal(rel)) {
        return;
    }
    const root = getCheckpointRoot();
    if (!root) {
        return;
    }
    try {
        const autoDir = path.join(root, 'auto');
        fs.mkdirSync(autoDir, { recursive: true });
        const stat = fs.statSync(doc.uri.fsPath);
        if (stat.size > constants_1.CHECKPOINT_MAX_FILE_BYTES) {
            return;
        }
        const id = new Date().toISOString().replace(/[:.]/g, '-');
        const entry = { relPath: rel, content: doc.getText(), savedAt: new Date().toISOString() };
        fs.writeFileSync(path.join(autoDir, `${id}-${rel.replace(/[\\/]/g, '_')}.json`), JSON.stringify(entry), 'utf-8');
        // 滚动清理：超过 maxEntries 删除最旧
        const max = vscode.workspace.getConfiguration(constants_1.CHECKPOINT_CONFIG)
            .get(constants_1.CHECKPOINT_CONFIG_KEYS.maxEntries, constants_1.CHECKPOINT_DEFAULT_MAX_ENTRIES);
        const entries = fs.readdirSync(autoDir).sort();
        for (const name of entries.slice(0, Math.max(0, entries.length - max))) {
            fs.unlinkSync(path.join(autoDir, name));
        }
    }
    catch (err) {
        logger_1.logger.error('[Checkpoint] 自动捕获失败', err);
    }
}
/** 格式化时间（列表展示） */
function formatTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
        return iso;
    }
    return d.toLocaleString();
}
/** 预览检查点文件清单 */
async function showCheckpointFilesPreview(id) {
    const files = getCheckpointFiles(id);
    const manifest = readManifest(id);
    const doc = await vscode.workspace.openTextDocument({
        content: [
            `# 检查点：${manifest?.label ?? id}`,
            '',
            `创建时间：${manifest?.createdAt ?? ''}`,
            `文件数：${files.length}`,
            '',
            '## 文件清单',
            '',
            ...files.map(f => `- \`${f.relPath}\``),
        ].join('\n'),
        language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
}
/** 注册 Checkpoint 命令与自动捕获 */
function registerCheckpoints(context) {
    // 自动捕获：文件保存
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
        autoCaptureFileSave(doc);
    }));
    // 创建检查点
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.checkpointCreate, async () => {
        const label = await vscode.window.showInputBox({
            title: vscode_1.l10n.t('创建检查点'),
            prompt: vscode_1.l10n.t('为当前代码状态打一个可回滚的标记（可留空）'),
            placeHolder: vscode_1.l10n.t('例如：Idea Flow 构建前'),
            ignoreFocusOut: true,
        });
        if (label === undefined) {
            return;
        }
        const id = await createCheckpoint(label);
        if (id) {
            vscode.window.showInformationMessage(vscode_1.l10n.t('已创建检查点：{0}', label?.trim() || vscode_1.l10n.t('手动检查点')));
        }
        else {
            vscode.window.showWarningMessage(vscode_1.l10n.t('创建检查点失败：请先打开工作区'));
        }
    }));
    // 查看检查点（选择后：回滚 / 查看文件清单）
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.checkpointList, async () => {
        const list = listCheckpoints();
        if (!list.length) {
            vscode.window.showInformationMessage(vscode_1.l10n.t('暂无检查点。使用「Kodrix: 创建检查点」，或保存文件自动捕获'));
            return;
        }
        const qp = vscode.window.createQuickPick();
        qp.title = vscode_1.l10n.t('检查点列表');
        qp.placeholder = vscode_1.l10n.t('选择检查点');
        qp.items = list.map(c => ({
            cid: c.id,
            label: `${formatTime(c.createdAt)} — ${c.label}`,
            description: vscode_1.l10n.t('{0} 个文件', c.fileCount),
        }));
        qp.onDidAccept(async () => {
            const pick = qp.activeItems[0];
            if (!pick) {
                return;
            }
            qp.hide();
            const choice = await vscode.window.showQuickPick([vscode_1.l10n.t('$(debug-restart) 回滚到该检查点'), vscode_1.l10n.t('$(files) 查看文件清单')], { title: vscode_1.l10n.t('检查点：{0}', pick.label), placeHolder: vscode_1.l10n.t('选择操作') });
            if (choice?.includes(vscode_1.l10n.t('回滚'))) {
                const ok = await vscode.window.showWarningMessage(vscode_1.l10n.t('确定回滚到「{0}」？将覆盖 {1}', pick.label, pick.description ?? ''), { modal: true }, vscode_1.l10n.t('回滚'));
                if (ok !== vscode_1.l10n.t('回滚')) {
                    return;
                }
                try {
                    const r = await restoreCheckpoint(pick.cid);
                    vscode.window.showInformationMessage(vscode_1.l10n.t('回滚完成：恢复 {0} 个文件{1}', r.restored, r.skipped ? vscode_1.l10n.t('，跳过 {0}', r.skipped) : ''));
                }
                catch (err) {
                    vscode.window.showErrorMessage(vscode_1.l10n.t('回滚失败：{0}', err instanceof Error ? err.message : String(err)));
                }
            }
            else if (choice?.includes(vscode_1.l10n.t('查看'))) {
                await showCheckpointFilesPreview(pick.cid);
            }
        });
        qp.onDidHide(() => qp.dispose());
        qp.show();
    }));
    // 回滚（快捷命令）
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.checkpointRestore, async () => {
        const list = listCheckpoints();
        if (!list.length) {
            vscode.window.showInformationMessage(vscode_1.l10n.t('暂无检查点可回滚'));
            return;
        }
        const pick = await vscode.window.showQuickPick(list.map(c => ({
            label: `${formatTime(c.createdAt)} — ${c.label}`,
            description: `${c.fileCount} 个文件`,
            cid: c.id,
        })), { title: vscode_1.l10n.t('回滚到检查点') });
        if (!pick) {
            return;
        }
        const ok = await vscode.window.showWarningMessage(vscode_1.l10n.t('确定回滚到「{0}」？将覆盖 {1}', pick.label, pick.description ?? ''), { modal: true }, vscode_1.l10n.t('回滚'));
        if (ok !== vscode_1.l10n.t('回滚')) {
            return;
        }
        try {
            const r = await restoreCheckpoint(pick.cid);
            vscode.window.showInformationMessage(vscode_1.l10n.t('回滚完成：恢复 {0} 个文件{1}', r.restored, r.skipped ? vscode_1.l10n.t('，跳过 {0}', r.skipped) : ''));
        }
        catch (err) {
            vscode.window.showErrorMessage(vscode_1.l10n.t('回滚失败：{0}', err instanceof Error ? err.message : String(err)));
        }
    }));
}
