/*---------------------------------------------------------------------------------------------
 *  Index Manager — 「索引与文档」管理面板（对标 Cursor 同款视图）
 *
 *  能力：
 *  1. 代码库索引卡片：实时进度（% + 进度条 + Syncing/Paused 状态）
 *  2. Pause Indexing / Resume / 删除索引 / 重建索引
 *  3. 已索引文件列表（语言徽标 + 相对路径）
 *  4. 索引新文件夹（自动索引 <50k 文件的文件夹）
 *  5. 忽略 .cursorignore 中的文件（编辑入口）
 *  6. 为即时 Grep 索引仓库（BETA，本地缓存文件清单加速 Grep）
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

const CONFIG_SECTION = 'kodrix.codebase';

function getCfg<T>(key: string, def: T): T {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get<T>(key, def);
}

async function setCfg(key: string, value: unknown): Promise<void> {
	await vscode.workspace.getConfiguration(CONFIG_SECTION).update(key, value, vscode.ConfigurationTarget.Global);
}

// ── 面板生命周期 ──────────────────────────────────────────────

let _panel: vscode.WebviewPanel | undefined;
let _ctx: vscode.ExtensionContext | undefined;
/** grep 索引文件数缓存：避免每次状态推送都重新解析整个 grep-index.json */
let _grepFileCount = 0;

export function registerIndexManager(context: vscode.ExtensionContext): void {
	_ctx = context;
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.codebase.indexManager.open', () => {
			openIndexManagerPanel();
		}),
	);

	// 面板关闭时清理引用；状态事件订阅随 context 释放
	context.subscriptions.push(onIndexStateChange(() => {
		if (_panel) pushState(_panel);
	}));
}

function openIndexManagerPanel(): void {
	const column = _panel?.viewColumn ?? vscode.ViewColumn.Active;
	if (_panel) {
		_panel.reveal(column);
		return;
	}

	// 打开面板时刷新一次 grep 计数（仅此一次，避免构建期间反复解析）
	_grepFileCount = getGrepIndexFiles().length;

	_panel = vscode.window.createWebviewPanel(
		'kodrix.codebaseIndexManager',
		'索引与文档',
		column,
		{ enableScripts: true, retainContextWhenHidden: true },
	);

	_panel.webview.html = getWebviewHtml();
	pushState(_panel);

	_panel.webview.onDidReceiveMessage(async (msg) => {
		try {
			switch (msg?.type) {
				case 'getState':
					if (_panel) pushState(_panel);
					break;
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
				case 'toggle':
					await handleToggle(msg.key, msg.value);
					break;
				case 'editCursorignore':
					await openCursorignoreFile();
					break;
			}
		} catch (err) {
			logger.warn(`[IndexManager] Failed to handle message ${msg?.type}: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	_panel.onDidDispose(() => {
		_panel = undefined;
	});
}

// ── 状态推送 ──────────────────────────────────────────────────

function pushState(panel: vscode.WebviewPanel): void {
	panel.webview.postMessage({ type: 'state', state: buildPanelState() });
}

function buildPanelState() {
	const st: IndexBuildState = getIndexState();
	const grepIndex = getCfg('grepIndex', true);
	return {
		status: st.status,
		progress: st.progress,
		stats: st.stats,
		files: st.files.map(f => ({ language: f.language || 'txt', relativePath: f.relativePath })),
		config: {
			autoIndexNewFolders: getCfg('autoIndexNewFolders', true),
			ignoreCursorignore: getCfg('ignoreCursorignore', true),
			grepIndex,
		},
		grepFileCount: grepIndex ? _grepFileCount : 0,
	};
}

// ── 配置开关处理 ──────────────────────────────────────────────

async function handleToggle(key: string, value: boolean): Promise<void> {
	await setCfg(key, value);

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
		if (value) startIndexWatcher(_ctx!);
		else disposeIndexWatcher();
	}

	// 回发最新状态刷新面板
	if (_panel) pushState(_panel);
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
	const nonce = 'kodrixIndexManagerN1';
	return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
:root {
	--bg: #ffffff;
	--text: #1f2328;
	--muted: #57606a;
	--border: #d0d7de;
	--bar-bg: #eaeef2;
	--accent: #0969da;
	--danger: #cf222e;
	--badge-bg: #eaeef2;
	--badge-text: #57606a;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #1e1e1e;
		--text: #e6e6e6;
		--muted: #9d9d9d;
		--border: #454545;
		--bar-bg: #3c3c3c;
		--accent: #4ea1ff;
		--danger: #f85149;
		--badge-bg: #3c3c3c;
		--badge-text: #b8b8b8;
	}
}
* { box-sizing: border-box; }
body {
	font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
	background: var(--bg);
	color: var(--text);
	padding: 20px 24px;
	max-width: 860px;
	margin: 0;
}
h1 { font-size: 22px; font-weight: 600; margin: 0 0 2px; }
.subtitle { font-size: 12.5px; color: var(--muted); margin-bottom: 18px; }
h2 { font-size: 15px; font-weight: 600; margin: 22px 0 10px; }
.card {
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 14px 16px;
}
.card h3 { font-size: 13.5px; font-weight: 600; margin: 0 0 4px; }
.card .desc { font-size: 12.5px; color: var(--muted); margin: 0 0 12px; line-height: 1.5; }
.progress-row { display: flex; align-items: center; gap: 10px; }
.percent { font-size: 13px; font-weight: 500; min-width: 52px; }
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
.file-list { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 6px; max-height: 180px; overflow-y: auto; }
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
.settings { margin-top: 18px; }
.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border); }
.setting-row:last-child { border-bottom: none; }
.setting-text { flex: 1; }
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
</style>
</head>
<body>
<h1>索引与文档</h1>
<div class="subtitle">管理 Kodrix 代码库索引</div>

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

<div class="settings">
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

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();

const $ = id => document.getElementById(id);

function render(s) {
	// 状态行
	const percent = $('percent');
	const fill = $('fill');
	const dot = $('dot');
	const statusText = $('statusText');
	const pauseBtn = $('pauseBtn');
	const rebuildBtn = $('rebuildBtn');

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
		statusText.textContent = '索引完成' + (s.stats ? ' · ' + s.stats.totalSymbols + ' 个符号 · ' + Math.round((s.stats.indexDurationMs || 0) / 1000) + 's' : '');
		pauseBtn.hidden = true;
		rebuildBtn.hidden = false;
	}

	// 文件列表
	const list = $('fileList');
	if (!s.files || !s.files.length) {
		list.innerHTML = '<div class="empty">尚无索引文件</div>';
	} else {
		list.innerHTML = s.files.map(f =>
			'<div class="file-item"><span class="lang-badge">' + escapeHtml(f.language) + '</span><span>' + escapeHtml(f.relativePath) + '</span></div>'
		).join('');
	}

	// 配置开关
	const cfg = s.config || {};
	['autoIndexNewFolders', 'ignoreCursorignore', 'grepIndex'].forEach(key => {
		const el = document.querySelector('input[data-key="' + key + '"]');
		if (el) el.checked = !!cfg[key];
	});
	const grepCount = $('grepCount');
	if (s.grepFileCount > 0) {
		grepCount.textContent = '（已索引 ' + s.grepFileCount + ' 个文件）';
	} else {
		grepCount.textContent = '';
	}
}

function escapeHtml(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 消息接收
window.addEventListener('message', e => {
	if (e.data && e.data.type === 'state') render(e.data.state);
});

// 按钮
$('pauseBtn').addEventListener('click', () => {
	vscode.postMessage({ type: 'pause' });
});
$('rebuildBtn').addEventListener('click', () => {
	vscode.postMessage({ type: 'rebuild' });
});
$('deleteBtn').addEventListener('click', () => {
	if (confirm('确定要删除代码库索引吗？删除后需要重新构建。')) {
		vscode.postMessage({ type: 'delete' });
	}
});
$('editCursorignore').addEventListener('click', () => {
	vscode.postMessage({ type: 'editCursorignore' });
});

// 配置开关
document.querySelectorAll('.toggle input').forEach(input => {
	input.addEventListener('change', () => {
		vscode.postMessage({ type: 'toggle', key: input.dataset.key, value: input.checked });
	});
});

// 初次拉取状态
vscode.postMessage({ type: 'getState' });
</script>
</body>
</html>`;
}
