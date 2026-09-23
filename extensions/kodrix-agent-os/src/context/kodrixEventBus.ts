/*---------------------------------------------------------------------------------------------
 *  Kodrix Event Bus — 跨模块实时事件（大厂共享状态思维）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { RouteTarget } from '../router/agentRouter';

export type KodrixEvent =
	| { type: 'context.changed' }
	| { type: 'router.executed'; target: RouteTarget; prompt: string; confidence: string }
	| { type: 'learning.recorded'; id: string; category: string }
	| { type: 'file.focused'; filePath: string; relevantCount: number }
	| { type: 'agent.stateChanged'; data: { previous: string; current: string; sessionId?: string } }
	| { type: 'chat.session.started'; data: { sessionId: string } }
	| { type: 'chat.tool.started'; data: { sessionId: string } }
	| { type: 'chat.session.completed'; data: { sessionId: string } }
	| { type: 'chat.session.error'; data: { sessionId: string } }
	| { type: 'chat.tool.done'; data: { sessionId: string } };

const bus = new vscode.EventEmitter<KodrixEvent>();

/** 订阅 Kodrix 事件（返回 Disposable） */
export const onKodrixEvent = bus.event;

export function emitKodrixEvent(event: KodrixEvent): void {
	bus.fire(event);
}
