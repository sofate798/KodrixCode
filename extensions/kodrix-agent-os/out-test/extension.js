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
const contextEvents_1 = require("./context/contextEvents");
const kodrixEventBus_1 = require("./context/kodrixEventBus");
const contextStatusBar_1 = require("./context/contextStatusBar");
const proactiveContext_1 = require("./context/proactiveContext");
const hooksPresets_1 = require("./hooks/hooksPresets");
const agentKanban_1 = require("./kanban/agentKanban");
const learningEngine_1 = require("./learning/learningEngine");
const sessionLearning_1 = require("./learning/sessionLearning");
const projectMemory_1 = require("./memory/projectMemory");
const propertyTests_1 = require("./testing/propertyTests");
const agentRouter_1 = require("./router/agentRouter");
const naturalCommandPalette_1 = require("./router/naturalCommandPalette");
const specWorkflow_1 = require("./spec/specWorkflow");
const specWorkbench_1 = require("./spec/specWorkbench");
const repoWiki_1 = require("./wiki/repoWiki");
const kodrixHub_1 = require("./experience/kodrixHub");
const kodrixLauncher_1 = require("./experience/kodrixLauncher");
const workspaceBootstrap_1 = require("./experience/workspaceBootstrap");
const statusBar_1 = require("./experience/statusBar");
const agentCrew_1 = require("./crew/agentCrew");
const rulesManager_1 = require("./context/rulesManager");
const checkpointManager_1 = require("./checkpoint/checkpointManager");
const checkpointTimelineView_1 = require("./checkpoint/checkpointTimelineView");
const checkpointDiffGallery_1 = require("./checkpoint/checkpointDiffGallery");
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
const contextKeys_1 = require("./utils/contextKeys");
const index_1 = require("./codebase/index");
const semanticIndex_1 = require("./codebase/semanticIndex");
const embeddingProvider_1 = require("./codebase/embeddingProvider");
const secretStorage_1 = require("./secretStorage");
const semanticMemory_1 = require("./learning/semanticMemory");
const indexManager_1 = require("./codebase/indexManager");
const settingsPage_1 = require("./codebase/settingsPage");
const codeLensProvider_1 = require("./codebase/codeLensProvider");
const projectIndexer_1 = require("./codebase/projectIndexer");
const logger_1 = require("./logger");
const panelTracker_1 = require("./utils/panelTracker");
const featureFlags_1 = require("./utils/featureFlags");
const constants_1 = require("./shared/constants");
async function showAgentOsWelcome() {
    const doc = await vscode.workspace.openTextDocument({
        content: vscode_1.l10n.t(`# Kodrix Agent OS — Let software development return to ideas

## 🆕 Idea Flow — Fully automated pipeline from idea to product

| Capability | Shortcut | Description |
|------------|----------|-------------|
| **Idea Flow** | \`Ctrl+Shift+I\` | Type an idea → AI automatically analyzes → plans → builds → previews |
| **Idea Canvas** | \`Ctrl+Shift+Alt+I\` | Visual idea canvas with voice input |
| **Smart Routing 3.0** | \`Ctrl+Shift+Alt+R\` | Weighted scoring + automatic routing to Idea/Spec/Plan/Agent/Ask |

**Core concept:** The user describes an idea in the Idea Canvas, and AI automatically handles:
1. Deep analysis (LLM evaluation + technology selection)
2. Automatic planning (Spec documents + Agent Crew configuration)
3. Multi-Agent collaborative development (Architect → Developer → Tester)
4. Automatic build preview (Dev Server + browser preview)
5. Knowledge retention (Learning Engine gets smarter with use)

## Core differentiator: gets smarter with use

| Capability | Command | Description |
|------------|---------|-------------|
| **Semantic Memory** | Automatic vector indexing | Zero-dependency TF-IDF semantic retrieval with 30-day decay weighting |
| **Proactive Context** | Analyzes opened files automatically | Related memories of the current file are linked automatically (shown in the status bar) |
| **Learning Dashboard** | \`Kodrix: Learning Dashboard\` | Interactive charts + search filters + category distribution |
| **Session Learning** | Auto-distills when an Agent finishes | Stop Hook → LLM summary → Memory + Semantic index |
| **Codebase Intelligence** | Automatic indexing | AST-level workspace-wide symbol index + dependency graph + call graph |

## Codebase Intelligence — workspace-wide semantic understanding (new)

| Capability | Entry point | Benchmark surpassed |
|------------|-------------|---------------------|
| **01 Workspace-wide semantic indexing** | Built automatically on startup | Sourcegraph + JetBrains full analysis |
| **02 Context-aware predictive completion** | Triggered automatically while editing | Copilot NES + Cursor Tab |
| **03 Natural-language code Q&A** | \`@codebase\` or the Command Palette | Cody + Copilot Chat |

## Best-of-breed integrations (all built in)

| Product | Core capability | How Kodrix goes further |
|---------|-----------------|-------------------------|
| **Cursor / Windsurf** | Cascade / Agent | **Idea Flow** — fully automated from idea to product |
| **Lovable / Bolt.new / v0** | One-sentence generation | **Idea Canvas** — deep analysis + multi-Agent collaboration |
| **Devin** | Multi-Agent collaboration | **Agent Crew** — automatic orchestration + knowledge retention |
| **Qoder** | Repo Wiki / Quest | Automatic Wiki + Agent Kanban board |
| **Kiro** | Spec-driven / Hooks | Three-pane Spec Editor + preset Hooks |

## New capabilities at a glance

| Capability | Shortcut | Benchmark surpassed |
|------------|----------|---------------------|
| **Idea Flow** | \`Ctrl+Shift+I\` | Lovable + Devin + Cascade |
| **Idea Canvas** | \`Ctrl+Shift+Alt+I\` | Visual idea canvas |
| **Vibe Coding** | \`Ctrl+Shift+V\` | Windsurf Cascade / Lovable |
| **Smart Routing 3.0** | \`Ctrl+Shift+Alt+R\` | Weighted scoring + automatic execution |
| **Agent Crew 2.0** | \`Kodrix: Create Agent Crew\` | Automatic orchestration + task dependency graph |
| **Semantic Memory** | Runs automatically | Zero-dependency vector retrieval |
| **Learning Dashboard** | \`Ctrl+Shift+Alt+M\` | Interactive Webview |
| **Kodrix Hub** | \`Ctrl+Shift+H\` | Command center + live statistics |

## Keyboard shortcut cheatsheet

| Key | Function |
|-----|----------|
| \`Ctrl+Shift+I\` | **Idea Flow** — idea → product (main entry) |
| \`Ctrl+Shift+Alt+I\` | Idea Canvas |
| \`Ctrl+Shift+H\` | Hub command center |
| \`Ctrl+Shift+V\` | Vibe Coding quick entry |
| \`Ctrl+Shift+A\` | Agents window |
| \`Ctrl+Shift+Alt+R\` | Smart routing |
| \`Ctrl+Shift+Alt+K\` | Three-pane Spec workbench |
| \`Ctrl+Shift+Alt+M\` | Distill knowledge / Learning Dashboard |
| \`Ctrl+L\` | Chat panel |
| \`Ctrl+I\` | Agent mode |

Data directories: workspace \`.kodrix/\` · user \`~/.kodrix/\`
`),
        language: 'markdown',
    });
    await vscode.window.showTextDocument(doc);
}
/** 语义检索 Embedding：设置 kodrix.semanticEmbedding.enabled + SecretStorage 中存有 apiKey 即启用（默认智谱 embedding-3） */
async function syncEmbeddingProvider() {
    const cfg = vscode.workspace.getConfiguration('kodrix.semanticEmbedding');
    const enabled = cfg.get('enabled', false);
    const apiKey = _extCtx ? await (0, secretStorage_1.getEmbeddingApiKey)(_extCtx) : undefined;
    if (enabled && apiKey) {
        const provider = (0, embeddingProvider_1.createZhipuEmbeddingProvider)({
            apiKey,
            endpoint: cfg.get('endpoint', embeddingProvider_1.ZHIPU_DEFAULT_ENDPOINT),
            model: cfg.get('model', embeddingProvider_1.ZHIPU_DEFAULT_MODEL),
        });
        (0, semanticIndex_1.registerEmbeddingProvider)(provider);
        (0, semanticMemory_1.setEmbeddingProvider)(provider);
        logger_1.logger.info('[Kodrix] 语义检索已接入 Embedding（智谱 embedding-3）');
    }
    else {
        (0, semanticIndex_1.clearEmbeddingProvider)();
        (0, semanticMemory_1.setEmbeddingProvider)(undefined);
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
        vscode.window.showErrorMessage(vscode_1.l10n.t('Kodrix Agent OS activation failed: {0}', msg));
    }
}
/** 模块级 ExtensionContext 引用，供 SecretStorage 读取使用 */
let _extCtx;
function activateInternal(context) {
    _extCtx = context;
    // setContext 键同步：kodrix.hasWorkspace 决定 checkpoints 视图可见性（须最先注册）
    (0, contextKeys_1.registerHasWorkspaceContext)(context);
    // Register all commands and event listeners immediately (lightweight)
    (0, contextIntelligence_1.registerContextIntelligence)(context);
    (0, contextStatusBar_1.registerContextStatusBar)(context);
    (0, contextStatusBar_1.registerToggleContextLayersCommand)(context);
    (0, proactiveContext_1.registerProactiveContext)(context);
    (0, learningEngine_1.registerLearningEngine)(context);
    (0, sessionLearning_1.registerSessionLearning)(context);
    (0, repoWiki_1.registerWiki)(context);
    (0, kodrixLauncher_1.registerLauncherView)(context);
    (0, specWorkflow_1.registerSpec)(context);
    (0, specWorkbench_1.registerSpecWorkbench)(context);
    (0, projectMemory_1.registerMemory)(context);
    (0, agentKanban_1.registerKanban)(context);
    (0, agentRouter_1.registerRouter)(context);
    (0, naturalCommandPalette_1.registerNaturalCommandPalette)(context);
    (0, arenaCompare_1.registerArena)(context);
    (0, hooksPresets_1.registerHooks)(context);
    syncEmbeddingProvider().catch(err => logger_1.logger.warn('[Kodrix] syncEmbeddingProvider failed', err));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('kodrix.semanticEmbedding')) {
            syncEmbeddingProvider().catch(err => logger_1.logger.warn('[Kodrix] syncEmbeddingProvider failed', err));
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
    (0, checkpointTimelineView_1.registerCheckpointTimeline)(context);
    (0, checkpointDiffGallery_1.registerCheckpointDiffGallery)(context);
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
    // ── Code Lens for Agents ──
    const codeLensProvider = new codeLensProvider_1.AgentCodeLensProvider();
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: 'typescript' }, codeLensProvider), vscode.languages.registerCodeLensProvider({ language: 'typescriptreact' }, codeLensProvider));
    (0, codeLensProvider_1.registerCodeLensCommands)(context);
    // 索引更新时刷新 CodeLens
    context.subscriptions.push((0, projectIndexer_1.onIndexStateChange)(() => (0, codeLensProvider_1.fireChange)()));
    // 后台启动项目索引构建 + 文件监听
    (0, index_1.startIndexWatcher)(context);
    // 代码库智能总开关：关闭后所有用户入口（启动自动索引 / 手动重建 / 统计）都不再触发索引
    const codebaseEnabled = (0, featureFlags_1.isKodrixFeatureEnabled)(constants_1.FEATURE_FLAGS.codebaseIntelligence);
    const requireCodebaseEnabled = () => {
        if (codebaseEnabled) {
            return true;
        }
        void vscode.window.showWarningMessage((0, featureFlags_1.featureDisabledNotice)(constants_1.FEATURE_FLAGS.codebaseIntelligence));
        return false;
    };
    /** 首次索引：失败必须让用户看见并能一键重试（此前只写日志，用户以为功能没做好） */
    const runInitialIndex = async () => {
        try {
            const idx = await (0, index_1.ensureProjectIndex)();
            logger_1.logger.info(`[ProjectIndexer] Initial index ready: ${idx.stats.totalFiles} files, ${idx.stats.totalSymbols} symbols`);
            // 「为即时 Grep 索引仓库」默认开启：索引完成后按开关生成一次文本清单，
            // 供 Agent 的 search 工具直接复用（此前该开关只在设置面板里点一下才有意义）
            if (vscode.workspace.getConfiguration('kodrix.codebase').get('grepIndex', true)) {
                void (0, projectIndexer_1.ensureGrepIndex)().catch(err => logger_1.logger.warn(`[ProjectIndexer] Grep 索引生成失败：${err instanceof Error ? err.message : String(err)}`));
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger_1.logger.error('Codebase intelligence: initial index build failed', err);
            // 文件数超上限：不是"失败"，而是按设置说明主动跳过自动索引 —— 给出可操作提示
            if (message.startsWith(constants_1.INDEX_TOO_MANY_FILES_PREFIX)) {
                const [, count, limit] = message.split(':');
                const indexAnyway = vscode_1.l10n.t('Index anyway');
                const openSettings = vscode_1.l10n.t('Open Index Settings');
                logger_1.logger.info(`[ProjectIndexer] 自动索引已跳过：文件数 ${count} 超过上限 ${limit}`);
                const choice = await vscode.window.showWarningMessage(vscode_1.l10n.t('The current repository has {0} files, exceeding the automatic indexing limit of {1}. Automatic indexing was skipped to avoid a long-running operation (adjust the limit in settings or rebuild manually).', count, limit), indexAnyway, openSettings);
                if (choice === indexAnyway) {
                    try {
                        const idx = await (0, index_1.ensureProjectIndex)(true, { manual: true });
                        vscode.window.showInformationMessage(vscode_1.l10n.t('Indexing complete: {0} files · {1} symbols', idx.stats.totalFiles, idx.stats.totalSymbols));
                    }
                    catch (manualErr) {
                        vscode.window.showErrorMessage(vscode_1.l10n.t('Index rebuild failed: {0}', manualErr instanceof Error ? manualErr.message : String(manualErr)));
                    }
                }
                else if (choice === openSettings) {
                    await vscode.commands.executeCommand('kodrix.codebase.indexManager.open');
                }
                return;
            }
            const retry = vscode_1.l10n.t('Retry');
            const openSettings = vscode_1.l10n.t('Open Index Settings');
            const choice = await vscode.window.showErrorMessage(vscode_1.l10n.t('Failed to build the codebase index: {0}', message), retry, openSettings);
            if (choice === retry) {
                await runInitialIndex();
            }
            else if (choice === openSettings) {
                await vscode.commands.executeCommand('kodrix.codebase.indexManager.open');
            }
        }
    };
    const initialIndexTimer = setTimeout(() => {
        if (!codebaseEnabled) {
            logger_1.logger.info('[ProjectIndexer] Initial index skipped (代码库智能 关闭)');
            return;
        }
        // 尊重「索引新文件夹」开关：关闭时不做自动索引
        if (!vscode.workspace.getConfiguration('kodrix.codebase').get('autoIndexNewFolders', true)) {
            logger_1.logger.info('[ProjectIndexer] Initial index skipped (索引新文件夹 关闭)');
            return;
        }
        void runInitialIndex();
    }, constants_1.INITIAL_INDEX_DELAY_MS);
    context.subscriptions.push({ dispose: () => clearTimeout(initialIndexTimer) });
    // 手动重建索引命令
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.codebaseBuildIndex, async () => {
        if (!requireCodebaseEnabled()) {
            return;
        }
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode_1.l10n.t('Kodrix: Rebuilding project-wide semantic index...') }, async () => {
                const idx = await (0, index_1.ensureProjectIndex)(true, { manual: true });
                vscode.window.showInformationMessage(vscode_1.l10n.t('Index rebuild complete: {0} files · {1} symbols · {2}ms', idx.stats.totalFiles, idx.stats.totalSymbols, idx.stats.indexDurationMs));
            });
        }
        catch (err) {
            logger_1.logger.error('Codebase intelligence: manual index rebuild failed', err);
            vscode.window.showErrorMessage(vscode_1.l10n.t('Index rebuild failed: {0}', err instanceof Error ? err.message : String(err)));
        }
    }));
    // 查看索引统计命令
    context.subscriptions.push(vscode.commands.registerCommand(constants_1.COMMANDS.codebaseStats, async () => {
        const idx = await (0, index_1.ensureProjectIndex)();
        if (!idx) {
            vscode.window.showWarningMessage(vscode_1.l10n.t('No project index yet. Please open a workspace first'));
            return;
        }
        const stats = idx.stats;
        const doc = await vscode.workspace.openTextDocument({
            content: [
                vscode_1.l10n.t('# Kodrix Workspace-wide Semantic Index Statistics'),
                '',
                vscode_1.l10n.t('| Metric | Value |'),
                '|------|-----|',
                vscode_1.l10n.t('| Index version | v{0} |', idx.version),
                vscode_1.l10n.t('| Project path | {0} |', idx.rootPath),
                vscode_1.l10n.t('| Created | {0} |', idx.createdAt),
                vscode_1.l10n.t('| Updated | {0} |', idx.updatedAt),
                vscode_1.l10n.t('| Total files | {0} |', stats.totalFiles),
                vscode_1.l10n.t('| Total symbols | {0} |', stats.totalSymbols),
                vscode_1.l10n.t('| Import relations | {0} |', stats.totalImports),
                vscode_1.l10n.t('| Call relations | {0} |', stats.totalCalls),
                vscode_1.l10n.t('| Indexing time | {0}ms |', stats.indexDurationMs),
                vscode_1.l10n.t('| Hot symbols | {0} |', idx.hotSymbols.length),
                '',
                vscode_1.l10n.t('## Language distribution'),
                '',
                ...Object.entries(stats.languageDistribution)
                    .sort((a, b) => b[1] - a[1])
                    .map(([lang, count]) => `| \`.${lang}\` | ${count} |`),
                '',
                vscode_1.l10n.t('## Top 10 hot symbols'),
                '',
                vscode_1.l10n.t('| # | Symbol | Kind | Visibility |'),
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
    (0, projectIndexer_1.disposeIndexStateEmitter)();
    (0, codeLensProvider_1.disposeCodeLensEmitter)();
    (0, contextEvents_1.disposeContextEvents)();
    (0, kodrixEventBus_1.disposeKodrixEventBus)();
    (0, checkpointManager_1.disposeCheckpointThrottle)();
    logger_1.logger.dispose();
}
