"use strict";
/*---------------------------------------------------------------------------------------------
 *  Kodrix Agent OS — 统一日志模块
 *
 *  大厂工程化标准：
 *   1. ILogger 接口 — 支持依赖注入，核心逻辑可脱离 VS Code API 进行单元测试
 *   2. Logger 类 — 生产实现，支持 OutputChannel、最近错误追踪、DEBUG 级别
 *   3. createLogger(name) — 工厂函数，避免模块间共享同一个 Channel
 *   4. logger 单例 — 向后兼容，主扩展入口使用默认实例
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
exports.logger = exports.Logger = void 0;
exports.createLogger = createLogger;
const vscode = __importStar(require("vscode"));
const constants_1 = require("./shared/constants");
// ── 生产实现 ────────────────────────────────────────────────────
class Logger {
    _channel;
    _recentErrors = [];
    _channelName;
    _maxRecentErrors;
    constructor(channelName, maxRecentErrors = constants_1.MAX_RECENT_ERRORS) {
        this._channelName = channelName;
        this._maxRecentErrors = maxRecentErrors;
    }
    getChannel() {
        if (!this._channel) {
            this._channel = vscode.window.createOutputChannel(this._channelName);
        }
        return this._channel;
    }
    format(level, message, error) {
        const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.mmm
        let out = `[${ts}] [${level}] ${message}`;
        if (error !== undefined) {
            out += '\n  ' + (error instanceof Error
                ? `${error.message}\n${error.stack ?? ''}`
                : String(error));
        }
        return out;
    }
    info(message) {
        this.getChannel().appendLine(this.format('INFO', message));
    }
    warn(message, error) {
        this.getChannel().appendLine(this.format('WARN', message, error));
    }
    error(message, error) {
        const formatted = this.format('ERROR', message, error);
        this.getChannel().appendLine(formatted);
        const entry = {
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message,
            error: error instanceof Error ? error.message : (error !== undefined ? String(error) : undefined),
        };
        this._recentErrors.push(entry);
        if (this._recentErrors.length > this._maxRecentErrors) {
            this._recentErrors.shift();
        }
    }
    debug(message) {
        if (process.env['KODRIX_DEBUG']) {
            this.getChannel().appendLine(this.format('DEBUG', message));
        }
    }
    getRecentErrors() {
        return this._recentErrors;
    }
    show() {
        this.getChannel().show(true);
    }
    dispose() {
        this._channel?.dispose();
        this._channel = undefined;
        this._recentErrors = [];
    }
}
exports.Logger = Logger;
// ── 工厂函数 ────────────────────────────────────────────────────
/** 为指定模块创建独立 Logger（独立的 OutputChannel） */
function createLogger(channelName) {
    return new Logger(channelName);
}
// ── 向后兼容的单例 ──────────────────────────────────────────────
/** 主扩展实例使用的默认 Logger（历史兼容） */
exports.logger = new Logger('Kodrix Agent OS');
