/*---------------------------------------------------------------------------------------------
 *  Checkpoint Timeline View — TreeView 展示检查点时间线
 *
 *  能力：
 *    1. 在侧边栏以树形结构展示所有检查点（新→旧）
 *    2. 展开检查点可查看快照文件列表
 *    3. 点击文件可打开 diff 对比（检查点版本 vs 当前工作区）
 *    4. 右键菜单支持回滚、删除、打开 Diff 画廊
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	listCheckpoints,
	getCheckpointFiles,
	readCheckpointManifest,
	deleteCheckpoint,
	restoreCheckpoint,
	type CheckpointFile,
} from './checkpointManager';

// ── TreeItem 定义 ────────────────────────────────────────────────

interface CheckpointTreeItem extends vscode.TreeItem {
	checkpointId?: string;
	relPath?: string;
}

// ── TreeDataProvider ─────────────────────────────────────────────

class CheckpointTimelineProvider implements vscode.TreeDataProvider<CheckpointTreeItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<CheckpointTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	/** 释放 TreeDataProvider 的变更事件（注册处将其 push 进 context.subscriptions） */
	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	getTreeItem(element: CheckpointTreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: CheckpointTreeItem): Promise<CheckpointTreeItem[]> {
		if (element?.checkpointId && element.relPath === undefined) {
			// 展开检查点 → 显示文件列表
			return this.getCheckpointFiles(element.checkpointId);
		}
		// 根节点 → 列出所有检查点
		return this.getCheckpoints();
	}

	private async getCheckpoints(): Promise<CheckpointTreeItem[]> {
		const checkpoints = await listCheckpoints();
		return checkpoints.map(cp => ({
			label: cp.label || cp.id,
			description: `${cp.fileCount} ${l10n.t('files')} · ${formatTime(cp.createdAt)}`,
			tooltip: new vscode.MarkdownString(
				`**${escapeMarkdown(cp.label)}**\n\n` +
				`${l10n.t('ID')}: \`${cp.id}\`\n\n` +
				`${l10n.t('Created At')}: ${cp.createdAt}\n\n` +
				`${l10n.t('File count')}: ${cp.fileCount}`
			),
			iconPath: new vscode.ThemeIcon('history'),
			collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
			contextValue: 'checkpoint',
			checkpointId: cp.id,
		}));
	}

	private async getCheckpointFiles(checkpointId: string): Promise<CheckpointTreeItem[]> {
		const files = await getCheckpointFiles(checkpointId);
		return Promise.all(files.map(async f => {
			const statusIcon = await this.getFileDiffIcon(checkpointId, f);
			return {
				label: path.basename(f.relPath),
				description: f.relPath,
				tooltip: f.relPath,
				iconPath: new vscode.ThemeIcon(statusIcon),
				collapsibleState: vscode.TreeItemCollapsibleState.None,
				contextValue: 'checkpointFile',
				checkpointId,
				relPath: f.relPath,
				command: {
					command: 'kodrix.checkpoint.diffFile',
					title: l10n.t('Compare File Differences'),
					arguments: [checkpointId, f.relPath],
				},
			};
		}));
	}

	private async getFileDiffIcon(_checkpointId: string, file: CheckpointFile): Promise<string> {
		// 简单判断：检查工作区当前文件是否存在且内容不同
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return 'file';
		}
		const abs = path.join(folder.uri.fsPath, file.relPath);
		try {
			const current = await fs.promises.readFile(abs, 'utf-8');
			if (current !== file.content) {
				return 'file-diff';
			}
			return 'file';
		} catch {
			return 'file-diff';
		}
	}
}

// ── 辅助函数 ────────────────────────────────────────────────────

function formatTime(iso: string): string {
	const d = new Date(iso);
	if (isNaN(d.getTime())) {
		return iso;
	}
	return d.toLocaleString();
}

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}

// ── 注册 ────────────────────────────────────────────────────────

export function registerCheckpointTimeline(context: vscode.ExtensionContext): void {
	const provider = new CheckpointTimelineProvider();

	const treeView = vscode.window.createTreeView('kodrix.checkpoints', {
		treeDataProvider: provider,
		showCollapseAll: true,
	});
	context.subscriptions.push(treeView, provider);

	// 刷新时间线
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.checkpoint.refreshTimeline', () => provider.refresh()),
	);

	// 对比单文件差异
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.checkpoint.diffFile', async (checkpointId: string, relPath: string) => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				vscode.window.showWarningMessage(l10n.t('Please open a workspace first'));
				return;
			}
			const manifest = await readCheckpointManifest(checkpointId);
			if (!manifest) {
				vscode.window.showErrorMessage(l10n.t('Checkpoint not found'));
				return;
			}
			const file = manifest.files.find(f => f.relPath === relPath);
			if (!file) {
				vscode.window.showErrorMessage(l10n.t('File does not exist in this checkpoint'));
				return;
			}
			const abs = path.join(folder.uri.fsPath, relPath);
			// 临时文件写到**系统临时目录**：此前写在工作区 .kodrix/checkpoint-temp/ 且用后不删，
			// 工作区会越堆越脏（还容易被误当成项目文件）。系统临时目录由 OS 回收，不污染工作区。
			const tempDir = path.join(os.tmpdir(), 'kodrix-checkpoint-diff');
			await fs.promises.mkdir(tempDir, { recursive: true });
			const tempPath = path.join(tempDir, `${checkpointId}-${relPath.replace(/[\\/]/g, '_')}`);
			await fs.promises.writeFile(tempPath, file.content, 'utf-8');

			// 两边内容一致时不开 diff：否则用户会看到一个没有差异的对比页，不知道是不是坏了
			let currentContent = '';
			try { currentContent = await fs.promises.readFile(abs, 'utf-8'); } catch { /* 文件可能已删除 */ }
			if (currentContent === file.content) {
				void vscode.window.showInformationMessage(l10n.t('This file matches the checkpoint content; no need to compare: {0}', relPath));
				void fs.promises.unlink(tempPath).catch(() => undefined);
				return;
			}

			const title = `${relPath} — ${l10n.t('Checkpoint')} vs ${l10n.t('Current')}`;
			await vscode.commands.executeCommand(
				'vscode.diff',
				vscode.Uri.file(tempPath),
				vscode.Uri.file(abs),
				title,
			);
		}),
	);

	// 右键菜单：回滚到该检查点
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.checkpoint.restoreFromTree', async (item: CheckpointTreeItem) => {
			if (!item.checkpointId) {
				return;
			}
			const manifest = await readCheckpointManifest(item.checkpointId);
			const label = manifest?.label ?? item.checkpointId;
			const rollbackLabel = l10n.t('Roll Back');
			const ok = await vscode.window.showWarningMessage(
				l10n.t('Roll back to "{0}"? This will overwrite {1}', label, `${manifest?.files.length ?? 0} ${l10n.t('files')}`),
				{ modal: true },
				rollbackLabel,
				l10n.t('Cancel'),
			);
			if (ok !== rollbackLabel) {
				return;
			}
			try {
				const r = await restoreCheckpoint(item.checkpointId);
				vscode.window.showInformationMessage(
					l10n.t('Rollback complete: restored {0} files{1}', r.restored, r.skipped ? l10n.t(', skipped {0}', r.skipped) : ''),
				);
				provider.refresh();
			} catch (err) {
				vscode.window.showErrorMessage(l10n.t('Rollback failed: {0}', err instanceof Error ? err.message : String(err)));
			}
		}),
	);

	// 右键菜单：删除检查点
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.checkpoint.deleteFromTree', async (item: CheckpointTreeItem) => {
			if (!item.checkpointId) {
				return;
			}
			const manifest = await readCheckpointManifest(item.checkpointId);
			const label = manifest?.label ?? item.checkpointId;
			const ok = await vscode.window.showWarningMessage(
				l10n.t('Delete checkpoint "{0}"? This action cannot be undone', label),
				{ modal: true },
				l10n.t('Delete'),
			);
			if (ok !== l10n.t('Delete')) {
				return;
			}
			if (await deleteCheckpoint(item.checkpointId)) {
				vscode.window.showInformationMessage(l10n.t('Deleted checkpoint "{0}"', label));
				provider.refresh();
			} else {
				vscode.window.showErrorMessage(l10n.t('Failed to delete checkpoint'));
			}
		}),
	);

	// 监听文件保存自动刷新（捕获新检查点）
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(() => {
			// 延迟刷新，避免频繁
			setTimeout(() => provider.refresh(), 1000);
		}),
	);
}
