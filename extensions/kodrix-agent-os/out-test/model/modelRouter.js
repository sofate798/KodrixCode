"use strict";
/*---------------------------------------------------------------------------------------------
 *  Model Router — 模型 Auto 路由（对标 Cursor 多模型智能路由）
 *
 *  能力：
 *    1. 三档模型池：smart（深度分析/评审）/ balanced（编码/命令）/ fast（快速提取）
 *    2. 路由决策：精确指定（preferred）→ 任务类型自动映射档位 → 全池兜底
 *    3. 使用记录：每次路由记录 模型 / 档位 / 任务类型 / 耗时 到 .kodrix/model-router.jsonl
 *    4. 状态查看：命令「Kodrix: 模型路由状态」展示模型池与最近使用统计
 *
 *  与既有 BYOK 接入兼容：所有查找仍走 vscode.lm.selectChatModels，零外部依赖。
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
exports.TASK_TIER_MAP = void 0;
exports.resolveTier = resolveTier;
exports.recordUsage = recordUsage;
exports.recordModelCall = recordModelCall;
exports.readUsageLog = readUsageLog;
exports.getModelCandidates = getModelCandidates;
exports.routeModel = routeModel;
exports.getRouterStatus = getRouterStatus;
exports.registerModelRouter = registerModelRouter;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("../logger");
const constants_1 = require("../shared/constants");
/** 各档位模型族（按可用性顺序） */
const TIER_FAMILIES = {
    smart: constants_1.MODEL_ROUTER_TIERS.smart,
    balanced: constants_1.MODEL_ROUTER_TIERS.balanced,
    fast: constants_1.MODEL_ROUTER_TIERS.fast,
};
/** 任务类型 → 档位映射（对标 Cursor 按任务复杂度选模型） */
exports.TASK_TIER_MAP = {
    analysis: 'smart',
    review: 'smart',
    plan: 'smart',
    coding: 'balanced',
    edit: 'balanced',
    terminal: 'balanced',
    quick: 'fast',
    extract: 'fast',
};
/** 解析档位：显式 tier > 任务类型映射 > 默认 balanced */
function resolveTier(taskType, tier) {
    if (tier) {
        return tier;
    }
    if (taskType) {
        const mapped = exports.TASK_TIER_MAP[taskType.toLowerCase()];
        if (mapped) {
            return mapped;
        }
    }
    return 'balanced';
}
/** 使用日志路径（工作区 .kodrix/model-router.jsonl） */
function getUsageLogPath() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return undefined;
    }
    return path.join(folder.uri.fsPath, constants_1.WORKSPACE_KODRIX_DIR, 'model-router.jsonl');
}
/** 记录一次路由使用 */
function recordUsage(entry) {
    const p = getUsageLogPath();
    if (!p) {
        return;
    }
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf-8');
        // 滚动清理
        const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
        if (lines.length > constants_1.MODEL_ROUTER_USAGE_LOG_MAX) {
            fs.writeFileSync(p, lines.slice(-constants_1.MODEL_ROUTER_USAGE_LOG_MAX).join('\n') + '\n', 'utf-8');
        }
    }
    catch (err) {
        logger_1.logger.warn('[ModelRouter] 记录使用日志失败', err);
    }
}
/** 记录一次推理调用（成功/失败，供模型健康面板聚合成功率） */
function recordModelCall(modelName, tier, ok, durationMs, error) {
    recordUsage({ timestamp: new Date().toISOString(), modelName, tier, taskType: 'inference', durationMs, ok, error });
}
/** 读取使用记录（新→旧） */
function readUsageLog(limit = 200) {
    const p = getUsageLogPath();
    if (!p || !fs.existsSync(p)) {
        return [];
    }
    try {
        return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).slice(-limit)
            .map(l => {
            try {
                return JSON.parse(l);
            }
            catch {
                return undefined;
            }
        })
            .filter((x) => x !== undefined)
            .reverse();
    }
    catch {
        return [];
    }
}
/** 按档位在可用模型池中查找（取档位列表第一个可用模型） */
async function findInTier(tier) {
    for (const family of TIER_FAMILIES[tier]) {
        try {
            const [found] = await vscode.lm.selectChatModels({ family });
            if (found) {
                return found;
            }
        }
        catch {
            // 该模型族不可用，尝试下一个
        }
    }
    return undefined;
}
/**
 * 模型 Auto 路由主入口。
 * 优先级：preferred 精确指定 → 解析后的档位 → 全池兜底（按 smart/balanced/fast 顺序）。
 * 找不到可用模型时返回 undefined（调用方降级处理）。
 */
/** 获取按优先级排序的模型候选（供 Agent 推理循环故障转移逐个尝试） */
async function getModelCandidates(options = {}) {
    const out = [];
    const seen = new Set();
    const push = (m, tier) => {
        if (!m)
            return;
        const key = m.id || m.name;
        if (seen.has(key))
            return;
        seen.add(key);
        out.push({ model: m, tier });
    };
    // 1) 显式首选
    if (options.preferred?.trim()) {
        try {
            const [m] = await vscode.lm.selectChatModels({ family: options.preferred.trim() });
            push(m, 'balanced');
        }
        catch { /* ignore */ }
    }
    // 2) 目标档位 → 其余档位（smart → balanced → fast）
    const tier = resolveTier(options.taskType, options.tier);
    const tierOrder = [tier, ...['smart', 'balanced', 'fast'].filter(t => t !== tier)];
    for (const t of tierOrder) {
        for (const family of TIER_FAMILIES[t]) {
            try {
                const found = await vscode.lm.selectChatModels({ family });
                for (const m of found)
                    push(m, t);
            }
            catch { /* ignore */ }
        }
    }
    // 3) 兜底：任意模型
    if (!out.length) {
        try {
            const all = await vscode.lm.selectChatModels({});
            for (const m of all)
                push(m, 'balanced');
        }
        catch { /* ignore */ }
    }
    return out;
}
async function routeModel(options = {}) {
    const enabled = vscode.workspace.getConfiguration(constants_1.MODEL_ROUTER_CONFIG)
        .get(constants_1.MODEL_ROUTER_CONFIG_KEYS.enabled, true);
    if (!enabled) {
        // 关闭时退化为「任意可用模型」
        try {
            const [m] = await vscode.lm.selectChatModels({});
            return m ? { model: m, tier: 'balanced' } : undefined;
        }
        catch {
            return undefined;
        }
    }
    const start = Date.now();
    // 1) 精确指定（preferred family）
    if (options.preferred?.trim()) {
        try {
            const [found] = await vscode.lm.selectChatModels({ family: options.preferred.trim() });
            if (found) {
                recordUsage({ timestamp: new Date().toISOString(), modelName: found.name, tier: 'balanced', taskType: options.taskType, durationMs: Date.now() - start });
                return { model: found, tier: 'balanced' };
            }
        }
        catch {
            // 继续走档位
        }
    }
    // 2) 解析档位并查找
    const tier = resolveTier(options.taskType, options.tier);
    const tierModel = await findInTier(tier);
    if (tierModel) {
        recordUsage({ timestamp: new Date().toISOString(), modelName: tierModel.name, tier, taskType: options.taskType, durationMs: Date.now() - start });
        return { model: tierModel, tier };
    }
    // 3) 兜底：按 smart → balanced → fast 顺序全池查找
    for (const fallback of ['smart', 'balanced', 'fast']) {
        if (fallback === tier) {
            continue;
        }
        const m = await findInTier(fallback);
        if (m) {
            recordUsage({ timestamp: new Date().toISOString(), modelName: m.name, tier: fallback, taskType: options.taskType, durationMs: Date.now() - start });
            return { model: m, tier: fallback };
        }
    }
    // 4) 最终兜底：任意可用
    try {
        const [m] = await vscode.lm.selectChatModels({});
        if (m) {
            recordUsage({ timestamp: new Date().toISOString(), modelName: m.name, tier: 'balanced', taskType: options.taskType, durationMs: Date.now() - start });
            return { model: m, tier: 'balanced' };
        }
    }
    catch {
        // ignore
    }
    return undefined;
}
/** 模型路由状态：各档位模型池（含可用性）+ 最近使用统计 */
function getRouterStatus() {
    const usage = readUsageLog(200);
    const counts = new Map();
    for (const u of usage) {
        const cur = counts.get(u.modelName) ?? { count: 0, okCount: 0, totalMs: 0 };
        cur.count++;
        if (u.ok !== false)
            cur.okCount++;
        cur.totalMs += u.durationMs;
        if (u.ok === false)
            cur.lastError = u.error ?? '调用失败';
        cur.lastAt = u.timestamp;
        counts.set(u.modelName, cur);
    }
    const usageStats = [...counts.entries()]
        .map(([modelName, v]) => ({
        modelName,
        count: v.count,
        okCount: v.okCount,
        failCount: v.count - v.okCount,
        successRate: v.count ? Math.round((v.okCount / v.count) * 100) : 0,
        avgDurationMs: Math.round(v.totalMs / v.count),
        lastAt: v.lastAt,
        lastError: v.lastError,
    }))
        .sort((a, b) => b.count - a.count);
    return { pools: { smart: [...TIER_FAMILIES.smart], balanced: [...TIER_FAMILIES.balanced], fast: [...TIER_FAMILIES.fast] }, usage, usageStats };
}
/** 注册模型路由命令 */
/** 模型健康面板 HTML（静态表格 + 刷新按钮，深色主题贴合 VS Code） */
function renderHealthHtml(status) {
    const rows = status.usageStats.length
        ? status.usageStats.map(s => {
            const rate = s.successRate;
            const rateColor = rate >= 90 ? '#3fb950' : rate >= 60 ? '#d29922' : '#f85149';
            return `<tr>
	<td>${s.modelName}</td>
	<td>${s.count}</td>
	<td style="color:${rateColor};font-weight:600">${s.successRate}%</td>
	<td>${s.failCount}</td>
	<td>${s.avgDurationMs}ms</td>
	<td title="${(s.lastError ?? '').replace(/"/g, '&quot;')}">${s.lastError ? s.lastError.slice(0, 40).replace(/</g, '&lt;') : '—'}</td>
	<td>${(s.lastAt ?? '').slice(11, 19) || '—'}</td>
</tr>`.trim();
        }).join('')
        : '<tr><td colspan="7" style="text-align:center;color:#8b949e">（暂无调用记录——运行任意 Agent 任务后刷新）</td></tr>';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><style>
body{background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);padding:16px;font-size:13px}
h1{font-size:16px;margin:0 0 4px}
.sub{color:var(--vscode-descriptionForeground);margin:0 0 14px;font-size:12px}
table{border-collapse:collapse;width:100%}
th{text-align:left;color:var(--vscode-descriptionForeground);font-size:11px;text-transform:uppercase;padding:5px 8px;border-bottom:1px solid var(--vscode-panel-border)}
td{padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border)}
.sec{margin-top:18px;font-size:13px;font-weight:600}
.btn{margin-top:10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:4px 12px;border-radius:4px;cursor:pointer}
.btn:hover{background:var(--vscode-button-hoverBackground)}
.bar{height:6px;background:var(--vscode-progressBar-background);border-radius:3px;margin:10px 0 2px}
.tiers{display:flex;gap:18px;flex-wrap:wrap;margin-top:8px}
.tier{font-size:12px}
.tier b{display:block;margin-bottom:2px}
</style></head>
<body>
<h1>模型健康面板</h1>
<p class="sub">调用成功率按 .kodrix/model-router.jsonl 聚合（ok=false 记失败）· 推理打点：Agent Loop / 路由选择</p>
<table>
<tr><th>模型</th><th>调用</th><th>成功率</th><th>失败</th><th>平均耗时</th><th>最后错误</th><th>最后调用</th></tr>
${rows}
</table>
<div class="sec">模型池</div>
<div class="tiers">
	<div class="tier"><b>smart</b>${status.pools.smart.join(' · ')}</div>
	<div class="tier"><b>balanced</b>${status.pools.balanced.join(' · ')}</div>
	<div class="tier"><b>fast</b>${status.pools.fast.join(' · ')}</div>
</div>
<div class="bar"></div>
<button class="btn" onclick="refresh()">刷新</button>
<script>const vscode=acquireVsCodeApi();function refresh(){vscode.postMessage({command:'refresh'})}</script>
</body></html>`;
}
function registerModelRouter(context) {
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.modelRouterStatus, async () => {
        const panel = vscode.window.createWebviewPanel('kodrix.modelHealth', '模型健康面板', vscode.ViewColumn.Active, { enableScripts: true });
        panel.webview.html = renderHealthHtml(getRouterStatus());
        panel.webview.onDidReceiveMessage(msg => {
            if (msg?.command === 'refresh')
                panel.webview.html = renderHealthHtml(getRouterStatus());
        });
    }));
}
