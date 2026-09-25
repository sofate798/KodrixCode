"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.setAgentState = setAgentState;
exports.getAgentState = getAgentState;
exports.disposeAgentStateTimers = disposeAgentStateTimers;
exports.registerAgentStateListener = registerAgentStateListener;
const vscode = __importStar(require("vscode"));
const kodrixEventBus_1 = require("../context/kodrixEventBus");
const logger_1 = require("../logger");
const constants_1 = require("../shared/constants");
/**
 * Current global agent state. External modules can read this to coordinate
 * UI updates (status bar, hub, notifications).
 */
let currentAgentState = 'idle';
/** Active session ID being tracked, if any. */
let activeSessionId;
/** Cleanup handles for agent state timeouts */
const _stateTimers = new Set();
function pushTimer(fn, ms) {
    let handle;
    handle = setTimeout(() => {
        _stateTimers.delete(handle);
        fn();
    }, ms);
    _stateTimers.add(handle);
}
function clearAllStateTimers() {
    for (const t of _stateTimers) {
        clearTimeout(t);
    }
    _stateTimers.clear();
}
function setWorkbenchAgentClass(state) {
    try {
        // DOM is only available in the renderer process; tsconfig excludes the DOM lib,
        // so we use a minimal structural type and access via globalThis.
        const doc = globalThis.document;
        if (!doc)
            return; // server-side / headless — skip DOM manipulation
        const workbench = doc.querySelector('.monaco-workbench');
        if (!workbench)
            return;
        // Remove all existing agent-state classes first
        for (const c of [...workbench.classList]) {
            if (c.startsWith('agent-state-')) {
                workbench.classList.remove(c);
            }
        }
        workbench.classList.add(`agent-state-${state}`);
    }
    catch {
        // DOM unavailable (non-browser env) — this is expected
    }
}
/**
 * Transition the global agent state and notify all listeners.
 */
function setAgentState(state, sessionId) {
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
    (0, kodrixEventBus_1.emitKodrixEvent)({
        type: 'agent.stateChanged',
        data: { previous, current: state, sessionId },
    });
    logger_1.logger.info(`[AgentBridge] State: ${previous} → ${state}`
        + (sessionId ? ` (session: ${sessionId.slice(0, 8)}…)` : ''));
}
/**
 * Get the current agent state. Safe to call from any module.
 */
function getAgentState() {
    return currentAgentState;
}
/**
 * Dispose all state transition timers. Call on extension deactivate.
 */
function disposeAgentStateTimers() {
    clearAllStateTimers();
}
/**
 * Register listeners on Copilot chat events to drive the state machine.
 */
function registerAgentStateListener(context) {
    // ── Request sent → Agent starts thinking ──
    const chatPerformApi = vscode.chat;
    const chatPerformListener = chatPerformApi.onDidPerformChatRequest
        ? chatPerformApi.onDidPerformChatRequest((e) => {
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
function subscribeToKodrixEvents(context) {
    context.subscriptions.push((0, kodrixEventBus_1.onKodrixEvent)((e) => {
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
                }, constants_1.AGENT_DONE_IDLE_DELAY_MS);
                break;
            case 'chat.session.error':
                setAgentState('error', e.data.sessionId);
                pushTimer(() => {
                    if (currentAgentState === 'error' && activeSessionId === e.data.sessionId) {
                        setAgentState('idle');
                    }
                }, constants_1.AGENT_ERROR_IDLE_DELAY_MS);
                break;
            case 'chat.tool.done':
                break;
            default:
                logger_1.logger.debug(`[AgentBridge] Unknown event type: ${e.type}`);
        }
    }));
}
function onDidChangeChatState(_handler) {
    try {
        const api = vscode.chat;
        if (typeof api.onDidChangeSessionState === 'function') {
            return api.onDidChangeSessionState((e) => {
                _handler({ state: e?.state ?? 'idle', sessionId: e?.sessionId });
            });
        }
    }
    catch {
        // Proposed API not available — the polling-based approach in
        // contextEvents.ts already handles state tracking.
    }
    return new vscode.Disposable(() => { });
}
