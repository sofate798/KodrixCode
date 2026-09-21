/*---------------------------------------------------------------------------------------------
 *  SOLO 构建后自动预览 — Trae Simple Browser 风格
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { defaultPreviewUrl } from './constants';
import { loadTemplates, detectTemplate as detectTemplateFromText } from './soloTemplates';

// 追踪所有延迟预览计时器，扩展停用时统一清理，避免孤立回调
const _previewTimers = new Set<ReturnType<typeof setTimeout>>();

function trackedTimeout(fn: () => void, ms: number): void {
	let handle: ReturnType<typeof setTimeout>;
	handle = setTimeout(() => {
		_previewTimers.delete(handle);
		fn();
	}, ms);
	_previewTimers.add(handle);
}

export function disposeSoloPreviewTimers(): void {
	for (const t of _previewTimers) {
		clearTimeout(t);
	}
	_previewTimers.clear();
}

async function openPreviewUrl(url: string): Promise<void> {
	const commands = await vscode.commands.getCommands(true);
	if (commands.includes('simpleBrowser.show')) {
		await vscode.commands.executeCommand('simpleBrowser.show', url);
		return;
	}
	if (commands.includes('simpleBrowser.api.open')) {
		await vscode.commands.executeCommand('simpleBrowser.api.open', url);
		return;
	}
	if (commands.includes('workbench.action.browser.open')) {
		await vscode.commands.executeCommand('workbench.action.browser.open', url);
		return;
	}
	await vscode.env.openExternal(vscode.Uri.parse(url));
}

export async function scheduleSoloPreview(extensionPath: string, buildPrompt: string): Promise<void> {
	const autoPreview = vscode.workspace.getConfiguration('minicode.solo').get<boolean>('autoPreview', true);
	if (!autoPreview) {
		return;
	}

	const templates = loadTemplates(extensionPath);
	const template = detectTemplateFromText(buildPrompt, templates);
	if (!template?.run_port) {
		return;
	}

	const url = defaultPreviewUrl(template.run_port);

	vscode.window.showInformationMessage(
		`SOLO 构建已启动。预览地址：${url}（需先运行 dev server，如 \`${template.run_command || 'npm run dev'}\`）`,
		'打开预览', '5 秒后打开',
	).then(async choice => {
		if (choice === '打开预览') {
			await openPreviewUrl(url);
		} else if (choice === '5 秒后打开') {
			trackedTimeout(() => void openPreviewUrl(url), 5000);
		}
	});

	// 延迟自动打开（用户未点击时，30 秒后尝试一次）
	trackedTimeout(() => {
		void vscode.window.showInformationMessage(`SOLO 预览就绪：${url}`, '打开预览').then(c => {
			if (c === '打开预览') {
				void openPreviewUrl(url);
			}
		});
	}, 30000);
}

export async function openSoloPreview(extensionPath: string): Promise<void> {
	const templates = loadTemplates(extensionPath);
	const picked = await vscode.window.showQuickPick(
		templates.filter(t => t.run_port).map(t => ({
			label: t.id,
			description: defaultPreviewUrl(t.run_port!),
			port: t.run_port!,
		})),
		{ placeHolder: '选择预览端口' },
	);
	if (picked) {
		await openPreviewUrl(defaultPreviewUrl(picked.port));
	}
}
