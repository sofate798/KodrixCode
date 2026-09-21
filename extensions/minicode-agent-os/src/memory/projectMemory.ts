/*---------------------------------------------------------------------------------------------
 *  跨会话 Memory — Windsurf Memories 风格
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { registerInstructionFolders } from '../context/instructionRegistry';
import { notifyContextChanged } from '../context/contextEvents';
import { recordLearning, syncProjectInstructionsFile } from '../learning/learningEngine';
import { persistMemoryAppend, readMemoryContent, ensureMemoryFile } from './memoryHelpers';
import { ensureDir, getMemoryPath, getMinicodeDir } from '../paths';

/** 跨平台路径规范化：Windows 大小写不敏感，统一小写比较 */
function normalizePathForCompare(p: string): string {
	const forward = p.replace(/\\/g, '/');
	return process.platform === 'win32' ? forward.toLowerCase() : forward;
}

export function appendMemoryEntry(text: string): void {
	persistMemoryAppend(text);
	syncProjectInstructionsFile();
	notifyContextChanged();
}

export async function showMemory(): Promise<void> {
	const memPath = ensureMemoryFile();
	const doc = await vscode.workspace.openTextDocument(memPath);
	await vscode.window.showTextDocument(doc);
}

export async function captureMemoryFromSelection(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	const selection = editor?.document.getText(editor.selection);
	const input = selection || await vscode.window.showInputBox({
		prompt: '输入要记住的项目知识（架构、约定、陷阱等）',
		placeHolder: '此项目使用 pnpm，测试框架为 vitest',
	});
	if (!input?.trim()) {
		return;
	}

	appendMemoryEntry(input.trim());
	if (vscode.workspace.getConfiguration('minicode.features').get<boolean>('learning', true)) {
		// 不强制 category，交由 recordLearning 按内容推断（inferLearningCategory）
		recordLearning(input.trim(), { source: 'capture' });
	}
	vscode.window.showInformationMessage('已写入项目 Memory 并同步到 Agent 上下文');
}

export async function injectMemoryIntoInstructions(): Promise<void> {
	const enabled = vscode.workspace.getConfiguration('minicode.features').get<boolean>('memory', true);
	if (!enabled) {
		return;
	}

	syncProjectInstructionsFile();
	await registerInstructionFolders();
}

export function registerMemory(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('minicode.memory.show', () => showMemory()),
		vscode.commands.registerCommand('minicode.memory.capture', () => captureMemoryFromSelection()),
	);

	const memoryEnabled = vscode.workspace.getConfiguration('minicode.features').get<boolean>('memory', true);
	if (memoryEnabled) {
		const memPathNorm = normalizePathForCompare(getMemoryPath());
		context.subscriptions.push(
			vscode.workspace.onDidSaveTextDocument(doc => {
				if (normalizePathForCompare(doc.uri.fsPath) === memPathNorm) {
					syncProjectInstructionsFile();
					notifyContextChanged();
				}
			}),
		);
		ensureDir(path.join(getMinicodeDir(), 'memory'));
		const injectTimer = setTimeout(() => {
			void injectMemoryIntoInstructions();
		}, 3000);
		context.subscriptions.push({ dispose: () => clearTimeout(injectTimer) });
	}
}

export function getMemoryContext(): string {
	try {
		return readMemoryContent().slice(0, 2000);
	} catch {
		return '';
	}
}
