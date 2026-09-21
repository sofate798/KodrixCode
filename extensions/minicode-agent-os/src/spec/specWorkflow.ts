/*---------------------------------------------------------------------------------------------
 *  Spec 工作流 — Kiro Spec 驱动 + Qoder Spec-driven
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { recordLearning } from '../learning/learningEngine';
import {
	createSpecFiles,
	getSpecDir,
	launchSpecImplementation,
	pickSpecSlug,
	slugify,
} from './specHelpers';

export async function createSpec(openWorkbench = false): Promise<string | undefined> {
	const feature = await vscode.window.showInputBox({
		prompt: '功能名称（将创建 Spec 三件套）',
		placeHolder: 'user-authentication',
	});
	if (!feature) {
		return undefined;
	}

	const description = await vscode.window.showInputBox({
		prompt: '简要描述需求',
		placeHolder: '实现用户登录、注册与会话管理',
	}) || '（待补充）';

	const specDir = await createSpecFiles(feature, description);
	if (!specDir) {
		return undefined;
	}

	const slug = slugify(feature);
	recordLearning(`新建 Spec：${feature}（${slug}）`, { source: 'spec', category: 'architecture' });

	if (openWorkbench) {
		await vscode.commands.executeCommand('minicode.spec.openWorkbench', slug);
	} else {
		const reqDoc = await vscode.workspace.openTextDocument(path.join(specDir, 'requirements.md'));
		await vscode.window.showTextDocument(reqDoc);
		void vscode.window.showInformationMessage(
			`Spec 已创建：.minicode/specs/${slug}/`,
			'打开三栏工作台', '实施任务',
		).then(choice => {
			if (choice === '打开三栏工作台') {
				void vscode.commands.executeCommand('minicode.spec.openWorkbench', slug);
			} else if (choice === '实施任务') {
				void implementSpec(specDir);
			}
		}, () => { /* 用户关闭提示，忽略 */ });
	}

	return specDir;
}

export async function openSpec(): Promise<void> {
	const slug = await pickSpecSlug();
	if (!slug) {
		return;
	}
	await vscode.commands.executeCommand('minicode.spec.openWorkbench', slug);
}

export async function implementSpec(specDir?: string): Promise<void> {
	let dir = specDir;
	if (!dir) {
		const slug = await pickSpecSlug('选择要实施的 Spec');
		if (!slug) {
			return;
		}
		dir = getSpecDir(slug);
	}
	if (!dir) {
		return;
	}
	await launchSpecImplementation(dir);
}

export function registerSpec(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('minicode.spec.create', () => createSpec(false)),
		vscode.commands.registerCommand('minicode.spec.open', () => openSpec()),
		vscode.commands.registerCommand('minicode.spec.implement', () => implementSpec()),
	);
}
