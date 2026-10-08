"use strict";
/*---------------------------------------------------------------------------------------------
 *  Vibe Coding 3.0 — 想法驱动的开发入口（超越 Windsurf Cascade + Lovable + Bolt.new）
 *
 *  大厂参考：Windsurf Cascade · Lovable "vibe to app" · Bolt.new · v0 · Claude Code
 *  核心升级：复杂想法自动路由到 Idea Flow（全自动流水线），简单需求走快捷路径
 *
 *  让软件开发回归想法本身 — 用户只需描述「做什么」，AI 负责「怎么做」
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
exports.vibeCode = vibeCode;
exports.quickVibe = quickVibe;
exports.registerVibeCoding = registerVibeCoding;
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const agentRouter_1 = require("../router/agentRouter");
const vibeIteration_1 = require("./vibeIteration");
/**
 * Vibe Coding 3.0 入口：智能判断使用快捷路径还是完整 Idea Flow
 *
 * 路由逻辑：
 * - 复杂 / 模糊 / 多功能的描述 → Idea Flow（全自动分析→规划→构建→预览）
 * - 简单 / 明确的需求 → Spec / Agent 快捷路径
 */
async function vibeCode(prompt) {
    const enabled = vscode.workspace.getConfiguration('kodrix.features').get('vibeCoding', true);
    if (!enabled) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('Vibe Coding is off. Enable kodrix.features.vibeCoding in settings'));
        return;
    }
    const input = prompt || await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('Describe the app you want, and AI builds it fully automatically — complex ideas go through Idea Flow, simple needs take the fast path'),
        placeHolder: vscode_1.l10n.t('A personal blog with dark mode and Markdown / an AI knowledge management tool / a Trello board'),
        ignoreFocusOut: true,
    });
    if (!input?.trim()) {
        return;
    }
    // Check if Idea Flow should be used (complex/multi-feature descriptions)
    const shouldUseIdeaFlow = shouldUseFullPipeline(input);
    if (shouldUseIdeaFlow && vscode.workspace.getConfiguration('kodrix.features').get('ideaFlow', true)) {
        // Route to full Idea Flow pipeline — pass prompt directly to avoid double-input
        await vscode.commands.executeCommand('kodrix.idea.start', input);
        vscode.window.showInformationMessage(vscode_1.l10n.t('Vibe Coding detected complex project requirements and switched to the fully automated Idea Flow pipeline'));
        return;
    }
    const route = (0, agentRouter_1.classifyIntent)(input);
    // Build vibe context
    const vibeContext = `[Vibe Coding Mode — 让想法回归本质]
你正处于 Vibe Coding 模式 — 用户通过自然语言描述了想要的应用。
核心理念：软件开发回归想法本身。用户只需描述「做什么」，你来负责「怎么做」。

原则：
- 快速原型优先，先做出能跑的 MVP
- 保持技术栈简洁（React/Vite 或 Vue/Vite 作为默认前端）
- 使用现代 UI（Tailwind CSS 或 shadcn/ui 风格）
- 包含基础交互和美观的设计
- 生成完整的、可直接运行的项目

用户需求：${input}`;
    if (route.target === 'spec') {
        await vscode.commands.executeCommand('kodrix.spec.create');
        vscode.window.showInformationMessage(vscode_1.l10n.t('Vibe Coding → define requirements in the Spec, then implement'));
    }
    else {
        await runAgentWithIterationLoop(input, vibeContext);
    }
}
/**
 * 判断是否应该使用完整的 Idea Flow 流水线
 * 复杂/模糊/多功能描述走完整流水线，简单的走快捷路径
 */
function shouldUseFullPipeline(input) {
    const lower = input.toLowerCase();
    // 复杂度指标：功能数量、描述长度、专用关键词
    const featureCount = countFeatures(lower);
    const isLongDescription = input.length > 60;
    const hasComplexKeywords = /系统|platform|管理|engine|full|complete|复杂|集成|enterprise|微服务|microservice|多用户|multi/i.test(lower);
    // 走完整流水线的条件
    if (featureCount >= 3 && isLongDescription) {
        return true;
    }
    if (hasComplexKeywords && isLongDescription) {
        return true;
    }
    if (featureCount >= 4) {
        return true;
    }
    if (input.length > 120) {
        return true;
    }
    return false;
}
/**
 * Agent 模式 + Checkpoint 迭代循环。
 *
 * 流程：
 *   1. 开启迭代会话 → 创建初始 Checkpoint → 发送 prompt 到 Agent
 *   2. Agent 完成后展示 QuickPick：继续迭代 / 回退 / 完成
 *   3. 循环直到用户选择「完成」或取消
 */
async function runAgentWithIterationLoop(originalInput, initialContext) {
    const sessionId = (0, vibeIteration_1.startIterationSession)(originalInput);
    // 初始 Checkpoint（Agent 执行前快照）
    await (0, vibeIteration_1.recordIteration)(sessionId, vscode_1.l10n.t('Initial version'));
    // 首次发送到 Agent
    await vscode.commands.executeCommand('workbench.action.chat.open', {
        mode: 'agent',
        query: initialContext,
        isPartialQuery: false,
    });
    vscode.window.showInformationMessage(vscode_1.l10n.t('Vibe Coding → Agent mode ready'));
    // 迭代循环
    let iterating = true;
    while (iterating) {
        const action = await vscode.window.showQuickPick([
            { label: '$(edit) ' + vscode_1.l10n.t('Continue Iterating'), description: vscode_1.l10n.t('Provide feedback to continue revising'), value: 'continue' },
            { label: '$(history) ' + vscode_1.l10n.t('Revert to Previous Version'), description: vscode_1.l10n.t('Restore to Previous Checkpoint'), value: 'rollback' },
            { label: '$(check) ' + vscode_1.l10n.t('Done'), description: vscode_1.l10n.t('Satisfied with the results; end the iteration'), value: 'done' },
        ], { placeHolder: vscode_1.l10n.t('Vibe Coding iteration'), ignoreFocusOut: true });
        if (!action) {
            // 用户按 Esc 取消 → 视为完成
            iterating = false;
            break;
        }
        const value = action.value;
        if (value === 'continue') {
            const feedback = await vscode.window.showInputBox({
                prompt: vscode_1.l10n.t('Describe what you want to change'),
                placeHolder: vscode_1.l10n.t('e.g., change the navbar to a sidebar / add a search box'),
                ignoreFocusOut: true,
            });
            if (!feedback?.trim()) {
                continue;
            }
            // 记录迭代（自动创建 Checkpoint）
            await (0, vibeIteration_1.recordIteration)(sessionId, feedback, feedback);
            // 构建迭代上下文并发送到 Agent
            const iterContext = `[Vibe Coding 迭代 #${(0, vibeIteration_1.getIterationCount)(sessionId)}]
原始需求：${originalInput}
本轮反馈：${feedback}

请根据反馈继续修改，保持已有功能不被破坏。`;
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                mode: 'agent',
                query: iterContext,
                isPartialQuery: false,
            });
        }
        else if (value === 'rollback') {
            const count = (0, vibeIteration_1.getIterationCount)(sessionId);
            if (count <= 1) {
                vscode.window.showInformationMessage(vscode_1.l10n.t('Only the initial version exists; cannot roll back'));
                continue;
            }
            const summary = (0, vibeIteration_1.getIterationSummary)(sessionId);
            const target = await vscode.window.showQuickPick(Array.from({ length: count }, (_, i) => {
                const num = count - i; // 从新到旧
                return {
                    label: `#${num}`,
                    description: num === 1 ? vscode_1.l10n.t('Initial version') : vscode_1.l10n.t('Iteration #{0}', num),
                    value: num,
                };
            }), {
                placeHolder: vscode_1.l10n.t('Select the version to roll back to'),
                title: vscode_1.l10n.t('Iteration history\n{0}', summary ?? ''),
            });
            if (!target) {
                continue;
            }
            const targetNum = target.value;
            const ok = await (0, vibeIteration_1.rollbackToIteration)(sessionId, targetNum);
            if (ok) {
                vscode.window.showInformationMessage(vscode_1.l10n.t('Rolled back to iteration #{0}', targetNum));
            }
            else {
                vscode.window.showErrorMessage(vscode_1.l10n.t('Revert failed, please check checkpoint integrity'));
            }
        }
        else {
            // done
            iterating = false;
        }
    }
    const totalIterations = (0, vibeIteration_1.getIterationCount)(sessionId);
    (0, vibeIteration_1.endIterationSession)(sessionId);
    vscode.window.showInformationMessage(vscode_1.l10n.t('Vibe Coding session ended, {0} iterations in total', totalIterations));
}
function countFeatures(text) {
    const indicators = [/支持|support|with|and/, /功能|feature|ability/, /可以|able to|allow/, /管理|manage|track/, /创建|create|generate/];
    let count = 0;
    for (const re of indicators) {
        const matches = text.match(re);
        if (matches) {
            count += matches.length;
        }
    }
    return Math.ceil(count / 2);
}
/**
 * 快捷 Vibe：直接在状态栏 / Hub 中一键启动
 */
async function quickVibe() {
    const lastPrompt = await vscode.window.showQuickPick([
        { label: vscode_1.l10n.t('Personal website/blog'), description: 'React + Vite + Tailwind', prompt: vscode_1.l10n.t('A personal blog site with dark mode, supporting Markdown posts') },
        { label: vscode_1.l10n.t('Task board'), description: vscode_1.l10n.t('React + DnD + drag-and-drop'), prompt: vscode_1.l10n.t('A Trello-style task board with drag-and-drop and status switching') },
        { label: vscode_1.l10n.t('AI chat interface'), description: vscode_1.l10n.t('React + streaming responses'), prompt: vscode_1.l10n.t('A ChatGPT-style AI chat interface with streaming output and session management') },
        { label: vscode_1.l10n.t('E-commerce product page'), description: vscode_1.l10n.t('React + shopping cart'), prompt: vscode_1.l10n.t('A polished e-commerce product page with shopping cart and search filters') },
        { label: vscode_1.l10n.t('Data dashboard'), description: 'React + Recharts', prompt: vscode_1.l10n.t('A data analytics dashboard with line charts, pie charts, and stat cards') },
        { label: '$(edit) ' + vscode_1.l10n.t('Custom...'), description: vscode_1.l10n.t('Enter your own description'), prompt: '' },
    ], { placeHolder: vscode_1.l10n.t('Choose a Vibe template, or enter a custom description…') });
    if (!lastPrompt) {
        return;
    }
    if (lastPrompt.prompt) {
        await vibeCode(lastPrompt.prompt);
    }
    else {
        await vibeCode();
    }
}
function registerVibeCoding(context) {
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.vibe.start', () => vibeCode()), vscode.commands.registerCommand('kodrix.vibe.quick', () => quickVibe()));
}
