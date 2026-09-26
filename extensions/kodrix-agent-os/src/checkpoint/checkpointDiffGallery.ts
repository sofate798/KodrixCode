/*---------------------------------------------------------------------------------------------
 *  Checkpoint Diff Gallery — Webview 检查点 Diff 画廊
 *
 *  能力：
 *    1. 选择两个检查点进行对比（或检查点 vs 当前工作区）
 *    2. Webview 左侧文件列表（checkbox 多选），右侧 diff 预览
 *    3. 逐文件对比：读取两个检查点的 manifest 中对应文件内容
 *    4. 逐文件接受/拒绝按钮 + 批量操作
 *    5. 回滚到指定检查点
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
	listCheckpoints,
	readCheckpointManifest,
	restoreCheckpoint,
	type CheckpointFile,
	type CheckpointManifest,
} from './checkpointManager';
import { logger } from '../logger';

// ── 类型 ────────────────────────────────────────────────────────

interface GalleryFileEntry {
	relPath: string;
	contentA: string;
	contentB: string;
	status: 'modified' | 'added' | 'deleted' | 'unchanged';
	accepted?: boolean;
}

interface GalleryData {
	files: GalleryFileEntry[];
	checkpointA: { id: string; label: string } | null;
	checkpointB: { id: string; label: string } | null;
}

// ── Webview 面板管理 ─────────────────────────────────────────────

class DiffGalleryPanel {
	private static currentPanel: DiffGalleryPanel | undefined;
	private readonly _panel: vscode.WebviewPanel;
	private _galleryData: GalleryData = { files: [], checkpointA: null, checkpointB: null };
	private _disposables: vscode.Disposable[] = [];

	private constructor(panel: vscode.WebviewPanel) {
		this._panel = panel;

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		this._panel.webview.onDidReceiveMessage(
			message => this._handleMessage(message),
			null,
			this._disposables,
		);
	}

	static show(extensionUri: vscode.Uri): void {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		if (DiffGalleryPanel.currentPanel) {
			DiffGalleryPanel.currentPanel._panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'kodrixCheckpointDiffGallery',
			l10n.t('检查点 Diff 画廊'),
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
			},
		);

		DiffGalleryPanel.currentPanel = new DiffGalleryPanel(panel);
		void DiffGalleryPanel.currentPanel._update();
	}

	dispose(): void {
		DiffGalleryPanel.currentPanel = undefined;
		this._panel.dispose();
		for (const d of this._disposables) {
			d.dispose();
		}
		this._disposables = [];
	}

	private async _handleMessage(message: { command: string; relPath?: string; checkpointId?: string }): Promise<void> {
		switch (message.command) {
			case 'selectFile':
				if (message.relPath) {
					await this._showFileDiff(message.relPath);
				}
				break;
			case 'acceptFile':
				if (message.relPath) {
					this._acceptFile(message.relPath);
				}
				break;
			case 'rejectFile':
				if (message.relPath) {
					this._rejectFile(message.relPath);
				}
				break;
			case 'acceptAll':
				this._acceptAll();
				break;
			case 'rejectAll':
				this._rejectAll();
				break;
			case 'compareCheckpoints':
				if (message.checkpointId) {
					await this._loadComparison(this._galleryData.checkpointA?.id ?? '', message.checkpointId);
				}
				break;
			case 'compareWithWorkspace':
				if (message.checkpointId) {
					await this._loadComparisonWithWorkspace(message.checkpointId);
				}
				break;
			case 'rollbackTo':
				if (message.checkpointId) {
					await this._rollbackTo(message.checkpointId);
				}
				break;
			case 'refreshGallery':
				await this._update();
				break;
		}
	}

	private _acceptFile(relPath: string): void {
		const entry = this._galleryData.files.find(f => f.relPath === relPath);
		if (entry) {
			entry.accepted = true;
			// 将检查点 B 的内容写回工作区
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (folder && this._galleryData.checkpointB) {
				const abs = path.join(folder.uri.fsPath, relPath);
				void (async () => {
					try {
						await fs.promises.mkdir(path.dirname(abs), { recursive: true });
						await fs.promises.writeFile(abs, entry.contentB, 'utf-8');
						logger.info(`[DiffGallery] 已接受文件：${relPath}`);
					} catch (err) {
						logger.error(`[DiffGallery] 接受文件失败：${relPath}`, err);
					}
					await this._update();
				})();
			}
		}
	}

	private _rejectFile(relPath: string): void {
		const entry = this._galleryData.files.find(f => f.relPath === relPath);
		if (entry) {
			entry.accepted = false;
			void this._update();
		}
	}

	private _acceptAll(): void {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder || !this._galleryData.checkpointB) {
			return;
		}
		void (async () => {
			for (const entry of this._galleryData.files) {
				if (entry.status === 'unchanged') {
					continue;
				}
				entry.accepted = true;
				const abs = path.join(folder.uri.fsPath, entry.relPath);
				try {
					await fs.promises.mkdir(path.dirname(abs), { recursive: true });
					await fs.promises.writeFile(abs, entry.contentB, 'utf-8');
				} catch (err) {
					logger.error(`[DiffGallery] 批量接受失败：${entry.relPath}`, err);
				}
			}
			await this._update();
		})();
	}

	private _rejectAll(): void {
		for (const entry of this._galleryData.files) {
			entry.accepted = false;
		}
		void this._update();
	}

	private async _showFileDiff(relPath: string): Promise<void> {
		const entry = this._galleryData.files.find(f => f.relPath === relPath);
		if (!entry) {
			return;
		}
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return;
		}
		// 创建临时文件用于 diff
		const tempDir = path.join(folder.uri.fsPath, '.kodrix', 'gallery-temp');
		await fs.promises.mkdir(tempDir, { recursive: true });
		const safeName = relPath.replace(/[\\/]/g, '_');
		const tempA = path.join(tempDir, `a-${safeName}`);
		const tempB = path.join(tempDir, `b-${safeName}`);
		await fs.promises.writeFile(tempA, entry.contentA, 'utf-8');
		await fs.promises.writeFile(tempB, entry.contentB, 'utf-8');

		const labelA = this._galleryData.checkpointA?.label ?? l10n.t('检查点 A');
		const labelB = this._galleryData.checkpointB?.label ?? l10n.t('检查点 B');
		await vscode.commands.executeCommand(
			'vscode.diff',
			vscode.Uri.file(tempA),
			vscode.Uri.file(tempB),
			`${relPath} — ${labelA} ↔ ${labelB}`,
		);
	}

	private async _loadComparison(idA: string, idB: string): Promise<void> {
		const manifestA = await readCheckpointManifest(idA);
		const manifestB = await readCheckpointManifest(idB);
		if (!manifestA || !manifestB) {
			vscode.window.showErrorMessage(l10n.t('检查点不存在'));
			return;
		}
		this._galleryData = {
			files: buildFileEntries(manifestA, manifestB),
			checkpointA: { id: manifestA.id, label: manifestA.label },
			checkpointB: { id: manifestB.id, label: manifestB.label },
		};
		await this._update();
	}

	private async _loadComparisonWithWorkspace(idA: string): Promise<void> {
		const manifestA = await readCheckpointManifest(idA);
		if (!manifestA) {
			vscode.window.showErrorMessage(l10n.t('检查点不存在'));
			return;
		}
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			vscode.window.showErrorMessage(l10n.t('请先打开工作区'));
			return;
		}
		// 构建"当前工作区"虚拟 manifest
		const currentFiles: CheckpointFile[] = [];
		for (const f of manifestA.files) {
			const abs = path.join(folder.uri.fsPath, f.relPath);
			try {
				const content = await fs.promises.readFile(abs, 'utf-8');
				currentFiles.push({ relPath: f.relPath, content });
			} catch {
				currentFiles.push({ relPath: f.relPath, content: '' });
			}
		}
		const workspaceManifest: CheckpointManifest = {
			id: '__workspace__',
			label: l10n.t('当前工作区'),
			createdAt: new Date().toISOString(),
			files: currentFiles,
		};
		this._galleryData = {
			files: buildFileEntries(manifestA, workspaceManifest),
			checkpointA: { id: manifestA.id, label: manifestA.label },
			checkpointB: { id: '__workspace__', label: l10n.t('当前工作区') },
		};
		await this._update();
	}

	private async _rollbackTo(checkpointId: string): Promise<void> {
		const manifest = await readCheckpointManifest(checkpointId);
		const label = manifest?.label ?? checkpointId;
		const ok = await vscode.window.showWarningMessage(
			l10n.t('确定回滚到「{0}」？将覆盖 {1}', label, `${manifest?.files.length ?? 0} ${l10n.t('个文件')}`),
			{ modal: true },
			l10n.t('回滚'),
		);
		if (ok !== l10n.t('回滚')) {
			return;
		}
		try {
			const r = await restoreCheckpoint(checkpointId);
			vscode.window.showInformationMessage(
				l10n.t('回滚完成：恢复 {0} 个文件{1}', r.restored, r.skipped ? l10n.t('，跳过 {0}', r.skipped) : ''),
			);
		} catch (err) {
			vscode.window.showErrorMessage(l10n.t('回滚失败：{0}', err instanceof Error ? err.message : String(err)));
		}
	}

	private async _update(): Promise<void> {
		this._panel.webview.html = await this._getHtml();
	}

	private async _getHtml(): Promise<string> {
		const data = this._galleryData;
		const checkpoints = await listCheckpoints();

		const filesJson = JSON.stringify(data.files.map(f => ({
			relPath: f.relPath,
			status: f.status,
			accepted: f.accepted,
		})));

		const checkpointsJson = JSON.stringify(checkpoints.map(c => ({
			id: c.id,
			label: c.label,
			createdAt: c.createdAt,
			fileCount: c.fileCount,
		})));

		return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${escapeHtml(l10n.t('检查点 Diff 画廊'))}</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			margin: 0;
			padding: 0;
			height: 100vh;
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}
		.toolbar {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 8px 12px;
			border-bottom: 1px solid var(--vscode-panel-border);
			background: var(--vscode-sideBar-background);
			flex-shrink: 0;
		}
		.toolbar select, .toolbar button {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			padding: 4px 8px;
			border: 1px solid var(--vscode-input-border);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border-radius: 2px;
		}
		.toolbar button {
			cursor: pointer;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
		}
		.toolbar button:hover {
			background: var(--vscode-button-hoverBackground);
		}
		.toolbar button.secondary {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		.toolbar button.secondary:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}
		.toolbar button.danger {
			background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
			color: var(--vscode-errorForeground, #f48771);
		}
		.main {
			display: flex;
			flex: 1;
			overflow: hidden;
		}
		.file-list {
			width: 320px;
			min-width: 240px;
			border-right: 1px solid var(--vscode-panel-border);
			overflow-y: auto;
			flex-shrink: 0;
		}
		.file-list-header {
			padding: 8px 12px;
			font-weight: bold;
			border-bottom: 1px solid var(--vscode-panel-border);
			background: var(--vscode-sideBarSectionHeader-background);
			display: flex;
			justify-content: space-between;
			align-items: center;
		}
		.file-item {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 6px 12px;
			cursor: pointer;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.file-item:hover {
			background: var(--vscode-list-hoverBackground);
		}
		.file-item.selected {
			background: var(--vscode-list-activeSelectionBackground);
			color: var(--vscode-list-activeSelectionForeground);
		}
		.file-item .status-icon {
			flex-shrink: 0;
			width: 16px;
			text-align: center;
		}
		.file-item .status-icon.modified { color: var(--vscode-editorWarning-foreground, #e2c08d); }
		.file-item .status-icon.added { color: var(--vscode-terminal-ansiGreen, #89d185); }
		.file-item .status-icon.deleted { color: var(--vscode-terminal-ansiRed, #f48771); }
		.file-item .status-icon.unchanged { color: var(--vscode-foreground); opacity: 0.5; }
		.file-item .file-name {
			flex: 1;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.file-item .actions {
			display: flex;
			gap: 4px;
			opacity: 0;
			transition: opacity 0.15s;
		}
		.file-item:hover .actions {
			opacity: 1;
		}
		.file-item .actions button {
			padding: 2px 6px;
			font-size: 11px;
			border: none;
			border-radius: 2px;
			cursor: pointer;
		}
		.file-item .actions .accept {
			background: var(--vscode-terminal-ansiGreen, #89d185);
			color: #fff;
		}
		.file-item .actions .reject {
			background: var(--vscode-terminal-ansiRed, #f48771);
			color: #fff;
		}
		.diff-panel {
			flex: 1;
			overflow: auto;
			padding: 0;
		}
		.diff-content {
			padding: 12px;
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: var(--vscode-editor-font-size, 13px);
			line-height: 1.5;
			white-space: pre-wrap;
			word-wrap: break-word;
		}
		.diff-line-add {
			background: rgba(137, 209, 133, 0.15);
			color: var(--vscode-terminal-ansiGreen, #89d185);
		}
		.diff-line-del {
			background: rgba(244, 135, 113, 0.15);
			color: var(--vscode-terminal-ansiRed, #f48771);
		}
		.diff-line-same {
			opacity: 0.7;
		}
		.empty-state {
			display: flex;
			align-items: center;
			justify-content: center;
			height: 100%;
			color: var(--vscode-descriptionForeground);
			font-style: italic;
		}
		.batch-actions {
			display: flex;
			gap: 8px;
			padding: 8px 12px;
			border-top: 1px solid var(--vscode-panel-border);
			background: var(--vscode-sideBar-background);
			flex-shrink: 0;
		}
		.badge {
			display: inline-block;
			padding: 1px 6px;
			border-radius: 8px;
			font-size: 11px;
			font-weight: bold;
		}
		.badge.modified { background: var(--vscode-editorWarning-foreground, #e2c08d); color: #000; }
		.badge.added { background: var(--vscode-terminal-ansiGreen, #89d185); color: #000; }
		.badge.deleted { background: var(--vscode-terminal-ansiRed, #f48771); color: #fff; }
		.accepted-mark {
			color: var(--vscode-terminal-ansiGreen, #89d185);
			font-weight: bold;
		}
	</style>
</head>
<body>
	<div class="toolbar">
		<select id="selectA" title="${escapeHtml(l10n.t('选择检查点 A'))}">
			<option value="">${escapeHtml(l10n.t('— 选择检查点 A —'))}</option>
		</select>
		<span>↔</span>
		<select id="selectB" title="${escapeHtml(l10n.t('选择检查点 B'))}">
			<option value="">${escapeHtml(l10n.t('— 选择检查点 B —'))}</option>
			<option value="__workspace__">${escapeHtml(l10n.t('当前工作区'))}</option>
		</select>
		<button id="btnCompare">${escapeHtml(l10n.t('对比'))}</button>
		<span style="flex:1"></span>
		<button id="btnRefresh" class="secondary">${escapeHtml(l10n.t('刷新'))}</button>
	</div>

	<div class="main">
		<div class="file-list">
			<div class="file-list-header">
				<span>${escapeHtml(l10n.t('文件列表'))}</span>
				<span id="fileCount"></span>
			</div>
			<div id="fileListBody"></div>
		</div>
		<div class="diff-panel" id="diffPanel">
			<div class="empty-state" id="emptyState">
				${escapeHtml(l10n.t('选择两个检查点进行对比，或检查点 vs 当前工作区'))}
			</div>
		</div>
	</div>

	<div class="batch-actions">
		<button id="btnAcceptAll" class="secondary">${escapeHtml(l10n.t('全部接受'))}</button>
		<button id="btnRejectAll" class="danger">${escapeHtml(l10n.t('全部拒绝'))}</button>
		<span style="flex:1"></span>
		<button id="btnRollback" class="danger">${escapeHtml(l10n.t('回滚到检查点 B'))}</button>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		const filesData = ${filesJson};
		const checkpointsData = ${checkpointsJson};
		const cpA = ${JSON.stringify(data.checkpointA)};
		const cpB = ${JSON.stringify(data.checkpointB)};

		let selectedFile = null;

		// 初始化下拉
		const selectA = document.getElementById('selectA');
		const selectB = document.getElementById('selectB');
		for (const cp of checkpointsData) {
			const optA = document.createElement('option');
			optA.value = cp.id;
			optA.textContent = cp.label + ' (' + new Date(cp.createdAt).toLocaleString() + ')';
			if (cpA && cpA.id === cp.id) optA.selected = true;
			selectA.appendChild(optA);

			const optB = document.createElement('option');
			optB.value = cp.id;
			optB.textContent = cp.label + ' (' + new Date(cp.createdAt).toLocaleString() + ')';
			if (cpB && cpB.id === cp.id) optB.selected = true;
			selectB.appendChild(optB);
		}
		if (cpB && cpB.id === '__workspace__') {
			selectB.value = '__workspace__';
		}

		// 渲染文件列表
		function renderFileList() {
			const body = document.getElementById('fileListBody');
			const countEl = document.getElementById('fileCount');
			if (!filesData.length) {
				body.innerHTML = '<div class="empty-state">${escapeHtml(l10n.t('无文件差异'))}</div>';
				countEl.textContent = '';
				return;
			}
			const modified = filesData.filter(f => f.status !== 'unchanged');
			countEl.textContent = modified.length + '/' + filesData.length;
			body.innerHTML = filesData.map(f => {
				const statusIcons = { modified: '●', added: '+', deleted: '−', unchanged: '○' };
				const acceptedMark = f.accepted ? '<span class="accepted-mark">✓</span>' : '';
				return '<div class="file-item' + (selectedFile === f.relPath ? ' selected' : '') + '" data-path="' + escapeAttr(f.relPath) + '">'
					+ '<span class="status-icon ' + f.status + '">' + statusIcons[f.status] + '</span>'
					+ '<span class="file-name">' + escapeHtml(f.relPath) + ' ' + acceptedMark + '</span>'
					+ '<span class="actions">'
					+ '<button class="accept" data-action="accept" data-path="' + escapeAttr(f.relPath) + '">✓</button>'
					+ '<button class="reject" data-action="reject" data-path="' + escapeAttr(f.relPath) + '">✗</button>'
					+ '</span>'
					+ '</div>';
			}).join('');

			// 绑定点击
			body.querySelectorAll('.file-item').forEach(el => {
				el.addEventListener('click', function(e) {
					if (e.target.closest('.actions')) return;
					const relPath = this.dataset.path;
					selectedFile = relPath;
					renderFileList();
					vscode.postMessage({ command: 'selectFile', relPath });
				});
			});
			body.querySelectorAll('.actions button').forEach(btn => {
				btn.addEventListener('click', function(e) {
					e.stopPropagation();
					const action = this.dataset.action;
					const relPath = this.dataset.path;
					vscode.postMessage({ command: action + 'File', relPath });
				});
			});
		}

		// 按钮事件
		document.getElementById('btnCompare').addEventListener('click', function() {
			const idA = selectA.value;
			const idB = selectB.value;
			if (!idA) { alert('${escapeHtml(l10n.t('请选择检查点 A'))}'); return; }
			if (!idB) { alert('${escapeHtml(l10n.t('请选择检查点 B'))}'); return; }
			if (idB === '__workspace__') {
				vscode.postMessage({ command: 'compareWithWorkspace', checkpointId: idA });
			} else {
				vscode.postMessage({ command: 'compareCheckpoints', checkpointId: idB });
				// 需要先设置 A
				vscode.postMessage({ command: 'compareCheckpoints', checkpointId: idB, checkpointIdA: idA });
			}
		});

		document.getElementById('btnRefresh').addEventListener('click', function() {
			vscode.postMessage({ command: 'refreshGallery' });
		});

		document.getElementById('btnAcceptAll').addEventListener('click', function() {
			vscode.postMessage({ command: 'acceptAll' });
		});

		document.getElementById('btnRejectAll').addEventListener('click', function() {
			vscode.postMessage({ command: 'rejectAll' });
		});

		document.getElementById('btnRollback').addEventListener('click', function() {
			const idB = selectB.value;
			if (!idB || idB === '__workspace__') {
				alert('${escapeHtml(l10n.t('请选择检查点 B'))}');
				return;
			}
			vscode.postMessage({ command: 'rollbackTo', checkpointId: idB });
		});

		function escapeHtml(s) {
			return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		}
		function escapeAttr(s) {
			return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
		}

		renderFileList();
	</script>
</body>
</html>`;
	}
}

// ── 辅助函数 ────────────────────────────────────────────────────

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildFileEntries(
	manifestA: CheckpointManifest,
	manifestB: CheckpointManifest,
): GalleryFileEntry[] {
	const fileMap = new Map<string, { a?: CheckpointFile; b?: CheckpointFile }>();

	for (const f of manifestA.files) {
		fileMap.set(f.relPath, { a: f });
	}
	for (const f of manifestB.files) {
		const existing = fileMap.get(f.relPath);
		if (existing) {
			existing.b = f;
		} else {
			fileMap.set(f.relPath, { b: f });
		}
	}

	const entries: GalleryFileEntry[] = [];
	for (const [relPath, { a, b }] of fileMap) {
		let status: GalleryFileEntry['status'];
		if (a && b) {
			status = a.content === b.content ? 'unchanged' : 'modified';
		} else if (a && !b) {
			status = 'deleted';
		} else if (!a && b) {
			status = 'added';
		} else {
			status = 'unchanged';
		}
		entries.push({
			relPath,
			contentA: a?.content ?? '',
			contentB: b?.content ?? '',
			status,
		});
	}

	// 排序：modified > added > deleted > unchanged
	const order: Record<string, number> = { modified: 0, added: 1, deleted: 2, unchanged: 3 };
	entries.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.relPath.localeCompare(b.relPath));
	return entries;
}

// ── 注册 ────────────────────────────────────────────────────────

export function registerCheckpointDiffGallery(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.checkpoint.diffGallery', () => {
			DiffGalleryPanel.show(context.extensionUri);
		}),
	);
}
