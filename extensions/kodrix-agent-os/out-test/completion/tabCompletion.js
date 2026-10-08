"use strict";
/*---------------------------------------------------------------------------------------------
 *  Tab Completion — 专用 Tab 补全模型通道（对标 Cursor 的 Tab 快速补全）
 *
 *  设计：
 *    1. 默认关闭（kodrix.tabCompletion.enabled = false），避免与上游 Copilot 内联补全冲突；
 *       用户开启后由 Kodrix 提供 InlineCompletion。
 *    2. 双通道：mode=fim → 专用 FIM 端点（端点由 kodrix.tabCompletion.fimEndpoint 配置，
 *       默认 DeepSeek FIM；kodrix.tabCompletion.fimEnabled=false 可整体禁用专线）；
 *       mode=fast → 通用模型通道（走模型路由 fast 档）。FIM 失败自动降级 fast，
 *       但失败/降级不再静默：logger 记录状态码与原因，统计（tabCompletion.stats）按
 *       实际产出通道区分并附 FIM 专线诊断。
 *    3. 端点返回 4xx（非 429）视为接口不存在，本会话内熔断该端点不再重试（日志+统计可见）。
 *    4. buildCompletionPrompt / buildFimPrompt / extractCompletion 为纯函数，便于单元测试。
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
exports.getFimBlockedEndpoint = getFimBlockedEndpoint;
exports.resetFimEndpointBlocklist = resetFimEndpointBlocklist;
exports.provideFimCompletion = provideFimCompletion;
exports.provideTabCompletionOutcome = provideTabCompletionOutcome;
exports.provideTabCompletion = provideTabCompletion;
exports.registerTabCompletion = registerTabCompletion;
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const modelRouter_1 = require("../model/modelRouter");
const tabCompletionStats_1 = require("./tabCompletionStats");
const logger_1 = require("../logger");
const constants_1 = require("../shared/constants");
const secretStorage_1 = require("../secretStorage");
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
/** 本次会话内被熔断的 FIM 端点（4xx「接口不存在」类错误后不再重复请求） */
let _fimBlockedEndpoint;
/** 当前被熔断的 FIM 端点（供统计面板展示） */
function getFimBlockedEndpoint() {
    return _fimBlockedEndpoint;
}
/** 重置 FIM 端点熔断状态（测试用；用户侧改端点配置或重启扩展宿主亦可恢复） */
function resetFimEndpointBlocklist() {
    _fimBlockedEndpoint = undefined;
}
/** 判断是否 4xx「接口不存在」类永久错误（429 限流为瞬时错误，不熔断） */
function isPermanentFimStatus(status) {
    return status >= 400 && status < 500 && status !== 429;
}
async function safeReadBody(res) {
    try {
        return (await res.text?.())?.slice(0, 200) ?? '';
    }
    catch {
        return '';
    }
}
/**
 * FIM 通道：请求 FIM 端点（端点来自 kodrix.tabCompletion.fimEndpoint 设置，默认 DeepSeek）。
 * 无 Key / 请求失败 / 无文本返回 undefined（调用方降级 fast），但失败一律：
 *   - logger 记录状态码 + 端点 + 响应片段；
 *   - 统计模块记录 fim.failures / fim.lastFailure；
 *   - 4xx（非 429）触发本会话端点熔断，后续请求直接跳过并计入 fim.skips。
 */
async function provideFimCompletion(ctx, opts) {
    if (!opts.apiKey.trim() || !opts.endpoint.trim()) {
        return undefined;
    }
    if (_fimBlockedEndpoint === opts.endpoint) {
        logger_1.logger.warn(`[TabCompletion] FIM 端点 ${opts.endpoint} 此前返回 4xx，本会话已跳过（不再重试）`);
        (0, tabCompletionStats_1.recordTabFimSkip)(opts.endpoint);
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
            const bodySnippet = await safeReadBody(res);
            const reason = `HTTP ${res.status}${bodySnippet ? ` ${bodySnippet}` : ''}`;
            logger_1.logger.warn(`[TabCompletion] FIM 请求失败 status=${res.status} endpoint=${opts.endpoint} body=${bodySnippet || '(empty)'}`);
            (0, tabCompletionStats_1.recordTabFimFailure)(opts.endpoint, res.status, reason.slice(0, 300));
            if (isPermanentFimStatus(res.status)) {
                _fimBlockedEndpoint = opts.endpoint;
                logger_1.logger.warn(`[TabCompletion] FIM 端点 ${opts.endpoint} 因 ${res.status} 被本会话熔断，后续补全直接走 fast 通道`);
            }
            return undefined;
        }
        const data = await res.json();
        const text = data.choices?.[0]?.text;
        if (typeof text !== 'string' || !text.trim()) {
            logger_1.logger.warn(`[TabCompletion] FIM 返回 ${res.status} 但 choices[0].text 无内容，endpoint=${opts.endpoint}`);
            (0, tabCompletionStats_1.recordTabFimFailure)(opts.endpoint, res.status, '响应 choices[0].text 无文本');
            return undefined;
        }
        return extractCompletion(text.slice(0, constants_1.TAB_COMPLETION_MAX_RESULT_CHARS));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger_1.logger.warn(`[TabCompletion] FIM 请求异常 endpoint=${opts.endpoint}: ${msg}`, err);
        (0, tabCompletionStats_1.recordTabFimFailure)(opts.endpoint, 'network', msg.slice(0, 300));
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
/** 模块级 ExtensionContext 引用（由 registerTabCompletion 注入） */
let _extCtx;
/** 最近一次建议的实际产出通道（接受事件按此归因，避免按配置 mode 误计） */
let _lastSuggestedChannel;
/**
 * 解析 FIM 端点：始终读取 kodrix.tabCompletion.fimEndpoint 设置，
 * 未配置/为空时回退 FIM_DEFAULT_ENDPOINT（保持历史默认地址，向后兼容）。
 */
function resolveFimEndpoint(cfg) {
    const configured = cfg.get(constants_1.TAB_COMPLETION_CONFIG_KEYS.fimEndpoint, constants_1.FIM_DEFAULT_ENDPOINT);
    return (configured ?? '').trim() || constants_1.FIM_DEFAULT_ENDPOINT;
}
/**
 * 生成 Tab 补全并报告实际通道：mode=fim 且 fimEnabled 且配 Key → FIM 通道
 * （失败/熔断自动降级 fast，且降级事件已记入日志与统计）；否则 fast 通道。
 * 未启用 / 无模型 / 失败时返回 undefined（调用方静默降级）。
 */
async function provideTabCompletionOutcome(ctx) {
    const cfg = vscode.workspace.getConfiguration(constants_1.TAB_COMPLETION_CONFIG);
    const enabled = cfg.get(constants_1.TAB_COMPLETION_CONFIG_KEYS.enabled, false);
    if (!enabled) {
        return undefined;
    }
    const mode = cfg.get(constants_1.TAB_COMPLETION_CONFIG_KEYS.mode, constants_1.TAB_COMPLETION_MODE_FIM);
    if (mode === constants_1.TAB_COMPLETION_MODE_FIM) {
        const fimEnabled = cfg.get(constants_1.TAB_COMPLETION_CONFIG_KEYS.fimEnabled, constants_1.TAB_COMPLETION_FIM_ENABLED_DEFAULT);
        if (!fimEnabled) {
            logger_1.logger.debug('[TabCompletion] kodrix.tabCompletion.fimEnabled=false，FIM 专线已禁用，直连 fast 通道');
        }
        else {
            const apiKey = _extCtx ? await (0, secretStorage_1.getFimApiKey)(_extCtx) : undefined;
            if (apiKey) {
                const endpoint = resolveFimEndpoint(cfg);
                const model = cfg.get(constants_1.TAB_COMPLETION_CONFIG_KEYS.fimModel, constants_1.FIM_DEFAULT_MODEL);
                const fim = await provideFimCompletion(ctx, { endpoint, apiKey, model });
                if (fim) {
                    return { text: fim, channel: 'fim' };
                }
                logger_1.logger.warn('[TabCompletion] 本次补全 FIM 通道失败或已熔断，降级 fast 通道产出（详见 Kodrix: Tab 补全统计 → FIM 专线诊断）');
            }
        }
    }
    const fast = await provideFastCompletion(ctx);
    return fast ? { text: fast, channel: 'fast' } : undefined;
}
/** 生成 Tab 补全（兼容旧签名，仅返回文本；通道归因请用 provideTabCompletionOutcome） */
async function provideTabCompletion(ctx) {
    const outcome = await provideTabCompletionOutcome(ctx);
    return outcome?.text;
}
/** 注册 Tab 补全（InlineCompletion 提供者，默认关闭） */
function registerTabCompletion(context) {
    _extCtx = context;
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
            const outcome = await provideTabCompletionOutcome({
                prefix,
                suffix,
                language: document.languageId,
            });
            if (!outcome) {
                return [];
            }
            _lastSuggestedChannel = outcome.channel;
            // 统计按实际产出通道记录：FIM 失败降级的结果计入 fast，不混入 FIM 命中率
            (0, tabCompletionStats_1.recordTabSuggestion)(outcome.channel);
            return [{
                    insertText: outcome.text,
                    range: new vscode.Range(position, position),
                    command: { command: 'kodrix.tabCompletion.accepted', title: vscode_1.l10n.t('Completion acceptance') },
                }];
        },
    }), vscode.commands.registerCommand('kodrix.tabCompletion.accepted', () => {
        (0, tabCompletionStats_1.recordTabAccept)(_lastSuggestedChannel
            ?? vscode.workspace.getConfiguration(constants_1.TAB_COMPLETION_CONFIG)
                .get(constants_1.TAB_COMPLETION_CONFIG_KEYS.mode, constants_1.TAB_COMPLETION_MODE_FIM));
    }), vscode.commands.registerCommand('kodrix.tabCompletion.stats', () => (0, tabCompletionStats_1.showTabCompletionStats)(getFimBlockedEndpoint())));
}
