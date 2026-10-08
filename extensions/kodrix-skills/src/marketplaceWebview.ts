/*---------------------------------------------------------------------------------------------
 *  Skill 市场 — 扩展市场风格 WebviewView（卡片安装 / 搜索 / GitHub）
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import {
	CatalogItem,
	importCursorSkills,
	installFromCatalogItem,
	installFromUrl,
	installWithOverwritePrompt,
	listInstalledSkills,
	loadCatalog,
	parseSha256Fragment,
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
						throw new Error(vscode.l10n.t('Marketplace item not found: {0}', msg.id));
					}
					this.busy(msg.id);
					const name = await installWithOverwritePrompt(o => installFromCatalogItem(this.extensionPath, item, o));
					if (!name) {
						this.pushState();
						return;
					}
					this.pushState(vscode.l10n.t('Installed {0}', name));
					vscode.window.showInformationMessage(vscode.l10n.t('Skill installed: {0}', name));
					return;
				}
				case 'uninstall': {
					this.busy(msg.id);
					uninstallSkill(msg.id);
					this.pushState(vscode.l10n.t('Uninstalled {0}', msg.id));
					return;
				}
				case 'installGithub': {
					// 仓库归档无法预固定哈希：安装前同样要求用户知情
					const githubLabel = vscode.l10n.t('Install Anyway');
					const proceed = await vscode.window.showWarningMessage(
						vscode.l10n.t('GitHub repository archives have no verifiable content hash, so integrity cannot be checked before installation. Continue only if you trust this repository.'),
						{ modal: true },
						githubLabel,
					);
					if (proceed !== githubLabel) {
						this.pushState();
						return;
					}
					this.busy(msg.id);
					const name = await installWithOverwritePrompt(o => installFromUrl(msg.id, o));
					if (!name) {
						this.pushState();
						return;
					}
					this.pushState(vscode.l10n.t('Installed {0} from GitHub', name));
					vscode.window.showInformationMessage(vscode.l10n.t('Skill installed: {0}', name));
					return;
				}
				case 'installFromUrl': {
					const url = await vscode.window.showInputBox({
						prompt: vscode.l10n.t('GitHub repository URL or raw SKILL.md link (append #sha256=<64-char hex> to pin the content hash)'),
						placeHolder: 'https://github.com/owner/repo',
					});
					if (!url) {
						this.pushState();
						return;
					}
					// O1：未固定哈希的来源无法校验完整性，必须由用户明确知情后再安装
					if (!parseSha256Fragment(url.trim())) {
						const proceedLabel = vscode.l10n.t('Install Anyway');
						const proceed = await vscode.window.showWarningMessage(
							vscode.l10n.t('This link has no pinned content hash (#sha256=…), so its integrity cannot be verified before installation. Continue only if you trust this source.'),
							{ modal: true },
							proceedLabel,
						);
						if (proceed !== proceedLabel) {
							this.pushState();
							return;
						}
					}
					this.busy(url);
					const name = await installWithOverwritePrompt(o => installFromUrl(url, o));
					if (!name) {
						this.pushState();
						return;
					}
					this.pushState(vscode.l10n.t('Installed {0}', name));
					vscode.window.showInformationMessage(vscode.l10n.t('Skill installed: {0}', name));
					return;
				}
				case 'importCursor': {
					this.busy('import');
					const count = await importCursorSkills();
					this.pushState(
						count > 0
							? vscode.l10n.t('Imported {0} skill(s) from ~/.cursor/skills', String(count))
							: vscode.l10n.t('~/.cursor/skills not found'),
					);
					return;
				}
				case 'searchGithub': {
					this.view?.webview.postMessage({ type: 'busy', id: 'github' });
					const items = await searchGithubSkillRepos(msg.query);
					this.view?.webview.postMessage({
						type: 'githubResults',
						items,
						status: vscode.l10n.t('GitHub: {0} results', String(items.length)),
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
			vscode.window.showErrorMessage(vscode.l10n.t('Skill Market: {0}', text));
		}
	}

	private busy(id: string): void {
		this.view?.webview.postMessage({ type: 'busy', id });
	}

	/**
	 * `{{l10n:源文案}}` 占位（与 agent-os 的 webviewHtml.ts 保持同一约定）：
	 * 静态 HTML 文案在宿主侧经 l10n.t() 翻译后回填；文案里允许 `{0}`~`{9}` 运行时占位符。
	 */
	private static readonly L10N_PLACEHOLDER_RE = /\{\{l10n:((?:[^{}]|\{\d+\})*)\}\}/g;

	private localizeWebviewText(source: string): string {
		const text = source.trim();
		if (!text) { return ''; }
		try {
			return vscode.l10n.t(text);
		} catch {
			return text;
		}
	}

	/**
	 * webview 脚本侧的动态文案（badge / 按钮 label / 空态 / 状态栏）无法直接调用 l10n.t，
	 * 由宿主侧预先翻译成字典，经 `{{l10nDict}}` 占位注入（`<` 转义防止译文提前闭合 <script>）。
	 */
	private buildWebviewL10nDict(): Record<string, string> {
		return {
			install: vscode.l10n.t('Install'),
			uninstall: vscode.l10n.t('Uninstall'),
			open: vscode.l10n.t('Open'),
			installed: vscode.l10n.t('Installed'),
			installedLocally: vscode.l10n.t('Installed locally'),
			searchSkills: vscode.l10n.t('Search skills…'),
			filterResults: vscode.l10n.t('Filter results…'),
			emptyGithub: vscode.l10n.t('Type keywords to search GitHub, or click "Search".'),
			emptyInstalled: vscode.l10n.t('No skills installed yet.'),
			emptyMarket: vscode.l10n.t('No matching skills.'),
			statusSummary: vscode.l10n.t('{0} official · {1} installed'),
			githubResultsCount: vscode.l10n.t('GitHub: {0} results'),
		};
	}

	private getHtml(webview: vscode.Webview): string {
		const htmlPath = path.join(this.extensionPath, 'resources', 'skill-marketplace.html');
		try {
			const codiconsCssUri = webview.asWebviewUri(
				vscode.Uri.file(path.join(this.extensionPath, 'resources', 'codicons', 'codicon.css')),
			);
			// 每次加载生成新 nonce：脚本只允许 nonce 匹配的内联脚本，不再放行 'unsafe-inline'
			const nonce = crypto.randomBytes(16).toString('base64');
			const l10nDictJson = JSON.stringify(this.buildWebviewL10nDict()).replace(/</g, '\\u003c');
			return fs.readFileSync(htmlPath, 'utf-8')
				.replace(/\{\{cspSource\}\}/g, webview.cspSource)
				.replace(/\{\{nonce\}\}/g, nonce)
				.replace(/\{\{codiconsCssUri\}\}/g, codiconsCssUri.toString())
				.replace(/\{\{htmlLang\}\}/g, vscode.env.language)
				.replace(/\{\{l10nDict\}\}/g, l10nDictJson)
				.replace(SkillMarketplaceViewProvider.L10N_PLACEHOLDER_RE, (_m, source: string) => this.localizeWebviewText(source));
		} catch {
			return `<!DOCTYPE html><html><body style="padding:16px;font-family:sans-serif">
				<p>${vscode.l10n.t('Failed to load Skill Market resources. Please rebuild the kodrix-skills extension.')}</p></body></html>`;
		}
	}
}
