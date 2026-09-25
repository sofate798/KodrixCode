"use strict";
/*---------------------------------------------------------------------------------------------
 *  Tab Completion — 专用 Tab 补全模型通道（对标 Cursor 的 Tab 快速补全）
 *
 *  设计：
 *    1. 默认关闭（kodrix.tabCompletion.enabled = false），避免与上游 Copilot 内联补全冲突；
 *       用户开启后由 Kodrix 提供 InlineCompletion。
 *    2. 双通道：mode=fim → 专用 FIM 端点（默认 DeepSeek FIM，填 Key 即用；可选自定义端点）；
 *       mode=fast → 通用模型通道（走模型路由 fast 档）。FIM 失败自动降级 fast。
 *    3. buildCompletionPrompt / buildFimPrompt / extractCompletion 为纯函数，便于单元测试。
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
exports.buildCompletionPrompt = buildCompletionPrompt;
exports.buildFimPrompt = buildFimPrompt;
exports.extractCompletion = extractCompletion;
exports.provideFimCompletion = provideFimCompletion;
exports.provideTabCompletion = provideTabCompletion;
exports.registerTabCompletion = registerTabCompletion;
const vscode = __importStar(require("vscode"));
const modelRouter_1 = require("../model/modelRouter");
const tabCompletionStats_1 = require("./tabCompletionStats");
const logger_1 = require("../logger");
const constants_1 = require("../shared/constants");
/** 组装补全请求 prompt（纯函数，fast 通道） */
function buildCompletionPrompt(ctx, contextLines = constants_1.TAB_COMPLETION_CONTEXT_LINES) {
    const prefixTail = ctx.prefix.split('\n').slice(-contextLines).join('\n');
    const suffixHead = ctx.suffix.split('\n').slice(0, 2).join('\n');
    return [
        '你是 Kodrix Tab 补全引擎（快速模型通道，对标 Cursor Tab）。',
        '根据下方代码上下文，补全光标 <CURSOR> 处的代码。',
        '要求：只输出新增内容，不要重复已存在的代码；不要输出解释；保持语言与风格一致。',
        '```' + ctx.language,
        prefixTail,
        '<CURSOR>',
        suffixHead,
        '```',
        '补全内容：',
    ].join('\n');
}
/** 组装 FIM 请求 prompt（纯函数）：prefix + 分隔标记，suffix 走独立参数 */
function buildFimPrompt(prefix) {
    return prefix.trimEnd() + constants_1.FIM_SEPARATOR;
}
/** 从模型输出提取补全文本（纯函数） */
function extractCompletion(raw) {
    // 提取首个代码块内容；无代码块则用全文
    const fence = raw.match(/```[^\n]*\n([\s\S]*?)(```|$)/);
    const body = fence ? fence[1] : raw;
    // 去除行尾空格 + 首尾空白 + 若以换行开头去掉（避免吞行）
    return body
        .replace(/[ \t]+$/gm, '')
        .replace(/^\n+/, '')
        .trimEnd();
}
/**
 * FIM 通道：请求外部 FIM 端点（默认 DeepSeek，或自定义 OpenAI 兼容 completions）。
 * 无 Key / 请求失败 / 无文本返回 undefined（调用方降级）。
 */
async function provideFimCompletion(ctx, opts) {
    if (!opts.apiKey.trim() || !opts.endpoint.trim()) {
        return undefined;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? constants_1.TAB_COMPLETION_TIMEOUT_MS);
    try {
        const res = await fetch(opts.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${opts.apiKey.trim()}`,
            },
            body: JSON.stringify({
                model: opts.model,
                prompt: buildFimPrompt(ctx.prefix),
                suffix: ctx.suffix,
                max_tokens: constants_1.FIM_MAX_TOKENS,
                temperature: constants_1.FIM_TEMPERATURE,
                stream: false,
                echo: false,
            }),
            signal: ac.signal,
        });
        if (!res.ok) {
            logger_1.logger.warn(`[TabCompletion] FIM 端点 ${res.status}`);
            return undefined;
        }
        const data = await res.json();
        const text = data.choices?.[0]?.text;
        return typeof text === 'string' ? extractCompletion(text.slice(0, constants_1.TAB_COMPLETION_MAX_RESULT_CHARS)) : undefined;
    }
    catch (err) {
        logger_1.logger.warn('[TabCompletion] FIM 请求失败', err);
        return undefined;
    }
    finally {
        clearTimeout(timer);
    }
}
/** fast 通道：走模型路由 fast 档（原 Tab 补全逻辑） */
async function provideFastCompletion(ctx) {
    const routed = await (0, modelRouter_1.routeModel)({ tier: 'fast' });
    if (!routed) {
        return undefined;
    }
    const cts = new vscode.CancellationTokenSource();
    const timer = setTimeout(() => cts.cancel(), constants_1.TAB_COMPLETION_TIMEOUT_MS);
    try {
        const response = await routed.model.sendRequest([vscode.LanguageModelChatMessage.User(buildCompletionPrompt(ctx))], {}, cts.token);
        let text = '';
        for await (const chunk of response.stream) {
            if (chunk instanceof vscode.LanguageModelTextPart) {
                text += chunk.value;
                if (text.length > constants_1.TAB_COMPLETION_MAX_RESULT_CHARS) {
                    break;
                }
            }
        }
        return extractCompletion(text.slice(0, constants_1.TAB_COMPLETION_MAX_RESULT_CHARS));
    }
    catch (err) {
        logger_1.logger.warn('[TabCompletion] 补全生成失败', err);
        return undefined;
    }
    finally {
        clearTimeout(timer);
        cts.dispose();
    }
}
/**
 * 生成 Tab 补全：mode=fim 且配 Key → FIM 通道（失败降级 fast）；否则 fast 通道。
 * 未启用 / 无模型 / 失败时返回 undefined（调用方静默降级）。
 */
async function provideTabCompletion(ctx) {
    const cfg = vscode.workspace.getConfiguration(constants_1.TAB_COMPLETION_CONFIG);
    const enabled = cfg.get(constants_1.TAB_COMPLETION_CONFIG_KEYS.enabled, false);
    if (!enabled) {
        return undefined;
    }
    const mode = cfg.get(constants_1.TAB_COMPLETION_CONFIG_KEYS.mode, constants_1.TAB_COMPLETION_MODE_FIM);
    if (mode === constants_1.TAB_COMPLETION_MODE_FIM) {
        const apiKey = cfg.get(constants_1.TAB_COMPLETION_CONFIG_KEYS.fimApiKey, '');
        if (apiKey.trim()) {
            const provider = cfg.get(constants_1.TAB_COMPLETION_CONFIG_KEYS.fimProvider, constants_1.FIM_PROVIDER_DEEPSEEK);
            const endpoint = provider === constants_1.FIM_PROVIDER_CUSTOM
                ? cfg.get(constants_1.TAB_COMPLETION_CONFIG_KEYS.fimEndpoint, constants_1.FIM_DEFAULT_ENDPOINT)
                : constants_1.FIM_DEFAULT_ENDPOINT;
            const model = cfg.get(constants_1.TAB_COMPLETION_CONFIG_KEYS.fimModel, constants_1.FIM_DEFAULT_MODEL);
            const fim = await provideFimCompletion(ctx, { endpoint, apiKey, model });
            if (fim) {
                return fim;
            }
            logger_1.logger.warn('[TabCompletion] FIM 失败或未配置，降级 fast 通道');
        }
    }
    return provideFastCompletion(ctx);
}
/** 注册 Tab 补全（InlineCompletion 提供者，默认关闭） */
function registerTabCompletion(context) {
    context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, {
        async provideInlineCompletionItems(document, position, _ctx, _token) {
            const enabled = vscode.workspace.getConfiguration(constants_1.TAB_COMPLETION_CONFIG)
                .get(constants_1.TAB_COMPLETION_CONFIG_KEYS.enabled, false);
            if (!enabled) {
                return [];
            }
            const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
            const lastLine = document.lineAt(Math.max(0, document.lineCount - 1)).range.end;
            const suffix = document.getText(new vscode.Range(position, lastLine));
            const text = await provideTabCompletion({
                prefix,
                suffix,
                language: document.languageId,
            });
            if (!text) {
                return [];
            }
            const mode = vscode.workspace.getConfiguration(constants_1.TAB_COMPLETION_CONFIG)
                .get(constants_1.TAB_COMPLETION_CONFIG_KEYS.mode, constants_1.TAB_COMPLETION_MODE_FIM);
            (0, tabCompletionStats_1.recordTabSuggestion)(mode);
            return [{
                    insertText: text,
                    range: new vscode.Range(position, position),
                    command: { command: 'kodrix.tabCompletion.accepted', title: '补全接受' },
                }];
        },
    }), vscode.commands.registerCommand('kodrix.tabCompletion.accepted', () => {
        const mode = vscode.workspace.getConfiguration(constants_1.TAB_COMPLETION_CONFIG)
            .get(constants_1.TAB_COMPLETION_CONFIG_KEYS.mode, constants_1.TAB_COMPLETION_MODE_FIM);
        (0, tabCompletionStats_1.recordTabAccept)(mode);
    }), vscode.commands.registerCommand('kodrix.tabCompletion.stats', () => (0, tabCompletionStats_1.showTabCompletionStats)()));
}
