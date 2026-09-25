"use strict";
/*---------------------------------------------------------------------------------------------
 *  Kodrix Agent OS — 竞品精华整合 + 越用越聪明
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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const acpRegistry_1 = require("./acp/acpRegistry");
const arenaCompare_1 = require("./arena/arenaCompare");
const contextIntelligence_1 = require("./context/contextIntelligence");
const proactiveContext_1 = require("./context/proactiveContext");
const hooksPresets_1 = require("./hooks/hooksPresets");
const agentKanban_1 = require("./kanban/agentKanban");
const learningEngine_1 = require("./learning/learningEngine");
const sessionLearning_1 = require("./learning/sessionLearning");
const projectMemory_1 = require("./memory/projectMemory");
const propertyTests_1 = require("./testing/propertyTests");
const agentRouter_1 = require("./router/agentRouter");
const specWorkflow_1 = require("./spec/specWorkflow");
const specWorkbench_1 = require("./spec/specWorkbench");
const repoWiki_1 = require("./wiki/repoWiki");
const kodrixHub_1 = require("./experience/kodrixHub");
const workspaceBootstrap_1 = require("./experience/workspaceBootstrap");
const statusBar_1 = require("./experience/statusBar");
const agentCrew_1 = require("./crew/agentCrew");
const rulesManager_1 = require("./context/rulesManager");
const checkpointManager_1 = require("./checkpoint/checkpointManager");
const modelRouter_1 = require("./model/modelRouter");
const userProfile_1 = require("./profile/userProfile");
const tabCompletion_1 = require("./completion/tabCompletion");
const backgroundAgent_1 = require("./background/backgroundAgent");
const crewVisualizer_1 = require("./crew/crewVisualizer");
const agentLoop_1 = require("./agent/agentLoop");
const subagent_1 = require("./agent/subagent");
const threads_1 = require("./agent/threads");
const applyManager_1 = require("./apply/applyManager");
const terminalAi_1 = require("./terminal/terminalAi");
const vibeCoding_1 = require("./experience/vibeCoding");
const ideaFlow_1 = require("./experience/ideaFlow");
const agentStateBridge_1 = require("./experience/agentStateBridge");
const index_1 = require("./codebase/index");
const semanticIndex_1 = require("./codebase/semanticIndex");
const embeddingProvider_1 = require("./codebase/embeddingProvider");
const indexManager_1 = require("./codebase/indexManager");
const settingsPage_1 = require("./codebase/settingsPage");
const logger_1 = require("./logger");
const panelTracker_1 = require("./utils/panelTracker");
const constants_1 = require("./shared/constants");
async function showAgentOsWelcome() {
    const doc = await vscode.workspace.openTextDocument({
        content: `# Kodrix Agent OS — 让软件开发回归想法本身

## 🆕 Idea Flow — 想法到产品的全自动流水线

| 能力 | 快捷键 | 说明 |
|------|--------|------|
| **Idea Flow 启动** | \`Ctrl+Shift+I\` | 输入想法 → AI 全自动分析→规划→构建→预览 |
| **Idea Canvas** | \`Ctrl+Shift+Alt+I\` | 可视化想法画布，支持语音输入 |
| **智能路由 3.0** | \`Ctrl+Shift+Alt+R\` | 加权评分 + 自动路由到 Idea/Spec/Plan/Agent/Ask |

**核心理念：** 用户在 Idea Canvas 中描述想法，AI 自动完成：
1. 深度分析（LLM 评估 + 技术选型）
2. 自动规划（Spec 文档 + Agent Crew 配置）
3. 多 Agent 协同开发（架构师→开发者→测试者）
4. 自动构建预览（Dev Server + 浏览器预览）
5. 知识沉淀（Learning Engine 越用越聪明）

## 核心差异化：越用越聪明

| 能力 | 命令 | 说明 |
|------|------|------|
| **Semantic Memory** | 自动向量索引 | 零依赖 TF-IDF 语义检索，30 天衰减权重 |
| **Proactive Context** | 打开文件自动分析 | 当前文件相关记忆自动关联（状态栏显示） |
| **Learning Dashboard** | \`Kodrix: Learning 学习仪表盘\` | 交互式图表 + 搜索过滤 + 类别分布 |
| **Session Learning** | Agent 结束自动蒸馏 | Stop Hook → LLM 摘要 → Memory + Semantic 索引 |
| **Codebase Intelligence** | 自动索引 | AST 级全工程符号索引 + 依赖图 + 调用图 |

## Codebase Intelligence — 全工程语义理解（全新）

| 能力 | 入口 | 对标超越 |
|------|------|---------|
| **01 全工程级语义索引** | 启动时自动构建 | Sourcegraph + JetBrains 全量分析 |
| **02 上下文精准预测补全** | 编辑时自动触发 | Copilot NES + Cursor Tab |
| **03 自然语言代码问答** | \`@codebase\` 或命令面板 | Cody + Copilot Chat |

## 竞品精华整合（全内置）

| 竞品 | 核心能力 | Kodrix 超越 |
|------|---------|-------------|
| **Cursor / Windsurf** | Cascade / Agent | **Idea Flow** — 从想法到产品全自动 |
| **Lovable / Bolt.new / v0** | 一句话生成 | **Idea Canvas** — 深度分析 + 多 Agent 协同 |
| **Devin** | 多 Agent 协作 | **Agent Crew** — 自动编排 + 知识沉淀 |
| **Qoder** | Repo Wiki / Quest | 自动 Wiki + Agent Kanban 看板 |
| **Kiro** | Spec 驱动 / Hooks | 三栏 Spec Editor + Hooks 预置 |

## 新能力速览

| 能力 | 快捷键 | 对标超越 |
|------|--------|---------|
| **Idea Flow** | \`Ctrl+Shift+I\` | Lovable + Devin + Cascade |
| **Idea Canvas** | \`Ctrl+Shift+Alt+I\` | 可视化想法画布 |
| **Vibe Coding** | \`Ctrl+Shift+V\` | Windsurf Cascade / Lovable |
| **智能路由 3.0** | \`Ctrl+Shift+Alt+R\` | 加权评分 + 自动执行 |
| **Agent Crew 2.0** | \`Kodrix: 创建 Agent Crew\` | 自动编排 + 任务依赖图 |
| **Semantic Memory** | 自动运行 | 零依赖向量检索 |
| **Learning Dashboard** | \`Ctrl+Shift+Alt+M\` | 交互式 Webview |
| **Kodrix Hub** | \`Ctrl+Shift+H\` | 指挥中心 + 实时统计 |

## 快捷键速查

| 键 | 功能 |
|----|------|
| \`Ctrl+Shift+I\` | **Idea Flow** — 想法→产品（主入口） |
| \`Ctrl+Shift+Alt+I\` | Idea Canvas 画布 |
| \`Ctrl+Shift+H\` | Hub 指挥中心 |
| \`Ctrl+Shift+V\` | Vibe Coding 快捷入口 |
| \`Ctrl+Shift+A\` | Agents 窗口 |
| \`Ctrl+Shift+Alt+R\` | 智能路由 |
| \`Ctrl+Shift+Alt+K\` | Spec 三栏工作台 |
| \`Ctrl+Shift+Alt+M\` | 沉淀知识 / 学习仪表盘 |
| \`Ctrl+L\` | Chat 面板 |
| \`Ctrl+I\` | Agent 模式 |

数据目录：工作区 \`.kodrix/\` · 用户 \`~/.kodrix/\`
`,
        language: 'markdown',
    });
    await vscode.window.showTextDocument(doc);
}
/** 语义检索 Embedding：设置 kodrix.semanticEmbedding.enabled + apiKey 即启用（默认智谱 embedding-3） */
function syncEmbeddingProvider() {
    const cfg = vscode.workspace.getConfiguration('kodrix.semanticEmbedding');
    const enabled = cfg.get('enabled', false);
    const apiKey = cfg.get('apiKey', '');
    if (enabled && apiKey.trim()) {
        (0, semanticIndex_1.registerEmbeddingProvider)((0, embeddingProvider_1.createZhipuEmbeddingProvider)({
            apiKey: apiKey.trim(),
            endpoint: cfg.get('endpoint', embeddingProvider_1.ZHIPU_DEFAULT_ENDPOINT),
            model: cfg.get('model', embeddingProvider_1.ZHIPU_DEFAULT_MODEL),
        }));
        logger_1.logger.info('[Kodrix] 语义检索已接入 Embedding（智谱 embedding-3）');
    }
    else {
        (0, semanticIndex_1.clearEmbeddingProvider)();
    }
}
function activate(context) {
    // ── 错误边界：确保扩展激活失败时有用户可见的错误信息，
    //        而不是静默失败（大厂工程化标准要求）。
    try {
        activateInternal(context);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger_1.logger.error('Agent OS activation failed', err);
        vscode.window.showErrorMessage(vscode_1.l10n.t('Kodrix Agent OS 激活失败: {0}', msg));
    }
}
function activateInternal(context) {
    // Register all commands and event listeners immediately (lightweight)
    (0, contextIntelligence_1.registerContextIntelligence)(context);
    (0, proactiveContext_1.registerProactiveContext)(context);
    (0, learningEngine_1.registerLearningEngine)(context);
    (0, sessionLearning_1.registerSessionLearning)(context);
    (0, repoWiki_1.registerWiki)(context);
    (0, specWorkflow_1.registerSpec)(context);
    (0, specWorkbench_1.registerSpecWorkbench)(context);
    (0, projectMemory_1.registerMemory)(context);
    (0, agentKanban_1.registerKanban)(context);
    (0, agentRouter_1.registerRouter)(context);
    (0, arenaCompare_1.registerArena)(context);
    (0, hooksPresets_1.registerHooks)(context);
    syncEmbeddingProvider();
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('kodrix.semanticEmbedding')) {
            syncEmbeddingProvider();
        }
    }));
    (0, acpRegistry_1.registerAcp)(context);
    (0, propertyTests_1.registerPropertyTests)(context);
    (0, kodrixHub_1.registerKodrixHub)(context);
    (0, workspaceBootstrap_1.registerWorkspaceBootstrap)(context);
    (0, statusBar_1.registerStatusBar)(context);
    (0, agentCrew_1.registerAgentCrew)(context);
    (0, rulesManager_1.registerRules)(context);
    (0, checkpointManager_1.registerCheckpoints)(context);
    (0, modelRouter_1.registerModelRouter)(context);
    (0, userProfile_1.registerUserProfile)(context);
    (0, tabCompletion_1.registerTabCompletion)(context);
    (0, backgroundAgent_1.registerBackgroundAgent)(context);
    (0, crewVisualizer_1.registerCrewVisualizer)(context);
    (0, agentLoop_1.registerAgentLoop)(context);
    (0, subagent_1.registerSubagent)(context);
    (0, threads_1.registerThreads)(context);
    (0, applyManager_1.registerApplyManager)(context);
    (0, terminalAi_1.registerTerminalAI)(context);
    (0, vibeCoding_1.registerVibeCoding)(context);
    (0, ideaFlow_1.registerIdeaFlow)(context);
    (0, agentStateBridge_1.registerAgentStateListener)(context);
    // ── 全工程级语义索引（三大核心能力） ──
    (0, index_1.registerPredictiveCompletion)(context);
    (0, index_1.registerCodebaseChatParticipant)(context);
    // 「索引与文档」管理面板（对标 Cursor 代码库索引视图）
    (0, indexManager_1.registerIndexManager)(context);
    // Kodrix Settings — 设置编辑器内嵌自定义设置页（仿 Cursor Settings）
    (0, settingsPage_1.registerSettingsPage)(context);
    // 后台启动项目索引构建 + 文件监听
    (0, index_1.startIndexWatcher)(context);
    const codebaseEnabled = vscode.workspace.getConfiguration(constants_1.CONFIG_FEATURES)
        .get(constants_1.FEATURE_FLAGS.codebaseIntelligence, true);
    const initialIndexTimer = setTimeout(() => {
        if (!codebaseEnabled)
            return;
        // 尊重「索引新文件夹」开关：关闭时不做自动索引
        if (!vscode.workspace.getConfiguration('kodrix.codebase').get('autoIndexNewFolders', true)) {
            logger_1.logger.info('[ProjectIndexer] Initial index skipped (索引新文件夹 关闭)');
            return;
        }
        void (0, index_1.ensureProjectIndex)().catch(err => logger_1.logger.error('Codebase intelligence: initial index build failed', err));
    }, constants_1.INITIAL_INDEX_DELAY_MS);
    context.subscriptions.push({ dispose: () => clearTimeout(initialIndexTimer) });
    // 手动重建索引命令
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.codebaseBuildIndex, async () => {
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode_1.l10n.t('Kodrix: 重建全工程语义索引...') }, async () => {
                const idx = await (0, index_1.ensureProjectIndex)(true);
                vscode.window.showInformationMessage(vscode_1.l10n.t('索引重建完成: {0} 个文件 · {1} 个符号 · {2}ms', idx.stats.totalFiles, idx.stats.totalSymbols, idx.stats.indexDurationMs));
            });
        }
        catch (err) {
            logger_1.logger.error('Codebase intelligence: manual index rebuild failed', err);
            vscode.window.showErrorMessage(vscode_1.l10n.t('索引重建失败：{0}', err instanceof Error ? err.message : String(err)));
        }
    }));
    // 查看索引统计命令
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.codebaseStats, async () => {
        const idx = await (0, index_1.ensureProjectIndex)();
        if (!idx) {
            vscode.window.showWarningMessage(vscode_1.l10n.t('暂无项目索引，请先打开工作区'));
            return;
        }
        const stats = idx.stats;
        const doc = await vscode.workspace.openTextDocument({
            content: [
                '# Kodrix 全工程语义索引统计',
                '',
                '| 指标 | 值 |',
                '|------|-----|',
                `| 索引版本 | v${idx.version} |`,
                `| 项目路径 | ${idx.rootPath} |`,
                `| 创建时间 | ${idx.createdAt} |`,
                `| 更新时间 | ${idx.updatedAt} |`,
                `| 文件总数 | ${stats.totalFiles} |`,
                `| 符号总数 | ${stats.totalSymbols} |`,
                `| 导入关系 | ${stats.totalImports} |`,
                `| 调用关系 | ${stats.totalCalls} |`,
                `| 索引耗时 | ${stats.indexDurationMs}ms |`,
                `| 热门符号 | ${idx.hotSymbols.length} 个 |`,
                '',
                '## 语言分布',
                '',
                ...Object.entries(stats.languageDistribution)
                    .sort((a, b) => b[1] - a[1])
                    .map(([lang, count]) => `| \`.${lang}\` | ${count} |`),
                '',
                '## Top 10 热门符号',
                '',
                '| # | 符号 | 类型 | 可见性 |',
                '|---|------|------|--------|',
                ...idx.hotSymbols.slice(0, 10).map((symId, i) => {
                    const sym = idx.symbols[symId];
                    return sym ? `| ${i + 1} | \`${sym.name}\` | ${sym.kind} | ${sym.visibility} |` : null;
                }).filter(Boolean),
            ].join('\n'),
            language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
    }));
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.agentOsWelcome, () => showAgentOsWelcome()));
}
function deactivate() {
    (0, panelTracker_1.disposeAllTrackedPanels)();
    (0, workspaceBootstrap_1.cancelBootstrapTimers)();
    (0, agentStateBridge_1.disposeAgentStateTimers)();
    (0, ideaFlow_1.disposeIdeaFlowEmitter)();
    (0, index_1.disposeIndexWatcher)();
    logger_1.logger.dispose();
}
