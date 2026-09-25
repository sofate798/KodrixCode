/*---------------------------------------------------------------------------------------------
 *  Spec 三栏工作台 — Kiro Spec Editor 风格
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import {
	createSpecFiles,
	getSpecDir,
	launchSpecImplementation,
	listSpecSlugs,
	openSpecFile,
	readSpecBundle,
	slugify,
	SpecFileName,
	SPEC_FILES,
} from './specHelpers';
import { recordLearning } from '../learning/learningEngine';
import { createTrackedPanel } from '../utils/panelTracker';
import { loadWebviewHtml } from '../shared/webviewHtml';

let activePanel: vscode.WebviewPanel | undefined;
let currentSlug: string | undefined;
let specWatcher: vscode.FileSystemWatcher | undefined;

function getHtml(webview: vscode.Webview, extensionPath: string): string {
	return loadWebviewHtml(webview, extensionPath, 'spec-workbench.html');
}

function pushSpecList(panel: vscode.WebviewPanel, selected?: string): void {
	panel.webview.postMessage({
		type: 'specList',
		slugs: listSpecSlugs(),
		selected: selected || currentSlug || '',
	});
}

function pushSpecContent(panel: vscode.WebviewPanel, slug: string): void {
	const bundle = readSpecBundle(slug);
	panel.webview.postMessage({
		type: 'specContent',
		requirements: bundle.requirements,
		design: bundle.design,
		tasks: bundle.tasks,
	});
}

function setupSpecWatcher(panel: vscode.WebviewPanel, _context: vscode.ExtensionContext): void {
	// 复用单一 watcher：切换 Spec 时先销毁旧 watcher，避免监听器在 subscriptions 中累积泄漏。
	// 面板 dispose 时会一并销毁（见 openSpecWorkbench 的 onDidDispose）。
	specWatcher?.dispose();
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder || !currentSlug) {
		return;
	}
	const pattern = new vscode.RelativePattern(folder, `.kodrix/specs/${currentSlug}/**`);
	specWatcher = vscode.workspace.createFileSystemWatcher(pattern);
	const refresh = () => {
		if (currentSlug) {
			pushSpecContent(panel, currentSlug);
		}
	};
	specWatcher.onDidChange(refresh);
	specWatcher.onDidCreate(refresh);
	specWatcher.onDidDelete(refresh);
}

async function createSpecFromWorkbench(): Promise<string | undefined> {
	const feature = await vscode.window.showInputBox({
		prompt: l10n.t('功能名称'),
		placeHolder: 'user-authentication',
	});
	if (!feature) {
		return undefined;
	}
	const description = await vscode.window.showInputBox({
		prompt: l10n.t('简要描述'),
	}) || '（待补充）';
	const specDir = await createSpecFiles(feature, description);
	if (specDir) {
		await recordLearning(`新建 Spec：${feature}（${slugify(feature)}）`, { source: 'spec', category: 'architecture' });
	}
	return specDir;
}

async function handleMessage(
	msg: { command: string; slug?: string; file?: string },
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
): Promise<void> {
	switch (msg.command) {
		case 'ready':
		case 'refresh':
			pushSpecList(panel, currentSlug);
			if (currentSlug) {
				pushSpecContent(panel, currentSlug);
			}
			break;
		case 'selectSpec':
			// 校验 slug 必须是已存在的 Spec，拒绝来自 Webview 的任意路径段
			if (msg.slug && listSpecSlugs().includes(msg.slug)) {
				currentSlug = msg.slug;
				pushSpecContent(panel, currentSlug);
				setupSpecWatcher(panel, context);
			}
			break;
		case 'editFile':
			// 校验 file 必须是受支持的三件套之一，避免任意文件路径
			if (currentSlug && msg.file && (SPEC_FILES as readonly string[]).includes(msg.file)) {
				await openSpecFile(currentSlug, msg.file as SpecFileName);
			}
			break;
		case 'newSpec': {
			const dir = await createSpecFromWorkbench();
			if (dir) {
				currentSlug = path.basename(dir);
				pushSpecList(panel, currentSlug);
				pushSpecContent(panel, currentSlug);
				setupSpecWatcher(panel, context);
			}
			break;
		}
		case 'implement': {
			if (!currentSlug) {
				vscode.window.showWarningMessage(l10n.t('请先选择 Spec'));
				break;
			}
			const dir = getSpecDir(currentSlug);
			if (dir) {
				await launchSpecImplementation(dir);
			}
			break;
		}
	}
}

export function notifySpecUpdated(slug: string): void {
	if (activePanel && currentSlug === slug) {
		pushSpecContent(activePanel, slug);
	}
}

export async function openSpecWorkbench(context: vscode.ExtensionContext, slug?: string): Promise<void> {
	const column = vscode.ViewColumn.Beside;

	if (activePanel) {
		activePanel.reveal(column);
		if (slug) {
			currentSlug = slug;
			pushSpecList(activePanel, slug);
			pushSpecContent(activePanel, slug);
			setupSpecWatcher(activePanel, context);
		}
		return;
	}

	const panel = createTrackedPanel(
		context,
		'kodrix.specWorkbench',
		'Spec Editor',
		column,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'resources'))],
		},
	);

	activePanel = panel;
	currentSlug = slug || listSpecSlugs()[0];
	panel.webview.html = getHtml(panel.webview, context.extensionPath);

	panel.webview.onDidReceiveMessage((m: { command: string; slug?: string; file?: string }) => {
		handleMessage(m, panel, context).catch(err => vscode.window.showErrorMessage(l10n.t('Spec Workbench error: {0}', err instanceof Error ? err.message : String(err))));
	});

	panel.onDidDispose(() => {
		activePanel = undefined;
		currentSlug = undefined;
		specWatcher?.dispose();
		specWatcher = undefined;
	});

	if (currentSlug) {
		setupSpecWatcher(panel, context);
	}
	pushSpecList(panel, currentSlug);
	if (currentSlug) {
		pushSpecContent(panel, currentSlug);
	}
}

export function registerSpecWorkbench(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.spec.openWorkbench', (slug?: string) =>
			openSpecWorkbench(context, slug)),
	);
}
