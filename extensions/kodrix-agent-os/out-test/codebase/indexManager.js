"use strict";
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
exports.registerIndexManager = registerIndexManager;
exports.buildIndexManagerHtml = buildIndexManagerHtml;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const projectIndexer_1 = require("./projectIndexer");
const logger_1 = require("../logger");
const panelTracker_1 = require("../utils/panelTracker");
const webviewHtml_1 = require("../shared/webviewHtml");
const CONFIG_SECTION = 'kodrix.codebase';
function getCfg(key, def) {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get(key, def);
}
async function setCfg(key, value) {
    await vscode.workspace.getConfiguration(CONFIG_SECTION).update(key, value, vscode.ConfigurationTarget.Global);
}
// ── 面板生命周期 ──────────────────────────────────────────────
let _panel;
let _ctx;
/** grep 索引文件数缓存：避免每次状态推送都重新解析整个 grep-index.json */
let _grepFileCount = 0;
function registerIndexManager(context) {
    _ctx = context;
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.codebase.indexManager.open', () => {
        openIndexManagerPanel();
    }));
    // 面板关闭时清理引用；状态事件订阅随 context 释放
    context.subscriptions.push((0, projectIndexer_1.onIndexStateChange)(() => {
        if (_panel) {
            pushState(_panel);
        }
    }));
}
function openIndexManagerPanel() {
    const column = _panel?.viewColumn ?? vscode.ViewColumn.Active;
    if (_panel) {
        _panel.reveal(column);
        return;
    }
    // 打开面板时刷新一次 grep 计数（仅此一次，避免构建期间反复解析）
    _grepFileCount = (0, projectIndexer_1.getGrepIndexFiles)().length;
    _panel = (0, panelTracker_1.createTrackedPanel)(_ctx, 'kodrix.codebaseIndexManager', vscode_1.l10n.t('Indexing & Docs'), column, { enableScripts: true, retainContextWhenHidden: true });
    _panel.webview.html = buildIndexManagerHtml(_panel.webview);
    pushState(_panel);
    _panel.webview.onDidReceiveMessage(async (msg) => {
        try {
            switch (msg?.type) {
                case 'getState':
                    if (_panel) {
                        pushState(_panel);
                    }
                    break;
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
                case 'toggle':
                    await handleToggle(msg.key, msg.value);
                    break;
                case 'editCursorignore':
                    await openCursorignoreFile();
                    break;
                case 'getAllFiles':
                    // 面板默认只显示最近 30 个文件；用户要确认"某个文件是否被索引"时按需拉全量
                    // （配合客户端过滤框，大仓也能查）
                    _panel?.webview.postMessage({ type: 'allFiles', files: (0, projectIndexer_1.getIndexFiles)().map(toFileRow) });
                    break;
            }
        }
        catch (err) {
            logger_1.logger.warn(`[IndexManager] Failed to handle message ${msg?.type}: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
    _panel.onDidDispose(() => {
        _panel = undefined;
    });
}
// ── 状态推送 ──────────────────────────────────────────────────
function pushState(panel) {
    panel.webview.postMessage({ type: 'state', state: buildPanelState() });
}
/** 文件行（用于全量文件列表消息） */
function toFileRow(f) {
    return { language: f.language || 'txt', relativePath: f.relativePath, symbolCount: f.symbolCount ?? 0 };
}
function buildPanelState() {
    const st = (0, projectIndexer_1.getIndexState)();
    const grepIndex = getCfg('grepIndex', true);
    return {
        status: st.status,
        progress: st.progress,
        stats: st.stats,
        files: st.files.map(f => toFileRow(f)),
        config: {
            autoIndexNewFolders: getCfg('autoIndexNewFolders', true),
            ignoreCursorignore: getCfg('ignoreCursorignore', true),
            grepIndex,
        },
        grepFileCount: grepIndex ? _grepFileCount : 0,
    };
}
// ── 配置开关处理 ──────────────────────────────────────────────
async function handleToggle(key, value) {
    await setCfg(key, value);
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
            (0, projectIndexer_1.startIndexWatcher)(_ctx);
        }
        else {
            (0, projectIndexer_1.disposeIndexWatcher)();
        }
    }
    else if (key === 'ignoreCursorignore') {
        void (0, projectIndexer_1.ensureProjectIndex)(true, { manual: true }).catch(err => {
            void vscode.window.showErrorMessage(vscode_1.l10n.t('Index rebuild failed: {0}', err instanceof Error ? err.message : String(err)));
        });
    }
    // 回发最新状态刷新面板
    if (_panel) {
        pushState(_panel);
    }
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
// ── Webview HTML ──────────────────────────────────────────────
/** 面板 HTML（导出供测试断言：脚本可解析 + 文案全部走 l10n） */
function buildIndexManagerHtml(webview) {
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
<h1>${vscode_1.l10n.t('Indexing & Docs')}</h1>
<div class="subtitle">${vscode_1.l10n.t('Manage the Kodrix codebase index')}</div>

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
	<div class="file-tools" style="display:flex;gap:6px;align-items:center;margin:6px 0">
		<input type="text" id="fileFilter" placeholder="${(0, webviewHtml_1.htmlAttr)(vscode_1.l10n.t('Filter file paths…'))}" style="flex:1;min-width:0">
		<button id="loadAllFiles">${vscode_1.l10n.t('Show all')}</button>
	</div>
	<div class="file-list" id="fileList"></div>
</div>

<div class="settings">
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

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();

const $ = id => document.getElementById(id);

/** 本地化后的动态文案：宿主侧已把 {0}/{1} 占位保留，这里按运行时的值替换 */
const fmt = (template, ...args) => String(template).replace(/\\{(\\d+)\\}/g, (m, i) => (args[i] === undefined ? m : String(args[i])));

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
		statusText.textContent = ${(0, webviewHtml_1.jsJson)(vscode_1.l10n.t('Not indexed'))};
		pauseBtn.hidden = true;
		rebuildBtn.hidden = false;
	} else if (s.status === 'building' || s.status === 'paused') {
		const total = s.progress.total || 0;
		const pct = total ? Math.min(100, Math.round(s.progress.parsed / total * 100)) : 0;
		percent.textContent = pct + '%';
		fill.style.width = pct + '%';
		dot.className = 'dot ' + (s.status === 'paused' ? 'paused' : 'syncing');
		statusText.textContent = s.status === 'paused'
			? ${(0, webviewHtml_1.jsJson)(vscode_1.l10n.t('Paused'))}
			: fmt(${(0, webviewHtml_1.jsJson)(vscode_1.l10n.t('Syncing {0}/{1}'))}, s.progress.parsed, total);
		pauseBtn.hidden = false;
		pauseBtn.textContent = s.status === 'paused' ? ${(0, webviewHtml_1.jsJson)(vscode_1.l10n.t('Resume'))} : ${(0, webviewHtml_1.jsJson)(vscode_1.l10n.t('Pause Indexing'))};
		rebuildBtn.hidden = true;
	} else if (s.status === 'done') {
		const total = s.stats ? s.stats.totalFiles : 0;
		percent.textContent = fmt(${(0, webviewHtml_1.jsJson)(vscode_1.l10n.t('{0} files'))}, total);
		fill.style.width = '100%';
		dot.className = 'dot done';
		if (total === 0) {
			statusText.textContent = ${(0, webviewHtml_1.jsJson)(vscode_1.l10n.t('Index is empty — no indexable source files found. Click "Rebuild Index" to retry'))};
		} else {
			statusText.textContent = s.stats
				? fmt(${(0, webviewHtml_1.jsJson)(vscode_1.l10n.t('Indexing complete · {0} symbols · {1}s'))}, s.stats.totalSymbols, Math.round((s.stats.indexDurationMs || 0) / 1000))
				: ${(0, webviewHtml_1.jsJson)(vscode_1.l10n.t('Indexing complete'))};
		}
		pauseBtn.hidden = true;
		rebuildBtn.hidden = false;
	}

	// 文件列表：默认最近 30 条；点「显示全部」拉全量，配合过滤框可确认"某文件是否被索引"
	renderFileList(s.files || [], s.status === 'done');

	// 配置开关
	const cfg = s.config || {};
	['autoIndexNewFolders', 'ignoreCursorignore', 'grepIndex'].forEach(key => {
		const el = document.querySelector('input[data-key="' + key + '"]');
		if (el) el.checked = !!cfg[key];
	});
	const grepCount = $('grepCount');
	if (s.grepFileCount > 0) {
		grepCount.textContent = fmt(${(0, webviewHtml_1.jsJson)(vscode_1.l10n.t('({0} files indexed)'))}, s.grepFileCount);
	} else {
		grepCount.textContent = '';
	}
}

function escapeHtml(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 当前文件列表数据源：默认是最近 30 条，点「显示全部」后换成全量 */
let fileRows = [];
let fileRowsFull = false;

function renderFileList(files, isDone) {
	fileRows = files || [];
	const filter = ($('fileFilter').value || '').trim().toLowerCase();
	const shown = filter ? fileRows.filter(f => String(f.relativePath).toLowerCase().includes(filter)) : fileRows;
	const list = $('fileList');
	if (!shown.length) {
		list.innerHTML = filter
			? '<div class="empty">' + fmt(${(0, webviewHtml_1.jsJson)(vscode_1.l10n.t('No indexed files match "{0}". If the file does exist, check whether it is excluded by rules such as .cursorignore / node_modules, or click "Show All" and confirm.'))}, escapeHtml(filter)) + '</div>'
			: (isDone
				? '<div class="empty">' + ${(0, webviewHtml_1.jsJson)(vscode_1.l10n.t('No indexed files yet. Make sure a workspace is open and contains source files such as .ts/.js/.py (node_modules / out etc. are excluded).'))} + '</div>'
				: '<div class="empty">' + ${(0, webviewHtml_1.jsJson)(vscode_1.l10n.t('No indexed files yet'))} + '</div>');
		return;
	}
	list.innerHTML = shown.map(f =>
		'<div class="file-item"><span class="lang-badge">' + escapeHtml(f.language) + '</span><span>' + escapeHtml(f.relativePath) + '</span></div>'
	).join('') + (filter || fileRowsFull
		? ''
		: '<div class="empty">' + fmt(${(0, webviewHtml_1.jsJson)(vscode_1.l10n.t('Showing only the last {0} files — click "Show All" above to see the full list'))}, fileRows.length) + '</div>');
}

// 消息接收
let lastIndexStatus = 'idle';
window.addEventListener('message', e => {
	if (e.data && e.data.type === 'state') {
		lastIndexStatus = e.data.state && e.data.state.status ? e.data.state.status : 'idle';
		render(e.data.state);
	} else if (e.data && e.data.type === 'allFiles') {
		fileRowsFull = true;
		renderFileList(e.data.files || [], true);
	}
});

$('loadAllFiles').addEventListener('click', () => {
	vscode.postMessage({ type: 'getAllFiles' });
});
$('fileFilter').addEventListener('input', () => {
	renderFileList(fileRows, lastIndexStatus === 'done');
});

// 按钮：同一个按钮在「构建中」发 pause、在「已暂停」发 resume
// （此前固定发 pause，导致按钮显示 Resume 却点不动，索引永久卡在暂停态）
$('pauseBtn').addEventListener('click', () => {
	vscode.postMessage({ type: lastIndexStatus === 'paused' ? 'resume' : 'pause' });
});
$('rebuildBtn').addEventListener('click', () => {
	vscode.postMessage({ type: 'rebuild' });
});
$('deleteBtn').addEventListener('click', () => {
	if (confirm(${(0, webviewHtml_1.jsJson)(vscode_1.l10n.t('Delete the codebase index? You will need to rebuild it afterwards.'))})) {
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
