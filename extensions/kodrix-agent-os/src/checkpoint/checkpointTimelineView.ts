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
			description: `${cp.fileCount} ${l10n.t('个文件')} · ${formatTime(cp.createdAt)}`,
			tooltip: new vscode.MarkdownString(
				`**${escapeMarkdown(cp.label)}**\n\n` +
				`${l10n.t('ID')}：\`${cp.id}\`\n\n` +
				`${l10n.t('创建时间')}：${cp.createdAt}\n\n` +
				`${l10n.t('文件数')}：${cp.fileCount}`
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
					title: l10n.t('对比文件差异'),
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
			return 'file';
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
	context.subscriptions.push(treeView);

	// 刷新时间线
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.checkpoint.refreshTimeline', () => provider.refresh()),
	);

	// 对比单文件差异
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.checkpoint.diffFile', async (checkpointId: string, relPath: string) => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				vscode.window.showWarningMessage(l10n.t('请先打开工作区'));
				return;
			}
			const manifest = await readCheckpointManifest(checkpointId);
			if (!manifest) {
				vscode.window.showErrorMessage(l10n.t('检查点不存在'));
				return;
			}
			const file = manifest.files.find(f => f.relPath === relPath);
			if (!file) {
				vscode.window.showErrorMessage(l10n.t('文件中不存在于该检查点'));
				return;
			}
			const abs = path.join(folder.uri.fsPath, relPath);
			// 创建临时文件存放检查点内容
			const tempDir = path.join(folder.uri.fsPath, '.kodrix', 'checkpoint-temp');
			await fs.promises.mkdir(tempDir, { recursive: true });
			const tempPath = path.join(tempDir, `${checkpointId}-${relPath.replace(/[\\/]/g, '_')}`);
			await fs.promises.writeFile(tempPath, file.content, 'utf-8');

			const title = `${relPath} — ${l10n.t('检查点')} vs ${l10n.t('当前')}`;
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
			const ok = await vscode.window.showWarningMessage(
				l10n.t('确定回滚到「{0}」？将覆盖 {1}', label, `${manifest?.files.length ?? 0} ${l10n.t('个文件')}`),
				{ modal: true },
				l10n.t('回滚'),
			);
			if (ok !== l10n.t('回滚')) {
				return;
			}
			try {
				const r = await restoreCheckpoint(item.checkpointId);
				vscode.window.showInformationMessage(
					l10n.t('回滚完成：恢复 {0} 个文件{1}', r.restored, r.skipped ? l10n.t('，跳过 {0}', r.skipped) : ''),
				);
				provider.refresh();
			} catch (err) {
				vscode.window.showErrorMessage(l10n.t('回滚失败：{0}', err instanceof Error ? err.message : String(err)));
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
				l10n.t('确定删除检查点「{0}」？此操作不可恢复', label),
				{ modal: true },
				l10n.t('删除'),
			);
			if (ok !== l10n.t('删除')) {
				return;
			}
			if (await deleteCheckpoint(item.checkpointId)) {
				vscode.window.showInformationMessage(l10n.t('已删除检查点「{0}」', label));
				provider.refresh();
			} else {
				vscode.window.showErrorMessage(l10n.t('删除检查点失败'));
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
