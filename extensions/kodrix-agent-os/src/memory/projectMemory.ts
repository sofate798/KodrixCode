/*---------------------------------------------------------------------------------------------
 *  跨会话 Memory — Windsurf Memories 风格
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { registerInstructionFolders } from '../context/instructionRegistry';
import { notifyContextChanged } from '../context/contextEvents';
import { recordLearning, syncProjectInstructionsFile } from '../learning/learningEngine';
import { persistMemoryAppend, ensureMemoryFile } from './memoryHelpers';
import { ensureDir, getMemoryPath, getKodrixDir } from '../paths';

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
		prompt: l10n.t('Enter project knowledge to remember (architecture, conventions, pitfalls, etc.)'),
		placeHolder: l10n.t('This project uses pnpm; the test framework is vitest'),
	});
	if (!input?.trim()) {
		return;
	}

	appendMemoryEntry(input.trim());
	if (vscode.workspace.getConfiguration('kodrix.features').get<boolean>('learning', true)) {
		// 不强制 category，交由 recordLearning 按内容推断（inferLearningCategory）
		recordLearning(input.trim(), { source: 'capture' });
	}
	vscode.window.showInformationMessage(l10n.t('Written to Project Memory and synced to the Agent context'));
}

export async function injectMemoryIntoInstructions(): Promise<void> {
	const enabled = vscode.workspace.getConfiguration('kodrix.features').get<boolean>('memory', true);
	if (!enabled) {
		return;
	}

	syncProjectInstructionsFile();
	await registerInstructionFolders();
}

export function registerMemory(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.memory.show', () => showMemory()),
		vscode.commands.registerCommand('kodrix.memory.capture', () => captureMemoryFromSelection()),
	);

	const memoryEnabled = vscode.workspace.getConfiguration('kodrix.features').get<boolean>('memory', true);
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
		ensureDir(path.join(getKodrixDir(), 'memory'));
		const injectTimer = setTimeout(() => {
			void injectMemoryIntoInstructions();
		}, 3000);
		context.subscriptions.push({ dispose: () => clearTimeout(injectTimer) });
	}
}
