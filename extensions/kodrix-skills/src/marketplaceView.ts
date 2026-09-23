/*---------------------------------------------------------------------------------------------
 *  Skill 市场 TreeView
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CatalogItem, listInstalledSkills, loadCatalog } from './skillInstall';

type GroupId = 'installed' | 'catalog';

export class SkillMarketplaceProvider implements vscode.TreeDataProvider<SkillTreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<SkillTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly extensionPath: string) { }

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: SkillTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: SkillTreeItem): SkillTreeItem[] {
		if (!element) {
			return [
				new SkillTreeItem('已安装', vscode.TreeItemCollapsibleState.Expanded, 'group', undefined, 'installed'),
				new SkillTreeItem('官方市场', vscode.TreeItemCollapsibleState.Expanded, 'group', undefined, 'catalog'),
			];
		}

		if (element.groupId === 'installed') {
			const installed = listInstalledSkills();
			if (installed.length === 0) {
				return [new SkillTreeItem('（暂无）', vscode.TreeItemCollapsibleState.None, 'empty')];
			}
			return installed.map(name =>
				new SkillTreeItem(name, vscode.TreeItemCollapsibleState.None, 'installed', undefined, true),
			);
		}

		if (element.groupId === 'catalog') {
			const catalog = loadCatalog(this.extensionPath);
			const installed = new Set(listInstalledSkills());
			return catalog.items.map(it => {
				const installName = it.installName || it.id.split('.').pop() || '';
				const isInstalled = installed.has(installName);
				return new SkillTreeItem(
					`${it.icon || '📦'} ${it.displayName}`,
					vscode.TreeItemCollapsibleState.None,
					'skillItem',
					it,
					isInstalled,
					it.description,
				);
			});
		}

		return [];
	}
}

export class SkillTreeItem extends vscode.TreeItem {
	constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		public override readonly contextValue: string,
		public readonly catalogItem?: CatalogItem,
		public readonly installed?: boolean | GroupId,
		description?: string,
	) {
		super(label, collapsibleState);
		this.description = description;
		if (typeof installed === 'string') {
			this.groupId = installed;
		}
		if (catalogItem && !installed) {
			this.command = {
				command: 'kodrix.skills.install',
				title: '安装',
				arguments: [catalogItem],
			};
			this.tooltip = catalogItem.description;
		}
		if (installed === true) {
			this.iconPath = new vscode.ThemeIcon('check');
			if (catalogItem) {
				this.description = description || '已安装';
			}
		}
	}

	readonly groupId?: GroupId;
}
