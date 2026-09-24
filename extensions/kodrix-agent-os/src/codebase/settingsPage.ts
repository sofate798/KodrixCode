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

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	onIndexStateChange,
	getIndexState,
	pauseIndexBuild,
	resumeIndexBuild,
	deleteProjectIndex,
	ensureProjectIndex,
	startIndexWatcher,
	disposeIndexWatcher,
	ensureGrepIndex,
	clearGrepIndex,
	getGrepIndexFiles,
	IndexBuildState,
} from './projectIndexer';
import { logger } from '../logger';

const VIEW_TYPE = 'kodrix.settings';

/** grep 索引文件数缓存：避免每次状态推送都重新解析整个 grep-index.json */
let _grepFileCount = 0;
const _webviews = new Set<vscode.Webview>();

// ── 注册 ─────────────────────────────────────────────────────

export function registerSettingsPage(context: vscode.ExtensionContext): void {
	_ctx = context;
	_grepFileCount = getGrepIndexFiles().length;

	context.subscriptions.push(vscode.window.registerSettingsEditorRenderer(VIEW_TYPE, {
		async resolveSettingsEditorSetting(_setting, webview, token) {
			if (token.isCancellationRequested) {
				return;
			}
			_webviews.add(webview.webview);
			webview.webview.html = getWebviewHtml();
			webview.webview.onDidReceiveMessage(msg => {
				void handleMessage(webview.webview, msg);
			});
			webview.onDidDispose(() => {
				_webviews.delete(webview.webview);
			});
		},
	}));

	// 索引状态实时推送（所有活跃的设置页 webview）
	context.subscriptions.push(onIndexStateChange(() => {
		const state = buildIndexPayload();
		for (const w of _webviews) {
			void w.postMessage({ type: 'indexState', state });
		}
	}));
}

// ── 消息处理 ─────────────────────────────────────────────────

async function handleMessage(webview: vscode.Webview, msg: any): Promise<void> {
	try {
		switch (msg?.type) {
			case 'getConfig': {
				const values: Record<string, unknown> = {};
				for (const key of (msg.keys as string[] ?? [])) {
					values[key] = vscode.workspace.getConfiguration().get(key);
				}
				await webview.postMessage({ type: 'config', values });
				break;
			}
			case 'setConfig': {
				const key = msg.key as string;
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
		}
	} catch (err) {
		logger.warn(`[Kodrix Settings] Failed to handle message ${msg?.type}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function handleCodebaseToggle(key: string, value: boolean): Promise<void> {
	await vscode.workspace.getConfiguration('kodrix.codebase').update(key, value, vscode.ConfigurationTarget.Global);

	if (key === 'grepIndex') {
		if (value) {
			const n = (await ensureGrepIndex()).length;
			_grepFileCount = n;
			void vscode.window.setStatusBarMessage(`Grep 索引已构建：${n} 个文件`, 4000);
		} else {
			clearGrepIndex();
			_grepFileCount = 0;
		}
	} else if (key === 'autoIndexNewFolders') {
		// 即时生效：关闭时停用文件监听，打开时重新启用
		if (value) startIndexWatcher(getSettingsContext());
		else disposeIndexWatcher();
	} else if (key === 'ignoreCursorignore') {
		// 忽略规则变更后需重建，否则仍用旧的排除结果
		void ensureProjectIndex(true).catch(err => {
			void vscode.window.showErrorMessage(`索引重建失败：${err instanceof Error ? err.message : String(err)}`);
		});
	}
}

async function handleIndexAction(action: string): Promise<void> {
	switch (action) {
		case 'pause':
			pauseIndexBuild();
			break;
		case 'resume':
			resumeIndexBuild();
			break;
		case 'delete':
			await deleteProjectIndex();
			break;
		case 'rebuild':
			void ensureProjectIndex(true).catch(err => {
				void vscode.window.showErrorMessage(`索引重建失败：${err instanceof Error ? err.message : String(err)}`);
			});
			break;
	}
}

let _ctx: vscode.ExtensionContext | undefined;
function getSettingsContext(): vscode.ExtensionContext {
	return _ctx!;
}

// ── 索引状态 payload（与 indexManager 面板同构） ───────────────

function buildIndexPayload() {
	const st: IndexBuildState = getIndexState();
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

async function openCursorignoreFile(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		void vscode.window.showErrorMessage('当前没有打开的工作区文件夹');
		return;
	}
	const file = path.join(folder.uri.fsPath, '.cursorignore');
	try {
		if (!fs.existsSync(file)) {
			fs.writeFileSync(file, '# 在此文件中添加要从代码库索引中排除的文件/目录（glob 规则）\n', 'utf-8');
		}
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);
	} catch (err) {
		void vscode.window.showErrorMessage(`打开 .cursorignore 失败：${err instanceof Error ? err.message : String(err)}`);
	}
}

// ── Webview HTML ──────────────────────────────────────────────

function getWebviewHtml(): string {
	const nonce = 'kodrixSettingsPageN1';
	return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
		<a class="item active" data-page="general">常规</a>
		<a class="item" data-page="codebase">代码库</a>
		<a class="item" data-page="ai">AI 供应商</a>
		<a class="item" data-page="fim">FIM 配置</a>
		<a class="item" data-page="embedding">Embedding 配置</a>
	</nav>

	<main>
		<h1 id="pageTitle">常规</h1>
		<div class="subtitle" id="pageSubtitle"></div>

		<!-- 常规：功能开关 -->
		<section id="page-general">
			<div id="featuresContainer"></div>
		</section>

		<!-- 代码库：索引与文档 -->
		<section id="page-codebase" hidden>
			<h2>代码库</h2>
			<div class="card">
				<h3>代码库索引</h3>
				<p class="desc">嵌入代码库以提升上下文理解和知识。嵌入和元数据存储在云端，但所有代码都存储在本地。</p>
				<div class="progress-row">
					<span class="percent" id="percent">--</span>
					<div class="bar"><div class="fill" id="fill"></div></div>
					<button id="pauseBtn" hidden>Pause Indexing</button>
					<button id="rebuildBtn" hidden>重建索引</button>
					<button id="deleteBtn" class="danger">删除索引</button>
				</div>
				<div class="status"><span class="dot" id="dot"></span><span id="statusText">--</span></div>
				<div class="file-list" id="fileList"></div>
			</div>
			<div class="card">
				<div class="setting-row">
					<div class="setting-text">
						<div class="title">索引新文件夹</div>
						<div class="desc">自动索引包含少于 50,000 个文件的文件夹</div>
					</div>
					<div class="toggle"><input type="checkbox" id="autoIndexFolders" data-key="autoIndexNewFolders"><span class="track"></span></div>
				</div>
				<div class="setting-row">
					<div class="setting-text">
						<div class="title">忽略 .cursorignore 中的文件</div>
						<div class="desc">除 .gitignore 外，还要从索引中排除的文件</div>
					</div>
					<div class="toggle"><input type="checkbox" id="ignoreCursorignore" data-key="ignoreCursorignore"><span class="track"></span></div>
					<button id="editCursorignore" class="ghost">编辑</button>
				</div>
				<div class="setting-row">
					<div class="setting-text">
						<div class="title">为即时 Grep 索引仓库 <span class="beta">测试版</span></div>
						<div class="desc">自动索引仓库以加速 Grep 搜索。所有数据均存储在本地。<span id="grepCount"></span></div>
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

const PAGES = {
	general: ['常规', 'Kodrix 核心功能总开关'],
	codebase: ['代码库', '索引与文档管理 — 全工程语义索引 · Grep 索引 · 忽略规则'],
	ai: ['AI 供应商', '模型路由与补全通道'],
	fim: ['FIM 配置', 'Tab 补全专用 FIM 通道（对标 Cursor Tab）'],
	embedding: ['Embedding 配置', '真向量语义检索（Embedding）'],
};

// ── 功能开关（常规页） ──
const FEATURE_GROUPS = [
	{
		title: '开发工作流',
		items: [
			['kodrix.features.wiki', 'Repo Wiki', '打开工作区自动生成项目 Wiki'],
			['kodrix.features.spec', 'Spec 驱动', '需求→设计→任务三栏工作流'],
			['kodrix.features.memory', '跨会话 Memory', '记住项目上下文'],
			['kodrix.features.kanban', 'Agent 看板', '任务可视化看板'],
			['kodrix.features.agentRouter', '智能路由', '按任务类型自动选择流程'],
			['kodrix.features.ideaFlow', 'Idea Flow', '想法→产品的全自动流水线'],
			['kodrix.features.vibeCoding', 'Vibe Coding', '一句话生成项目'],
			['kodrix.features.agentCrew', 'Agent Crew', '多智能体并行协作编排'],
			['kodrix.features.terminalAI', '终端 AI', 'Cmd+K 生成命令，Cmd+Enter 运行'],
		],
	},
	{
		title: '智能与上下文',
		items: [
			['kodrix.features.codebaseIntelligence', '代码库智能', '全工程语义索引（AST 符号/依赖/调用图）'],
			['kodrix.features.predictiveCompletion', '预测补全', '基于全工程索引的「下一步编辑」预测'],
			['kodrix.features.codebaseQuery', '代码库问答', '@codebase 自然语言查询定义/引用/架构'],
			['kodrix.features.semanticMemory', '语义记忆', 'TF-IDF 向量检索，零外部依赖'],
			['kodrix.features.proactiveContext', '主动上下文', '打开文件自动关联相关记忆'],
			['kodrix.features.contextIntelligence', '上下文智能', 'Wiki + Memory + Learning 自动注入'],
			['kodrix.features.learning', 'Learning 引擎', '跨会话知识沉淀，越用越聪明'],
			['kodrix.features.sessionLearning', '会话学习', 'Agent 会话结束自动蒸馏知识'],
		],
	},
	{
		title: '协作与工具',
		items: [
			['kodrix.features.arena', 'Arena 对比', '双模型输出对比'],
			['kodrix.features.hooks', 'Hooks 预置', 'GitHub Action 风格自动化钩子'],
			['kodrix.features.acp', 'ACP 外部 Agent', '接入第三方 Agent'],
			['kodrix.features.propertyTests', '属性测试', 'Spec / Kiro 风格属性测试生成'],
		],
	},
];

// ── 表单字段定义（AI / FIM / Embedding 页） ──
const AI_FIELDS = [
	{ key: 'kodrix.modelRouter.enabled', label: '模型 Auto 路由', hint: '按任务类型（smart/balanced/fast）自动选择模型', type: 'switch' },
	{ key: 'kodrix.tabCompletion.enabled', label: 'Tab 补全通道', hint: '启用 Kodrix Tab 补全（默认关闭以避免与上游 Copilot 冲突）', type: 'switch' },
	{ key: 'kodrix.arena.modelA', label: 'Arena 对比模型 A', hint: '留空则使用当前默认模型', type: 'text' },
	{ key: 'kodrix.arena.modelB', label: 'Arena 对比模型 B', hint: '', type: 'text' },
];

const FIM_FIELDS = [
	{ key: 'kodrix.tabCompletion.mode', label: '补全模式', type: 'select', options: [['fim', 'FIM 专用通道'], ['fast', '通用模型通道']] },
	{ key: 'kodrix.tabCompletion.fimProvider', label: 'FIM 提供方', type: 'select', options: [['deepseek', 'DeepSeek FIM'], ['custom', '自定义 FIM 接口']] },
	{ key: 'kodrix.tabCompletion.fimEndpoint', label: 'FIM 端点', type: 'text', hint: 'custom 提供方时填写自定义 URL（OpenAI 兼容 completions 格式）', showIf: 'kodrix.tabCompletion.fimProvider' },
	{ key: 'kodrix.tabCompletion.fimApiKey', label: 'FIM API Key', type: 'password' },
	{ key: 'kodrix.tabCompletion.fimModel', label: 'FIM 模型', type: 'text', hint: 'DeepSeek 默认 deepseek-chat' },
];

const EMBEDDING_FIELDS = [
	{ key: 'kodrix.semanticEmbedding.enabled', label: '启用真向量语义检索', hint: '需同时填写 API Key。保存后自动启用。', type: 'switch' },
	{ key: 'kodrix.semanticEmbedding.apiKey', label: '智谱（BigModel）API Key', hint: 'https://open.bigmodel.cn', type: 'password' },
	{ key: 'kodrix.semanticEmbedding.endpoint', label: 'Embedding 端点', type: 'text' },
	{ key: 'kodrix.semanticEmbedding.model', label: 'Embedding 模型', hint: '默认 embedding-3', type: 'text' },
];

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
		window.removeEventListener('message', onConfig);
	});
}

// ── 表单渲染（AI / FIM / Embedding 页） ──
function renderForm(containerId, fields, values) {
	const rows = {};
	fields.forEach(f => {
		const val = values[f.key];
		let control = '';
		if (f.type === 'switch') {
			control = '<div class="toggle"><input type="checkbox" data-key="' + esc(f.key) + '"' + (val ? ' checked' : '') + '><span class="track"></span></div>';
		} else if (f.type === 'select') {
			control = '<select data-key="' + esc(f.key) + '">' + f.options.map(o =>
				'<option value="' + esc(o[0]) + '"' + (String(val) === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select>';
		} else {
			control = '<input type="' + (f.type === 'password' ? 'password' : 'text') + '" data-key="' + esc(f.key) + '" value="' + esc(val == null ? '' : val) + '">';
		}
		rows[f.key] = '<div class="form-row" data-key="' + esc(f.key) + '"><label>' + esc(f.label) + '</label>' + control +
			(f.hint ? '<div class="hint">' + esc(f.hint) + '</div>' : '') +
			'<div class="save-hint">已保存</div></div>';
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
	container.querySelectorAll('input[type="text"], input[type="password"]').forEach(input => {
		input.addEventListener('change', () => {
			post({ type: 'setConfig', key: input.dataset.key, value: input.value });
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
function renderIndex(s) {
	const percent = $('percent'), fill = $('fill'), dot = $('dot');
	const statusText = $('statusText'), pauseBtn = $('pauseBtn'), rebuildBtn = $('rebuildBtn');

	if (s.status === 'idle') {
		percent.textContent = '--';
		fill.style.width = '0%';
		dot.className = 'dot';
		statusText.textContent = '未索引';
		pauseBtn.hidden = true;
		rebuildBtn.hidden = false;
	} else if (s.status === 'building' || s.status === 'paused') {
		const total = s.progress.total || 0;
		const pct = total ? Math.min(100, Math.round(s.progress.parsed / total * 100)) : 0;
		percent.textContent = pct + '%';
		fill.style.width = pct + '%';
		dot.className = 'dot ' + (s.status === 'paused' ? 'paused' : 'syncing');
		statusText.textContent = s.status === 'paused' ? '已暂停 (Paused)' : '正在同步 (Syncing) ' + s.progress.parsed + '/' + total;
		pauseBtn.hidden = false;
		pauseBtn.textContent = s.status === 'paused' ? 'Resume' : 'Pause Indexing';
		rebuildBtn.hidden = true;
	} else if (s.status === 'done') {
		const total = s.stats ? s.stats.totalFiles : 0;
		percent.textContent = total + ' 文件';
		fill.style.width = '100%';
		dot.className = 'dot done';
		if (total === 0) {
			statusText.textContent = '索引为空 — 未发现可索引源文件，可点击「重建索引」重试';
		} else {
			statusText.textContent = '索引完成' + (s.stats ? ' · ' + s.stats.totalSymbols + ' 个符号 · ' + Math.round((s.stats.indexDurationMs || 0) / 1000) + 's' : '');
		}
		pauseBtn.hidden = true;
		rebuildBtn.hidden = false;
	}

	const list = $('fileList');
	if (!s.files || !s.files.length) {
		list.innerHTML = s.status === 'done'
			? '<div class="empty">尚无索引文件。请确认工作区已打开，且存在 .ts/.js/.py 等源文件（已排除 node_modules / out 等）。</div>'
			: '<div class="empty">尚无索引文件</div>';
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
	$('grepCount').textContent = s.grepFileCount > 0 ? '（已索引 ' + s.grepFileCount + ' 个文件）' : '';
}

// ── 按钮与开关 ──
$('pauseBtn').addEventListener('click', () => post({ type: 'indexAction', action: 'pause' }));
$('rebuildBtn').addEventListener('click', () => post({ type: 'indexAction', action: 'rebuild' }));
$('deleteBtn').addEventListener('click', () => {
	if (confirm('确定要删除代码库索引吗？删除后需要重新构建。')) post({ type: 'indexAction', action: 'delete' });
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
