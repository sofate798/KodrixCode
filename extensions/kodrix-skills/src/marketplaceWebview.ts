/*---------------------------------------------------------------------------------------------
 *  Skill 市场 — 扩展市场风格 WebviewView（卡片安装 / 搜索 / GitHub）
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	CatalogItem,
	importCursorSkills,
	installFromCatalogItem,
	installFromUrl,
	listInstalledSkills,
	loadCatalog,
	searchGithubSkillRepos,
	uninstallSkill,
} from './skillInstall';

type HostMsg =
	| { type: 'ready' }
	| { type: 'refresh' }
	| { type: 'install'; id: string }
	| { type: 'uninstall'; id: string }
	| { type: 'installGithub'; id: string }
	| { type: 'installFromUrl' }
	| { type: 'importCursor' }
	| { type: 'searchGithub'; query: string }
	| { type: 'open'; id: string };

export class SkillMarketplaceViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = 'kodrix.skillsMarketplace';

	private view?: vscode.WebviewView;
	private catalog: CatalogItem[] = [];

	constructor(private readonly extensionUri: vscode.Uri, private readonly extensionPath: string) {
		this.catalog = loadCatalog(extensionPath).items;
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources')],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		webviewView.webview.onDidReceiveMessage((msg: HostMsg) => {
			void this.onMessage(msg);
		});
	}

	refresh(): void {
		this.catalog = loadCatalog(this.extensionPath).items;
		this.pushState();
	}

	private pushState(status?: string): void {
		this.view?.webview.postMessage({
			type: 'state',
			items: this.catalog,
			installed: listInstalledSkills(),
			status,
		});
	}

	private async onMessage(msg: HostMsg): Promise<void> {
		try {
			switch (msg.type) {
				case 'ready':
				case 'refresh':
					this.refresh();
					return;
				case 'install': {
					const item = this.catalog.find(it => it.id === msg.id);
					if (!item) {
						throw new Error(`未找到市场项：${msg.id}`);
					}
					this.busy(msg.id);
					const name = await installFromCatalogItem(this.extensionPath, item);
					this.pushState(`已安装 ${name}`);
					vscode.window.showInformationMessage(`Skill 已安装：${name}`);
					return;
				}
				case 'uninstall': {
					this.busy(msg.id);
					uninstallSkill(msg.id);
					this.pushState(`已卸载 ${msg.id}`);
					return;
				}
				case 'installGithub': {
					this.busy(msg.id);
					const name = await installFromUrl(msg.id);
					this.pushState(`已从 GitHub 安装 ${name}`);
					vscode.window.showInformationMessage(`Skill 已安装：${name}`);
					return;
				}
				case 'installFromUrl': {
					const url = await vscode.window.showInputBox({
						prompt: 'GitHub 仓库 URL 或 raw SKILL.md 链接',
						placeHolder: 'https://github.com/owner/repo',
					});
					if (!url) {
						this.pushState();
						return;
					}
					this.busy(url);
					const name = await installFromUrl(url);
					this.pushState(`已安装 ${name}`);
					vscode.window.showInformationMessage(`Skill 已安装：${name}`);
					return;
				}
				case 'importCursor': {
					this.busy('import');
					const count = await importCursorSkills();
					this.pushState(
						count > 0
							? `已从 ~/.cursor/skills 导入 ${count} 个`
							: '未找到 ~/.cursor/skills',
					);
					return;
				}
				case 'searchGithub': {
					this.view?.webview.postMessage({ type: 'busy', id: 'github' });
					const items = await searchGithubSkillRepos(msg.query);
					this.view?.webview.postMessage({
						type: 'githubResults',
						items,
						status: `GitHub ${items.length} 个结果`,
					});
					return;
				}
				case 'open': {
					if (/^https:\/\//i.test(msg.id)) {
						await vscode.env.openExternal(vscode.Uri.parse(msg.id));
					}
					return;
				}
			}
		} catch (err: unknown) {
			const text = err instanceof Error ? err.message : String(err);
			this.view?.webview.postMessage({ type: 'status', text, error: true });
			this.pushState();
			vscode.window.showErrorMessage(`Skill 市场：${text}`);
		}
	}

	private busy(id: string): void {
		this.view?.webview.postMessage({ type: 'busy', id });
	}

	private getHtml(webview: vscode.Webview): string {
		const htmlPath = path.join(this.extensionPath, 'resources', 'skill-marketplace.html');
		try {
			const codiconsCssUri = webview.asWebviewUri(
				vscode.Uri.file(path.join(this.extensionPath, 'resources', 'codicons', 'codicon.css')),
			);
			return fs.readFileSync(htmlPath, 'utf-8')
				.replace(/\{\{cspSource\}\}/g, webview.cspSource)
				.replace(/\{\{codiconsCssUri\}\}/g, codiconsCssUri.toString());
		} catch {
			return `<!DOCTYPE html><html><body style="padding:16px;font-family:sans-serif">
				<p>Skill 市场资源加载失败，请重新编译 kodrix-skills。</p></body></html>`;
		}
	}
}
