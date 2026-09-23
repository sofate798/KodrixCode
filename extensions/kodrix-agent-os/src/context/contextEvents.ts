/*---------------------------------------------------------------------------------------------
 *  Context change events — 避免 learning ↔ context 循环依赖
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const CONTEXT_CHANGE_EVENT = new vscode.EventEmitter<void>();

/** 订阅上下文变更（返回 Disposable，可直接 push 到 subscriptions） */
export const onContextChanged = CONTEXT_CHANGE_EVENT.event;

export function notifyContextChanged(): void {
	CONTEXT_CHANGE_EVENT.fire();
}
