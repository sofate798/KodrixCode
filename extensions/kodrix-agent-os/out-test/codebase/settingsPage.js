"use strict";
/*---------------------------------------------------------------------------------------------
 *  Kodrix Settings — 设置编辑器内嵌的自定义设置页（仿 Cursor Settings）
 *
 *  依托 Kodrix 核心新增的「设置项自定义渲染」机制：
 *    - package.json contributes.settingsEditorRenderers 声明 viewType「kodrix.settings」
 *    - configuration 属性 kodrix.settings 声明 renderer: "kodrix.settings"（type: null）
 *    - 扩展通过 vscode.window.registerSettingsEditorRenderer 注册渲染器
 *
 *  页面形态：左侧导航 + 右侧页面区，聚合 Kodrix 后期功能配置：
 *    - 常规：Kodrix 功能总开关（开发工作流 / 智能与上下文 / 协作与工具）
 *    - 代码库：索引与文档管理（复用 projectIndexer 实时状态）
 *    - AI 供应商：模型路由 / Tab 补全通道 / 对比模型
 *    - FIM 配置：Tab 补全 FIM 通道（模式 / 提供方 / 端点 / Key / 模型）
 *    - Embedding 配置：语义检索（启用 / Key / 端点 / 模型）
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
exports.registerSettingsPage = registerSettingsPage;
exports.buildSettingsPageHtml = buildSettingsPageHtml;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const projectIndexer_1 = require("./projectIndexer");
const logger_1 = require("../logger");
const webviewHtml_1 = require("../shared/webviewHtml");
const secretStorage_1 = require("../secretStorage");
const VIEW_TYPE = 'kodrix.settings';
/** grep 索引文件数缓存：避免每次状态推送都重新解析整个 grep-index.json */
let _grepFileCount = 0;
const _webviews = new Set();
// ── 注册 ─────────────────────────────────────────────────────
function registerSettingsPage(context) {
    _ctx = context;
    _grepFileCount = (0, projectIndexer_1.getGrepIndexFiles)().length;
    context.subscriptions.push(vscode.window.registerSettingsEditorRenderer(VIEW_TYPE, {
        async resolveSettingsEditorSetting(_setting, webview, token) {
            if (token.isCancellationRequested) {
                return;
            }
            _webviews.add(webview.webview);
            webview.webview.html = buildSettingsPageHtml(webview.webview);
            webview.webview.onDidReceiveMessage(msg => {
                void handleMessage(webview.webview, msg);
            });
            webview.onDidDispose(() => {
                _webviews.delete(webview.webview);
            });
        },
    }));
    // 索引状态实时推送（所有活跃的设置页 webview）
    context.subscriptions.push((0, projectIndexer_1.onIndexStateChange)(() => {
        const state = buildIndexPayload();
        for (const w of _webviews) {
            void w.postMessage({ type: 'indexState', state });
        }
    }));
}
// ── 消息处理 ─────────────────────────────────────────────────
async function handleMessage(webview, msg) {
    try {
        switch (msg?.type) {
            case 'getConfig': {
                const values = {};
                for (const key of (msg.keys ?? [])) {
                    values[key] = vscode.workspace.getConfiguration().get(key);
                }
                await webview.postMessage({ type: 'config', values });
                break;
            }
            case 'setConfig': {
                const key = msg.key;
                await vscode.workspace.getConfiguration().update(key, msg.value, vscode.ConfigurationTarget.Global);
                await webview.postMessage({
                    type: 'config',
                    values: { [key]: vscode.workspace.getConfiguration().get(key) },
                });
                break;
            }
            case 'getIndexState':
                await webview.postMessage({ type: 'indexState', state: buildIndexPayload() });
                break;
            case 'toggle':
                await handleCodebaseToggle(msg.key, msg.value);
                break;
            case 'indexAction':
                await handleIndexAction(msg.action);
                break;
            case 'editCursorignore':
                await openCursorignoreFile();
                break;
            case 'getSecretStatus': {
                const ctx = getSettingsContext();
                const statuses = {};
                for (const key of (msg.keys ?? [])) {
                    if (key === secretStorage_1.FIM_API_KEY_SECRET) {
                        statuses[key] = !!(await (0, secretStorage_1.getFimApiKey)(ctx));
                    }
                    else if (key === secretStorage_1.EMBEDDING_API_KEY_SECRET) {
                        statuses[key] = !!(await (0, secretStorage_1.getEmbeddingApiKey)(ctx));
                    }
                }
                await webview.postMessage({ type: 'secretStatus', statuses });
                break;
            }
            case 'setSecret': {
                const sctx = getSettingsContext();
                const secretKey = msg.key;
                const secretValue = msg.value;
                if (secretKey === secretStorage_1.FIM_API_KEY_SECRET) {
                    await (0, secretStorage_1.setFimApiKey)(sctx, secretValue);
                }
                else if (secretKey === secretStorage_1.EMBEDDING_API_KEY_SECRET) {
                    await (0, secretStorage_1.setEmbeddingApiKey)(sctx, secretValue);
                }
                else {
                    logger_1.logger.warn(`[Settings] Unknown secret key: ${secretKey}`);
                    break;
                }
                await webview.postMessage({
                    type: 'secretStatus',
                    statuses: { [secretKey]: !!secretValue },
                });
                break;
            }
        }
    }
    catch (err) {
        logger_1.logger.warn(`[Kodrix Settings] Failed to handle message ${msg?.type}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
async function handleCodebaseToggle(key, value) {
    await vscode.workspace.getConfiguration('kodrix.codebase').update(key, value, vscode.ConfigurationTarget.Global);
    if (key === 'grepIndex') {
        if (value) {
            const n = (await (0, projectIndexer_1.ensureGrepIndex)()).length;
            _grepFileCount = n;
            void vscode.window.setStatusBarMessage(vscode_1.l10n.t('Grep index built: {0} files', n), 4000);
        }
        else {
            (0, projectIndexer_1.clearGrepIndex)();
            _grepFileCount = 0;
        }
    }
    else if (key === 'autoIndexNewFolders') {
        // 即时生效：关闭时停用文件监听，打开时重新启用
        if (value) {
            (0, projectIndexer_1.startIndexWatcher)(getSettingsContext());
        }
        else {
            (0, projectIndexer_1.disposeIndexWatcher)();
        }
    }
    else if (key === 'ignoreCursorignore') {
        // 忽略规则变更后需重建，否则仍用旧的排除结果
        void (0, projectIndexer_1.ensureProjectIndex)(true, { manual: true }).catch(err => {
            void vscode.window.showErrorMessage(vscode_1.l10n.t('Index rebuild failed: {0}', err instanceof Error ? err.message : String(err)));
        });
    }
}
async function handleIndexAction(action) {
    switch (action) {
        case 'pause':
            (0, projectIndexer_1.pauseIndexBuild)();
            break;
        case 'resume':
            (0, projectIndexer_1.resumeIndexBuild)();
            break;
        case 'delete':
            await (0, projectIndexer_1.deleteProjectIndex)();
            break;
        case 'rebuild':
            void (0, projectIndexer_1.ensureProjectIndex)(true, { manual: true }).catch(err => {
                void vscode.window.showErrorMessage(vscode_1.l10n.t('Index rebuild failed: {0}', err instanceof Error ? err.message : String(err)));
            });
            break;
    }
}
let _ctx;
function getSettingsContext() {
    return _ctx;
}
// ── 索引状态 payload（与 indexManager 面板同构） ───────────────
function buildIndexPayload() {
    const st = (0, projectIndexer_1.getIndexState)();
    return {
        status: st.status,
        progress: st.progress,
        stats: st.stats,
        files: st.files.map(f => ({ language: f.language || 'txt', relativePath: f.relativePath })),
        config: {
            autoIndexNewFolders: vscode.workspace.getConfiguration('kodrix.codebase').get('autoIndexNewFolders', true),
            ignoreCursorignore: vscode.workspace.getConfiguration('kodrix.codebase').get('ignoreCursorignore', true),
            grepIndex: vscode.workspace.getConfiguration('kodrix.codebase').get('grepIndex', true),
        },
        grepFileCount: vscode.workspace.getConfiguration('kodrix.codebase').get('grepIndex', true) ? _grepFileCount : 0,
    };
}
// ── .cursorignore 编辑入口 ─────────────────────────────────────
async function openCursorignoreFile() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        void vscode.window.showErrorMessage(vscode_1.l10n.t('No workspace folder is currently open'));
        return;
    }
    const file = path.join(folder.uri.fsPath, '.cursorignore');
    try {
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, vscode_1.l10n.t('# Add files/directories (glob patterns) to exclude from the codebase index in this file') + '\n', 'utf-8');
        }
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
    }
    catch (err) {
        void vscode.window.showErrorMessage(vscode_1.l10n.t('Failed to open .cursorignore: {0}', err instanceof Error ? err.message : String(err)));
    }
}
// ── 页面数据表 ────────────────────────────────────────────────
//
// 这些表是 webview 的**数据源**，必须在宿主侧本地化后再注入：`<script>` 里的代码跑在
// webview 里，那里没有 `l10n`（此前把 `l10n.t(...)` 直接写进脚本，会让整个设置页脚本
// 在第一行 `ReferenceError: l10n is not defined` 处整体失效）。
/** 侧栏页面 → [标题, 副标题] */
const PAGE_META = {
    general: [vscode_1.l10n.t('General'), vscode_1.l10n.t('Kodrix master feature switch')],
    codebase: [vscode_1.l10n.t('Codebase'), vscode_1.l10n.t('Indexing & docs management — workspace-wide semantic index · Grep index · ignore rules')],
    ai: [vscode_1.l10n.t('AI Provider'), vscode_1.l10n.t('Model routing and completion channel')],
    fim: [vscode_1.l10n.t('FIM Configuration'), vscode_1.l10n.t('Dedicated FIM channel for Tab completion (comparable to Cursor Tab)')],
    embedding: [vscode_1.l10n.t('Embedding Configuration'), vscode_1.l10n.t('True vector semantic search (Embedding)')],
};
/** 常规页功能开关分组：[配置键, 标题, 说明] */
const FEATURE_GROUPS = [
    {
        title: vscode_1.l10n.t('Development Workflow'),
        items: [
            ['kodrix.features.wiki', vscode_1.l10n.t('Repo Wiki'), vscode_1.l10n.t('Automatically generate the project Wiki when a workspace is opened')],
            ['kodrix.features.spec', vscode_1.l10n.t('Spec-driven'), vscode_1.l10n.t('Requirements→design→tasks three-pane workflow')],
            ['kodrix.features.memory', vscode_1.l10n.t('Cross-session Memory'), vscode_1.l10n.t('Remember project context')],
            ['kodrix.features.kanban', vscode_1.l10n.t('Agent Kanban'), vscode_1.l10n.t('Visual task board')],
            ['kodrix.features.agentRouter', vscode_1.l10n.t('Smart Routing'), vscode_1.l10n.t('Automatically select a flow by task type')],
            ['kodrix.features.ideaFlow', vscode_1.l10n.t('Idea Flow'), vscode_1.l10n.t('A fully automated idea-to-product pipeline')],
            ['kodrix.features.vibeCoding', vscode_1.l10n.t('Vibe Coding'), vscode_1.l10n.t('Generate a project from one sentence')],
            ['kodrix.features.agentCrew', vscode_1.l10n.t('Agent Crew'), vscode_1.l10n.t('Orchestrate multi-agent parallel collaboration')],
            ['kodrix.features.terminalAI', vscode_1.l10n.t('Terminal AI'), vscode_1.l10n.t('Cmd+K to generate a command, Cmd+Enter to run it')],
        ],
    },
    {
        title: vscode_1.l10n.t('Intelligence & Context'),
        items: [
            ['kodrix.features.codebaseIntelligence', vscode_1.l10n.t('Codebase intelligence'), vscode_1.l10n.t('Whole-project semantic index (AST symbols/dependencies/call graph)')],
            ['kodrix.features.predictiveCompletion', vscode_1.l10n.t('Predictive completion'), vscode_1.l10n.t('Whole-project indexed "next edit" prediction')],
            ['kodrix.features.codebaseQuery', vscode_1.l10n.t('Codebase Q&A'), vscode_1.l10n.t('@codebase natural language queries for definitions, references, and architecture')],
            ['kodrix.features.semanticMemory', vscode_1.l10n.t('Semantic memory'), vscode_1.l10n.t('TF-IDF vector search, zero external dependencies')],
            ['kodrix.features.proactiveContext', vscode_1.l10n.t('Proactive Context'), vscode_1.l10n.t('Automatically associate related memories when a file is opened')],
            ['kodrix.features.contextIntelligence', vscode_1.l10n.t('Context Intelligence'), vscode_1.l10n.t('Wiki + Memory + Learning auto-injection')],
            ['kodrix.features.learning', vscode_1.l10n.t('Learning Engine'), vscode_1.l10n.t('Cross-session knowledge that gets smarter the more you use it')],
            ['kodrix.features.sessionLearning', vscode_1.l10n.t('Session Learning'), vscode_1.l10n.t('Distill knowledge automatically when an Agent session ends')],
        ],
    },
    {
        title: vscode_1.l10n.t('Collaboration & Tools'),
        items: [
            ['kodrix.features.arena', vscode_1.l10n.t('Arena Compare'), vscode_1.l10n.t('Two-model output comparison')],
            ['kodrix.features.hooks', vscode_1.l10n.t('Hooks presets'), vscode_1.l10n.t('GitHub Action-style automation hooks')],
            ['kodrix.features.acp', vscode_1.l10n.t('ACP External Agent'), vscode_1.l10n.t('Connect third-party Agents')],
            ['kodrix.features.propertyTests', vscode_1.l10n.t('Property tests'), vscode_1.l10n.t('Spec / Kiro style property test generation')],
        ],
    },
];
const AI_FIELDS = [
    { key: 'kodrix.modelRouter.enabled', label: vscode_1.l10n.t('Model Auto Routing'), hint: vscode_1.l10n.t('Automatically select a model by task type (smart/balanced/fast)'), type: 'switch' },
    { key: 'kodrix.tabCompletion.enabled', label: vscode_1.l10n.t('Tab completion channel'), hint: vscode_1.l10n.t('Enable Kodrix Tab completion (off by default to avoid conflicts with the upstream Copilot)'), type: 'switch' },
    { key: 'kodrix.arena.modelA', label: vscode_1.l10n.t('Arena Compare Model A'), hint: vscode_1.l10n.t('Leave empty to use the current default model'), type: 'text' },
    { key: 'kodrix.arena.modelB', label: vscode_1.l10n.t('Arena Compare Model B'), hint: '', type: 'text' },
];
const FIM_FIELDS = [
    { key: 'kodrix.tabCompletion.mode', label: vscode_1.l10n.t('Completion mode'), type: 'select', options: [['fim', vscode_1.l10n.t('Dedicated FIM channel')], ['fast', vscode_1.l10n.t('Generic model channel')]] },
    { key: 'kodrix.tabCompletion.fimEnabled', label: vscode_1.l10n.t('Enable dedicated FIM channel'), type: 'switch', hint: vscode_1.l10n.t('When disabled, Tab completion only goes through the general model channel (on by default)') },
    { key: 'kodrix.tabCompletion.fimEndpoint', label: vscode_1.l10n.t('FIM Endpoint'), type: 'text', hint: vscode_1.l10n.t('Default DeepSeek FIM endpoint; change this if the endpoint is retired or you switch to another OpenAI-compatible completions service') },
    { key: 'kodrix.tabCompletion.fimApiKey', label: vscode_1.l10n.t('FIM API Key'), type: 'password', secretKey: 'kodrix.agent-os.tabCompletion.fimApiKey' },
    { key: 'kodrix.tabCompletion.fimModel', label: vscode_1.l10n.t('FIM Model'), type: 'text', hint: vscode_1.l10n.t('DeepSeek defaults to deepseek-chat') },
];
const EMBEDDING_FIELDS = [
    { key: 'kodrix.semanticEmbedding.enabled', label: vscode_1.l10n.t('Enable true vector semantic retrieval'), hint: vscode_1.l10n.t('An API Key is also required. It will be enabled automatically after saving.'), type: 'switch' },
    { key: 'kodrix.semanticEmbedding.apiKey', label: vscode_1.l10n.t('Zhipu (BigModel) API Key'), hint: 'https://open.bigmodel.cn', type: 'password', secretKey: 'kodrix.agent-os.semanticEmbedding.apiKey' },
    { key: 'kodrix.semanticEmbedding.endpoint', label: vscode_1.l10n.t('Embedding Endpoint'), type: 'text' },
    { key: 'kodrix.semanticEmbedding.model', label: vscode_1.l10n.t('Embedding Model'), hint: vscode_1.l10n.t('Defaults to embedding-3'), type: 'text' },
];
/** webview 脚本里用到的静态文案（同样必须在宿主侧本地化） */
const WEBVIEW_TEXT = {
    secretConfigured: vscode_1.l10n.t('✓ Configured'),
    secretMissing: vscode_1.l10n.t('Not configured, please enter a value'),
    saved: vscode_1.l10n.t('Saved'),
    notIndexed: vscode_1.l10n.t('Not indexed'),
    paused: vscode_1.l10n.t('Paused'),
    syncing: vscode_1.l10n.t('Syncing {0}/{1}'),
    fileCount: vscode_1.l10n.t('{0} files'),
    indexEmpty: vscode_1.l10n.t('Index is empty — no indexable source files found. Click "Rebuild Index" to retry'),
    indexDone: vscode_1.l10n.t('Indexing complete'),
    indexDoneDetail: vscode_1.l10n.t('Indexing complete · {0} symbols · {1}s'),
    noIndexFiles: vscode_1.l10n.t('No indexed files yet'),
    noIndexFilesDone: vscode_1.l10n.t('No indexed files yet. Make sure a workspace is open and contains source files such as .ts/.js/.py (node_modules / out etc. are excluded).'),
    grepFileCount: vscode_1.l10n.t('({0} files indexed)'),
    confirmDeleteIndex: vscode_1.l10n.t('Delete the codebase index? You will need to rebuild it afterwards.'),
    resume: vscode_1.l10n.t('Resume'),
    pauseIndexing: vscode_1.l10n.t('Pause Indexing'),
};
// ── Webview HTML ──────────────────────────────────────────────
/** 设置页 HTML（导出供测试断言：脚本可解析 + 文案全部走 l10n） */
function buildSettingsPageHtml(webview) {
    // 一次性 nonce（此前是硬编码常量，等于没有防护）
    const nonce = (0, webviewHtml_1.createNonce)();
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${(0, webviewHtml_1.webviewCsp)(webview, nonce)}">
<style>
:root {
	--bg: #ffffff;
	--panel: #f6f8fa;
	--text: #1f2328;
	--muted: #57606a;
	--border: #d0d7de;
	--bar-bg: #eaeef2;
	--accent: #0969da;
	--danger: #cf222e;
	--active: #e8f0fe;
	--badge-bg: #eaeef2;
	--badge-text: #57606a;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #1e1e1e;
		--panel: #252526;
		--text: #e6e6e6;
		--muted: #9d9d9d;
		--border: #3c3c3c;
		--bar-bg: #3c3c3c;
		--accent: #4ea1ff;
		--danger: #f85149;
		--active: #2d3a4d;
		--badge-bg: #3c3c3c;
		--badge-text: #b8b8b8;
	}
}
* { box-sizing: border-box; }
body {
	font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
	background: var(--bg);
	color: var(--text);
	margin: 0;
	min-height: 100vh;
}
.layout { display: flex; min-height: 100vh; }
.sidebar {
	width: 190px;
	flex-shrink: 0;
	background: var(--panel);
	border-right: 1px solid var(--border);
	padding: 16px 10px;
}
.sidebar .logo { font-size: 15px; font-weight: 600; padding: 2px 10px 14px; }
.sidebar .item {
	display: block;
	padding: 6px 10px;
	margin: 1px 0;
	font-size: 13px;
	border-radius: 6px;
	cursor: pointer;
	color: var(--text);
	user-select: none;
}
.sidebar .item:hover { background: var(--badge-bg); }
.sidebar .item.active { background: var(--active); font-weight: 500; }
main { flex: 1; padding: 24px 32px; max-width: 860px; min-width: 0; }
main h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
main .subtitle { font-size: 12.5px; color: var(--muted); margin-bottom: 20px; }
section[hidden] { display: none; }
h2 { font-size: 14px; font-weight: 600; margin: 20px 0 10px; }
.card {
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 14px 16px;
	margin-bottom: 12px;
}
.card h3 { font-size: 13.5px; font-weight: 600; margin: 0 0 4px; }
.card .desc { font-size: 12.5px; color: var(--muted); margin: 0 0 12px; line-height: 1.5; }
.progress-row { display: flex; align-items: center; gap: 10px; }
.percent { font-size: 13px; font-weight: 500; min-width: 60px; }
.bar { flex: 1; height: 6px; background: var(--bar-bg); border-radius: 3px; overflow: hidden; }
.bar .fill { height: 100%; width: 0%; background: var(--accent); border-radius: 3px; transition: width .25s ease; }
button {
	font-size: 12.5px;
	padding: 3px 12px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--bg);
	color: var(--text);
	cursor: pointer;
	white-space: nowrap;
}
button:hover { background: var(--badge-bg); }
button.danger { color: var(--danger); border-color: var(--danger); }
button[hidden] { display: none; }
.status { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
.status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.status .dot.syncing { background: #2ea043; animation: pulse 1.2s ease-in-out infinite; }
.status .dot.paused { background: #d29922; }
.status .dot.done { background: #2ea043; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.file-list { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 6px; max-height: 170px; overflow-y: auto; }
.file-item { display: flex; align-items: center; gap: 8px; padding: 2.5px 0; font-size: 12px; font-family: Consolas, 'Courier New', monospace; }
.lang-badge {
	font-size: 10.5px;
	font-weight: 600;
	background: var(--badge-bg);
	color: var(--badge-text);
	border-radius: 4px;
	padding: 1px 5px;
	min-width: 28px;
	text-align: center;
	text-transform: uppercase;
}
.empty { color: var(--muted); font-size: 12.5px; padding: 8px 0; }
.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--border); }
.setting-row:last-child { border-bottom: none; }
.setting-text { flex: 1; min-width: 0; }
.setting-text .title { font-size: 13.5px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
.setting-text .desc { font-size: 12px; color: var(--muted); margin-top: 2px; line-height: 1.5; }
.beta {
	font-size: 10.5px;
	font-weight: 500;
	color: var(--accent);
	border: 1px solid var(--accent);
	border-radius: 4px;
	padding: 0 5px;
}
.toggle { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
.toggle input { opacity: 0; width: 100%; height: 100%; position: absolute; z-index: 2; cursor: pointer; margin: 0; }
.toggle .track {
	position: absolute; inset: 0;
	background: var(--bar-bg);
	border-radius: 10px;
	transition: background .2s;
	pointer-events: none;
}
.toggle .track::after {
	content: '';
	position: absolute; top: 2px; left: 2px;
	width: 16px; height: 16px;
	background: #fff;
	border-radius: 50%;
	transition: transform .2s;
	box-shadow: 0 1px 2px rgba(0,0,0,.2);
}
.toggle input:checked + .track { background: var(--accent); }
.toggle input:checked + .track::after { transform: translateX(16px); }
.ghost { margin-left: 4px; }
.form-row { padding: 10px 0; border-bottom: 1px solid var(--border); }
.form-row:last-child { border-bottom: none; }
.form-row label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 4px; }
.form-row .hint { font-size: 11.5px; color: var(--muted); margin-top: 4px; }
.form-row input, .form-row select {
	width: 100%;
	font-size: 13px;
	padding: 4px 8px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--bg);
	color: var(--text);
	font-family: Consolas, 'Courier New', monospace;
}
.form-row select { font-family: inherit; }
.form-row .save-hint { font-size: 11px; color: #2ea043; opacity: 0; transition: opacity .2s; }
.form-row.saved .save-hint { opacity: 1; }
.group-title { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; margin: 14px 0 4px; }
</style>
</head>
<body>
<div class="layout">
	<nav class="sidebar">
		<div class="logo">Kodrix Settings</div>
		<a class="item active" data-page="general">${vscode_1.l10n.t('General')}</a>
		<a class="item" data-page="codebase">${vscode_1.l10n.t('Codebase')}</a>
		<a class="item" data-page="ai">${vscode_1.l10n.t('AI Provider')}</a>
		<a class="item" data-page="fim">${vscode_1.l10n.t('FIM Configuration')}</a>
		<a class="item" data-page="embedding">${vscode_1.l10n.t('Embedding Configuration')}</a>
	</nav>

	<main>
		<h1 id="pageTitle">${vscode_1.l10n.t('General')}</h1>
		<div class="subtitle" id="pageSubtitle"></div>

		<!-- 常规：功能开关 -->
		<section id="page-general">
			<div id="featuresContainer"></div>
		</section>

		<!-- 代码库：索引与文档 -->
		<section id="page-codebase" hidden>
			<h2>${vscode_1.l10n.t('Codebase')}</h2>
			<div class="card">
				<h3>${vscode_1.l10n.t('Codebase index')}</h3>
				<p class="desc">${vscode_1.l10n.t('Embed the codebase to improve context understanding and knowledge. Embeddings and metadata are stored in the cloud, but all code stays local.')}</p>
				<div class="progress-row">
					<span class="percent" id="percent">--</span>
					<div class="bar"><div class="fill" id="fill"></div></div>
					<button id="pauseBtn" hidden>${vscode_1.l10n.t('Pause Indexing')}</button>
					<button id="rebuildBtn" hidden>${vscode_1.l10n.t('Rebuild Index')}</button>
					<button id="deleteBtn" class="danger">${vscode_1.l10n.t('Delete index')}</button>
				</div>
				<div class="status"><span class="dot" id="dot"></span><span id="statusText">--</span></div>
				<div class="file-list" id="fileList"></div>
			</div>
			<div class="card">
				<div class="setting-row">
					<div class="setting-text">
						<div class="title">${vscode_1.l10n.t('Index new folder')}</div>
						<div class="desc">${vscode_1.l10n.t('Automatically index folders with fewer than 50,000 files')}</div>
					</div>
					<div class="toggle"><input type="checkbox" id="autoIndexFolders" data-key="autoIndexNewFolders"><span class="track"></span></div>
				</div>
				<div class="setting-row">
					<div class="setting-text">
						<div class="title">${vscode_1.l10n.t('Ignore files in .cursorignore')}</div>
						<div class="desc">${vscode_1.l10n.t('Files to exclude from the index in addition to .gitignore')}</div>
					</div>
					<div class="toggle"><input type="checkbox" id="ignoreCursorignore" data-key="ignoreCursorignore"><span class="track"></span></div>
					<button id="editCursorignore" class="ghost">${vscode_1.l10n.t('Edit')}</button>
				</div>
				<div class="setting-row">
					<div class="setting-text">
						<div class="title">${vscode_1.l10n.t('Index the repository for instant Grep')} <span class="beta">${vscode_1.l10n.t('Beta')}</span></div>
						<div class="desc">${vscode_1.l10n.t('Automatically index the repository to speed up Grep searches. All data is stored locally.')}<span id="grepCount"></span></div>
					</div>
					<div class="toggle"><input type="checkbox" id="grepIndex" data-key="grepIndex"><span class="track"></span></div>
				</div>
			</div>
		</section>

		<!-- AI 供应商 -->
		<section id="page-ai" hidden>
			<div id="aiContainer"></div>
		</section>

		<!-- FIM 配置 -->
		<section id="page-fim" hidden>
			<div id="fimContainer"></div>
		</section>

		<!-- Embedding 配置 -->
		<section id="page-embedding" hidden>
			<div id="embeddingContainer"></div>
		</section>
	</main>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);

// ── 密钥存储状态监听：更新密码字段的 placeholder ──
window.addEventListener('message', e => {
	if (e.data.type === 'secretStatus') {
		const statuses = e.data.statuses || {};
		document.querySelectorAll('input[data-secret-key]').forEach(input => {
			const sk = input.dataset.secretKey;
			if (sk in statuses) {
				input.placeholder = statuses[sk] ? L.secretConfigured : L.secretMissing;
			}
		});
	}
});

// 宿主侧本地化后的数据表 / 文案（webview 里没有 l10n，必须由宿主注入）
const PAGES = ${(0, webviewHtml_1.jsJson)(PAGE_META)};
const FEATURE_GROUPS = ${(0, webviewHtml_1.jsJson)(FEATURE_GROUPS)};
const AI_FIELDS = ${(0, webviewHtml_1.jsJson)(AI_FIELDS)};
const FIM_FIELDS = ${(0, webviewHtml_1.jsJson)(FIM_FIELDS)};
const EMBEDDING_FIELDS = ${(0, webviewHtml_1.jsJson)(EMBEDDING_FIELDS)};
const L = ${(0, webviewHtml_1.jsJson)(WEBVIEW_TEXT)};

/** 本地化后的动态文案：宿主侧保留 {0}/{1} 占位，这里按运行时的值替换 */
const fmt = (template, ...args) => String(template).replace(/\\{(\\d+)\\}/g, (m, i) => (args[i] === undefined ? m : String(args[i])));

function esc(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── 导航 ──
document.querySelectorAll('.sidebar .item').forEach(item => {
	item.addEventListener('click', () => {
		document.querySelectorAll('.sidebar .item').forEach(i => i.classList.remove('active'));
		item.classList.add('active');
		const page = item.dataset.page;
		document.querySelectorAll('main section').forEach(s => s.hidden = true);
		$('page-' + page).hidden = false;
		$('pageTitle').textContent = PAGES[page][0];
		$('pageSubtitle').textContent = PAGES[page][1];
	});
});

// ── 功能开关渲染（常规页） ──
function renderFeatures() {
	const keys = [];
	FEATURE_GROUPS.forEach(g => g.items.forEach(it => keys.push(it[0])));
	post({ type: 'getConfig', keys });

	window.addEventListener('message', function onConfig(e) {
		if (e.data.type !== 'config') return;
		const values = e.data.values || {};
		// 功能开关
		FEATURE_GROUPS.forEach(g => {
			let html = '<div class="group-title">' + esc(g.title) + '</div>';
			g.items.forEach(it => {
				html += '<div class="setting-row"><div class="setting-text"><div class="title">' + esc(it[1]) + '</div><div class="desc">' + esc(it[2]) + '</div></div>' +
					'<div class="toggle"><input type="checkbox" data-key="' + esc(it[0]) + '"' + (values[it[0]] ? ' checked' : '') + '><span class="track"></span></div></div>';
			});
			$('featuresContainer').innerHTML += html;
		});
		$('featuresContainer').querySelectorAll('.toggle input').forEach(input => {
			input.addEventListener('change', () => post({ type: 'setConfig', key: input.dataset.key, value: input.checked }));
		});
		// 表单页
		renderForm('aiContainer', AI_FIELDS, values);
		renderForm('fimContainer', FIM_FIELDS, values);
		renderForm('embeddingContainer', EMBEDDING_FIELDS, values);
		// 加载密钥存储状态
		const allSecretKeys = [...FIM_FIELDS, ...EMBEDDING_FIELDS].filter(f => f.secretKey).map(f => f.secretKey);
		if (allSecretKeys.length) {
			post({ type: 'getSecretStatus', keys: allSecretKeys });
		}
		window.removeEventListener('message', onConfig);
	});
}

// ── 表单渲染（AI / FIM / Embedding 页） ──
function renderForm(containerId, fields, values) {
	const rows = {};
	const secretFields = fields.filter(f => f.secretKey);
	fields.forEach(f => {
		const val = values[f.key];
		let control = '';
		if (f.type === 'switch') {
			control = '<div class="toggle"><input type="checkbox" data-key="' + esc(f.key) + '"' + (val ? ' checked' : '') + '><span class="track"></span></div>';
		} else if (f.type === 'select') {
			control = '<select data-key="' + esc(f.key) + '">' + f.options.map(o =>
				'<option value="' + esc(o[0]) + '"' + (String(val) === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select>';
		} else if (f.type === 'password' && f.secretKey) {
			control = '<input type="password" data-key="' + esc(f.key) + '" data-secret-key="' + esc(f.secretKey) + '" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" autocomplete="off">';
		} else {
			control = '<input type="' + (f.type === 'password' ? 'password' : 'text') + '" data-key="' + esc(f.key) + '" value="' + esc(val == null ? '' : val) + '">';
		}
		rows[f.key] = '<div class="form-row" data-key="' + esc(f.key) + '"><label>' + esc(f.label) + '</label>' + control +
			(f.hint ? '<div class="hint">' + esc(f.hint) + '</div>' : '') +
			'<div class="save-hint">' + esc(L.saved) + '</div></div>';
	});

	const html = fields.map(f => rows[f.key]).join('');
	const container = $(containerId);
	container.innerHTML = html;

	// 联动显隐：fimProvider == custom 时显示 endpoint
	const showIfKeys = fields.filter(f => f.showIf).map(f => f.showIf);
	function applyShowIf() {
		fields.forEach(f => {
			if (!f.showIf) return;
			const sel = container.querySelector('select[data-key="' + esc(f.showIf) + '"]');
			const row = container.querySelector('.form-row[data-key="' + esc(f.key) + '"]');
			if (row) row.hidden = !sel || sel.value !== 'custom';
		});
	}

	container.querySelectorAll('.toggle input').forEach(input => {
		input.addEventListener('change', () => post({ type: 'setConfig', key: input.dataset.key, value: input.checked }));
	});
	container.querySelectorAll('input[type="text"]').forEach(input => {
		// 边输边存（防抖 600ms）：此前只监听 change，用户输完不点别处就以为已保存
		let debounce;
		const save = () => {
			post({ type: 'setConfig', key: input.dataset.key, value: input.value });
			input.parentElement.classList.add('saved');
			setTimeout(() => input.parentElement.classList.remove('saved'), 1500);
		};
		input.addEventListener('input', () => {
			clearTimeout(debounce);
			debounce = setTimeout(save, 600);
		});
		input.addEventListener('change', () => {
			clearTimeout(debounce);
			save();
		});
	});
	container.querySelectorAll('input[type="password"][data-secret-key]').forEach(input => {
		input.addEventListener('change', () => {
			post({ type: 'setSecret', key: input.dataset.secretKey, value: input.value });
			input.placeholder = L.secretConfigured;
			input.value = '';
			input.parentElement.classList.add('saved');
			setTimeout(() => input.parentElement.classList.remove('saved'), 1500);
		});
	});
	container.querySelectorAll('select').forEach(select => {
		select.addEventListener('change', () => {
			post({ type: 'setConfig', key: select.dataset.key, value: select.value });
			applyShowIf();
		});
	});
	applyShowIf();
}

// ── 索引卡片渲染（代码库页） ──
let lastIndexStatus = 'idle';
function renderIndex(s) {
	lastIndexStatus = s && s.status ? s.status : 'idle';
	const percent = $('percent'), fill = $('fill'), dot = $('dot');
	const statusText = $('statusText'), pauseBtn = $('pauseBtn'), rebuildBtn = $('rebuildBtn');

	if (s.status === 'idle') {
		percent.textContent = '--';
		fill.style.width = '0%';
		dot.className = 'dot';
		statusText.textContent = L.notIndexed;
		pauseBtn.hidden = true;
		rebuildBtn.hidden = false;
	} else if (s.status === 'building' || s.status === 'paused') {
		const total = s.progress.total || 0;
		const pct = total ? Math.min(100, Math.round(s.progress.parsed / total * 100)) : 0;
		percent.textContent = pct + '%';
		fill.style.width = pct + '%';
		dot.className = 'dot ' + (s.status === 'paused' ? 'paused' : 'syncing');
		statusText.textContent = s.status === 'paused'
			? L.paused
			: fmt(L.syncing, s.progress.parsed, total);
		pauseBtn.hidden = false;
		pauseBtn.textContent = s.status === 'paused' ? L.resume : L.pauseIndexing;
		rebuildBtn.hidden = true;
	} else if (s.status === 'done') {
		const total = s.stats ? s.stats.totalFiles : 0;
		percent.textContent = fmt(L.fileCount, total);
		fill.style.width = '100%';
		dot.className = 'dot done';
		if (total === 0) {
			statusText.textContent = L.indexEmpty;
		} else {
			statusText.textContent = s.stats
				? fmt(L.indexDoneDetail, s.stats.totalSymbols, Math.round((s.stats.indexDurationMs || 0) / 1000))
				: L.indexDone;
		}
		pauseBtn.hidden = true;
		rebuildBtn.hidden = false;
	}

	const list = $('fileList');
	if (!s.files || !s.files.length) {
		list.innerHTML = s.status === 'done'
			? '<div class="empty">' + esc(L.noIndexFilesDone) + '</div>'
			: '<div class="empty">' + esc(L.noIndexFiles) + '</div>';
	} else {
		list.innerHTML = s.files.map(f =>
			'<div class="file-item"><span class="lang-badge">' + esc(f.language) + '</span><span>' + esc(f.relativePath) + '</span></div>'
		).join('');
	}

	const cfg = s.config || {};
	['autoIndexNewFolders', 'ignoreCursorignore', 'grepIndex'].forEach(key => {
		const el = document.querySelector('#page-codebase input[data-key="' + key + '"]');
		if (el) el.checked = !!cfg[key];
	});
	$('grepCount').textContent = s.grepFileCount > 0 ? esc(fmt(L.grepFileCount, s.grepFileCount)) : '';
}

// ── 按钮与开关 ──
// 同一个按钮按当前状态发 pause / resume（此前固定发 pause，暂停后无法恢复）
$('pauseBtn').addEventListener('click', () => post({ type: 'indexAction', action: lastIndexStatus === 'paused' ? 'resume' : 'pause' }));
$('rebuildBtn').addEventListener('click', () => post({ type: 'indexAction', action: 'rebuild' }));
$('deleteBtn').addEventListener('click', () => {
	if (confirm(L.confirmDeleteIndex)) post({ type: 'indexAction', action: 'delete' });
});
$('editCursorignore').addEventListener('click', () => post({ type: 'editCursorignore' }));
document.querySelectorAll('#page-codebase .toggle input').forEach(input => {
	input.addEventListener('change', () => post({ type: 'toggle', key: input.dataset.key, value: input.checked }));
});

window.addEventListener('message', e => {
	if (e.data.type === 'indexState') renderIndex(e.data.state);
});

function post(msg) { vscode.postMessage(msg); }

renderFeatures();
post({ type: 'getIndexState' });
</script>
</body>
</html>`;
}
