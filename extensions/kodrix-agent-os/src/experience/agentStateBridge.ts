/*---------------------------------------------------------------------------------------------
 *  Agent State Bridge — 桥接运行时 Agent 状态与 CSS 动画系统
 *
 *  将 Copilot Agent 的实时状态变化（idle → thinking → working → done / error）
 *  同步到 workbench DOM，触发 style-override 中定义的 CSS 动画
 *  （agentStatus.css / brand.css / completion.css）。
 *
 *  同时通过 KodrixEventBus 向状态栏品牌指示器推送状态变化。
 *
 *  大厂工程化标准：
 *   1. 避免 `as any` 类型强制转换，使用结构化类型与运行时守卫
 *   2. 所有延迟参数使用命名常量，而非魔术数字
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { emitKodrixEvent, onKodrixEvent } from '../context/kodrixEventBus';
import { logger } from '../logger';
import { AGENT_DONE_IDLE_DELAY_MS, AGENT_ERROR_IDLE_DELAY_MS } from '../shared/constants';

/**
 * Agent state machine — the canonical set of states the Agent can be in.
 * Matches the CSS class names in `agentStatus.css`.
 */
export type AgentState = 'idle' | 'thinking' | 'working' | 'done' | 'error';

/**
 * Current global agent state. External modules can read this to coordinate
 * UI updates (status bar, hub, notifications).
 */
let currentAgentState: AgentState = 'idle';

/** Active session ID being tracked, if any. */
let activeSessionId: string | undefined;

/** Cleanup handles for agent state timeouts */
const _stateTimers = new Set<ReturnType<typeof setTimeout>>();

function pushTimer(fn: () => void, ms: number): void {
	let handle: ReturnType<typeof setTimeout>;
	handle = setTimeout(() => {
		_stateTimers.delete(handle);
		fn();
	}, ms);
	_stateTimers.add(handle);
}

function clearAllStateTimers(): void {
	for (const t of _stateTimers) {
		clearTimeout(t);
	}
	_stateTimers.clear();
}

/**
 * DOM class toggling helper — adds/removes `.style-override.status-*` classes
 * on the workbench root so the CSS modules can react without polling.
 * 
 * SAFE: Guards against non-browser environments (tests, server-side, headless).
 */
interface MinimalDomTokenList {
	add(token: string): void;
	remove(token: string): void;
	[Symbol.iterator](): IterableIterator<string>;
}
interface MinimalElement {
	classList: MinimalDomTokenList;
}
interface MinimalDocument {
	querySelector(selector: string): MinimalElement | null;
}

function setWorkbenchAgentClass(state: AgentState): void {
	try {
		// DOM is only available in the renderer process; tsconfig excludes the DOM lib,
		// so we use a minimal structural type and access via globalThis.
		const doc = (globalThis as { document?: MinimalDocument }).document;
		if (!doc) return; // server-side / headless — skip DOM manipulation
		const workbench = doc.querySelector('.monaco-workbench');
		if (!workbench) return;

		// Remove all existing agent-state classes first
		for (const c of [...workbench.classList]) {
			if (c.startsWith('agent-state-')) {
				workbench.classList.remove(c);
			}
		}

		workbench.classList.add(`agent-state-${state}`);
	} catch {
		// DOM unavailable (non-browser env) — this is expected
	}
}

/**
 * Transition the global agent state and notify all listeners.
 */
export function setAgentState(state: AgentState, sessionId?: string): void {
	// Defend against stale updates — ignore idle transitions
	// from a session that is no longer active.
	if (state === 'idle' && sessionId && sessionId !== activeSessionId) {
		return;
	}

	const previous = currentAgentState;
	currentAgentState = state;
	if (sessionId) {
		activeSessionId = sessionId;
	}

	setWorkbenchAgentClass(state);

	// Notify the event bus so the status bar brand indicator
	// and the Kodrix Hub can react in real time.
	emitKodrixEvent({
		type: 'agent.stateChanged',
		data: { previous, current: state, sessionId },
	});

	logger.info(`[AgentBridge] State: ${previous} → ${state}`
		+ (sessionId ? ` (session: ${sessionId.slice(0, 8)}…)` : ''));
}

/**
 * Get the current agent state. Safe to call from any module.
 */
export function getAgentState(): AgentState {
	return currentAgentState;
}

/**
 * Dispose all state transition timers. Call on extension deactivate.
 */
export function disposeAgentStateTimers(): void {
	clearAllStateTimers();
}

/**
 * Structured interface for the chat API subset we use.
 * Avoids `as any` while maintaining compatibility across VS Code versions.
 */
interface ChatSessionEvent {
	sessionId?: string;
}

interface ChatPerformApi {
	onDidPerformChatRequest?: vscode.Event<ChatSessionEvent>;
	onDidChangeSessionState?: vscode.Event<ChatStateChangeEvent>;
}

/**
 * Register listeners on Copilot chat events to drive the state machine.
 */
export function registerAgentStateListener(context: vscode.ExtensionContext): void {
	// ── Request sent → Agent starts thinking ──
	const chatPerformApi = vscode.chat as unknown as ChatPerformApi;
	const chatPerformListener = chatPerformApi.onDidPerformChatRequest
		? chatPerformApi.onDidPerformChatRequest((e: ChatSessionEvent) => {
			if (e.sessionId) {
				setAgentState('thinking', e.sessionId);
			}
		})
		: undefined;
	if (chatPerformListener) {
		context.subscriptions.push(chatPerformListener);
	}

	// ── Response received → Agent moves to "working" (tool use) ──
	const chatStateListener = onDidChangeChatState(detail => {
		if (detail?.state === 'streaming' || detail?.state === 'executing') {
			setAgentState('working', detail.sessionId);
		}
	});
	if (chatStateListener) {
		context.subscriptions.push(chatStateListener);
	}

	// ── Tool invocation start/end → refine working state ──
	subscribeToKodrixEvents(context);
}

/**
 * Internal subscription to KodrixEventBus for fine-grained state transitions.
 */
function subscribeToKodrixEvents(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		onKodrixEvent((e) => {
			switch (e.type) {
				case 'chat.session.started':
					setAgentState('thinking', e.data.sessionId);
					break;

				case 'chat.tool.started':
					setAgentState('working', e.data.sessionId);
					break;

				case 'chat.session.completed':
					setAgentState('done', e.data.sessionId);
					pushTimer(() => {
						if (currentAgentState === 'done' && activeSessionId === e.data.sessionId) {
							setAgentState('idle');
						}
					}, AGENT_DONE_IDLE_DELAY_MS);
					break;

				case 'chat.session.error':
					setAgentState('error', e.data.sessionId);
					pushTimer(() => {
						if (currentAgentState === 'error' && activeSessionId === e.data.sessionId) {
							setAgentState('idle');
						}
					}, AGENT_ERROR_IDLE_DELAY_MS);
					break;

			case 'chat.tool.done':
				break;
			default:
				logger.debug(`[AgentBridge] Unknown event type: ${e.type}`);
		}
	}),
	);
}

// ── Fallback for VS Code versions where `vscode.chat.onDidPerformChatRequest`
//    is not yet available (proposed API). ──

interface ChatStateChangeEvent {
	state: 'idle' | 'streaming' | 'executing';
	sessionId?: string;
}

function onDidChangeChatState(
	_handler: (e: ChatStateChangeEvent) => void,
): vscode.Disposable | undefined {
	try {
		const api = vscode.chat as unknown as { onDidChangeSessionState?: vscode.Event<any> };
		if (typeof api.onDidChangeSessionState === 'function') {
			return api.onDidChangeSessionState((e: any) => {
				_handler({ state: e?.state ?? 'idle', sessionId: e?.sessionId });
			});
		}
	} catch {
		// Proposed API not available — the polling-based approach in
		// contextEvents.ts already handles state tracking.
	}
	return new vscode.Disposable(() => {});
}
