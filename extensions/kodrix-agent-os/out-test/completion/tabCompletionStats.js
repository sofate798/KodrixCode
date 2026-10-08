"use strict";
/*---------------------------------------------------------------------------------------------
 *  Tab Completion Stats — 补全接受率反馈（对标 Cursor 接受率优化）
 *
 *  采集：建议数（每次返回补全）+1；接受数（handleDidAccept）+1；拒绝 ≈ 建议 - 接受。
 *  持久化：~/.kodrix/tabCompletionStats.json（按模式 fim/fast 拆分）。
 *  闭环：统计命令展示接受率 → 数据可供未来路由参考（getTabCompletionStats）。
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
exports.recordTabSuggestion = recordTabSuggestion;
exports.recordTabFimFailure = recordTabFimFailure;
exports.recordTabFimSkip = recordTabFimSkip;
exports.recordTabAccept = recordTabAccept;
exports.getTabCompletionStats = getTabCompletionStats;
exports.showTabCompletionStats = showTabCompletionStats;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const paths_1 = require("../paths");
const logger_1 = require("../logger");
const jsonValidator_1 = require("../utils/jsonValidator");
function getStatsPath() {
    return path.join((0, paths_1.getKodrixDir)(), 'tabCompletionStats.json');
}
function emptyStore() {
    return { total: { suggestions: 0, accepted: 0 }, byMode: {}, updatedAt: new Date().toISOString() };
}
function loadStats() {
    const p = getStatsPath();
    if (!fs.existsSync(p)) {
        return emptyStore();
    }
    try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if ((0, jsonValidator_1.isRecord)(raw) && (0, jsonValidator_1.isRecord)(raw.total)) {
            return raw;
        }
        return emptyStore();
    }
    catch {
        return emptyStore();
    }
}
function saveStats(stats) {
    try {
        fs.mkdirSync(path.dirname(getStatsPath()), { recursive: true });
        fs.writeFileSync(getStatsPath(), JSON.stringify(stats, null, 2), 'utf-8');
    }
    catch (err) {
        logger_1.logger.warn('[TabStats] 写入失败', err);
    }
}
function entryOf(stats, mode) {
    if (!(0, jsonValidator_1.isRecord)(stats.byMode[mode])) {
        stats.byMode[mode] = { suggestions: 0, accepted: 0 };
    }
    return stats.byMode[mode];
}
function fimStoreOf(stats) {
    if (!(0, jsonValidator_1.isRecord)(stats.fim)) {
        stats.fim = { failures: 0, skips: 0 };
    }
    return stats.fim;
}
/** 记录一次补全建议 */
function recordTabSuggestion(mode) {
    const stats = loadStats();
    stats.total.suggestions++;
    entryOf(stats, mode).suggestions++;
    stats.updatedAt = new Date().toISOString();
    saveStats(stats);
}
/** 记录一次 FIM 通道失败（含状态码/原因），供统计与诊断回看 */
function recordTabFimFailure(endpoint, status, reason) {
    const stats = loadStats();
    const fim = fimStoreOf(stats);
    fim.failures++;
    fim.lastFailure = { at: new Date().toISOString(), endpoint, status, reason };
    stats.updatedAt = new Date().toISOString();
    saveStats(stats);
}
/** 记录一次因熔断（端点此前返回 4xx）而被跳过的 FIM 请求 */
function recordTabFimSkip(endpoint) {
    const stats = loadStats();
    const fim = fimStoreOf(stats);
    fim.skips++;
    fim.lastSkipAt = new Date().toISOString();
    fim.lastSkipEndpoint = endpoint;
    stats.updatedAt = new Date().toISOString();
    saveStats(stats);
}
/** 记录一次补全接受 */
function recordTabAccept(mode) {
    const stats = loadStats();
    stats.total.accepted++;
    entryOf(stats, mode).accepted++;
    stats.updatedAt = new Date().toISOString();
    saveStats(stats);
}
/** 当前统计（供路由/面板参考） */
function getTabCompletionStats() {
    return loadStats();
}
function rateOf(e) {
    return e.suggestions > 0 ? e.accepted / e.suggestions : 0;
}
/** 展示补全统计（Markdown 文档）；blockedEndpoint 来自 tabCompletion 的会话级 FIM 熔断状态 */
async function showTabCompletionStats(blockedEndpoint) {
    const stats = loadStats();
    const modes = Object.keys(stats.byMode).sort();
    const rows = modes.map(m => {
        const e = stats.byMode[m];
        return `| ${m} | ${e.suggestions} | ${e.accepted} | ${e.suggestions - e.accepted} | ${(rateOf(e) * 100).toFixed(0)}% |`;
    });
    const fim = stats.fim ?? { failures: 0, skips: 0 };
    const fimLines = [
        `- 失败（含降级）：${fim.failures} 次；熔断跳过：${fim.skips} 次`,
        fim.lastFailure
            ? `- 最近失败：${fim.lastFailure.at} \`HTTP ${fim.lastFailure.status}\` ${fim.lastFailure.endpoint} —— ${fim.lastFailure.reason}`
            : '- 最近失败：无',
        blockedEndpoint
            ? `- **本会话已熔断端点**：\`${blockedEndpoint}\`（4xx 后不再重试；修改 kodrix.tabCompletion.fimEnabled / fimEndpoint 设置或重启后可恢复）`
            : '- 本会话已熔断端点：无',
    ];
    const doc = await vscode.workspace.openTextDocument({
        content: [
            '# Tab 补全接受率',
            '',
            '接受率 = 接受 / 建议（拒绝 ≈ 建议 − 接受）；按补全**实际产出通道**统计（FIM 降级结果计入 fast）',
            '',
            '| 通道 | 建议 | 接受 | 拒绝 | 接受率 |',
            '| --- | --- | --- | --- | --- |',
            ...(rows.length ? rows : ['| — | 0 | 0 | 0 | — |']),
            '',
            `累计：${stats.total.suggestions} 建议 / ${stats.total.accepted} 接受（${(rateOf(stats.total) * 100).toFixed(0)}%）`,
            '',
            '## FIM 专线诊断',
            ...fimLines,
            '',
            '数据文件：`~/.kodrix/tabCompletionStats.json`',
        ].join('\n'),
        language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { preview: false });
}
