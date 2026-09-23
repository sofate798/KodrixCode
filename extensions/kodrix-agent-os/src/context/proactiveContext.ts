/*---------------------------------------------------------------------------------------------
 *  Proactive Context — 打开文件时主动提示相关 Memory / Learning（对标 Cursor 隐式上下文）
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { emitKodrixEvent } from './kodrixEventBus';
import { searchSimilar } from '../learning/semanticMemory';

export interface FileContextHint {
	filePath: string;
	fileName: string;
	relevantCount: number;
	topMatch?: string;
	topScore?: number;
}

let lastHint: FileContextHint | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function buildFileQuery(filePath: string): string {
	const base = path.basename(filePath, path.extname(filePath));
	const dir = path.basename(path.dirname(filePath));
	const segments = filePath.replace(/\\/g, '/').split('/').slice(-3);
	return [base, dir, ...segments].join(' ');
}

export function analyzeFileContext(filePath: string): FileContextHint {
	const fileName = path.basename(filePath);
	const query = buildFileQuery(filePath);
	const results = searchSimilar(query, 3);

	return {
		filePath,
		fileName,
		relevantCount: results.length,
		topMatch: results[0]?.entry.content.slice(0, 80),
		topScore: results[0]?.score,
	};
}

export function getLastFileContextHint(): FileContextHint | undefined {
	return lastHint;
}

function handleActiveEditor(editor: vscode.TextEditor | undefined): void {
	const enabled = vscode.workspace.getConfiguration('kodrix.features').get<boolean>('proactiveContext', true);
	if (!enabled || !editor?.document.uri.fsPath) {
		lastHint = undefined;
		return;
	}

	const filePath = editor.document.uri.fsPath;
	if (editor.document.uri.scheme !== 'file') {
		return;
	}

	if (debounceTimer) {
		clearTimeout(debounceTimer);
	}
	debounceTimer = setTimeout(() => {
		const hint = analyzeFileContext(filePath);
		lastHint = hint.relevantCount > 0 && (hint.topScore ?? 0) > 0.08 ? hint : undefined;
		emitKodrixEvent({
			type: 'file.focused',
			filePath,
			relevantCount: hint.relevantCount,
		});
	}, 300);
}

export function registerProactiveContext(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(handleActiveEditor),
	);

	if (vscode.window.activeTextEditor) {
		handleActiveEditor(vscode.window.activeTextEditor);
	}
}
