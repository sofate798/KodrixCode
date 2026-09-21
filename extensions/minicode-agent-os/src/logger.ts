/*---------------------------------------------------------------------------------------------
 *  Minicode Agent OS — 统一日志模块
 *
 *  大厂工程化标准：
 *   1. ILogger 接口 — 支持依赖注入，核心逻辑可脱离 VS Code API 进行单元测试
 *   2. Logger 类 — 生产实现，支持 OutputChannel、最近错误追踪、DEBUG 级别
 *   3. createLogger(name) — 工厂函数，避免模块间共享同一个 Channel
 *   4. logger 单例 — 向后兼容，主扩展入口使用默认实例
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MAX_RECENT_ERRORS } from './shared/constants';

// ── 类型定义 ────────────────────────────────────────────────────

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export interface LogEntry {
	timestamp: string;
	level: LogLevel;
	message: string;
	error?: string;
}

/**
 * 日志接口 — 依赖倒置原则：模块依赖此接口而非具体实现，
 * 因此可以注入 mock 在单元测试中验证日志输出。
 */
export interface ILogger {
	info(message: string): void;
	warn(message: string, error?: unknown): void;
	error(message: string, error?: unknown): void;
	debug(message: string): void;
	show(): void;
	dispose(): void;
}

// ── 生产实现 ────────────────────────────────────────────────────

export class Logger implements ILogger {
	private _channel: vscode.OutputChannel | undefined;
	private _recentErrors: LogEntry[] = [];
	private readonly _channelName: string;
	private readonly _maxRecentErrors: number;

	constructor(channelName: string, maxRecentErrors: number = MAX_RECENT_ERRORS) {
		this._channelName = channelName;
		this._maxRecentErrors = maxRecentErrors;
	}

	private getChannel(): vscode.OutputChannel {
		if (!this._channel) {
			this._channel = vscode.window.createOutputChannel(this._channelName);
		}
		return this._channel;
	}

	private format(level: LogLevel, message: string, error?: unknown): string {
		const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.mmm
		let out = `[${ts}] [${level}] ${message}`;
		if (error !== undefined) {
			out += '\n  ' + (error instanceof Error
				? `${error.message}\n${error.stack ?? ''}`
				: String(error));
		}
		return out;
	}

	info(message: string): void {
		this.getChannel().appendLine(this.format('INFO', message));
	}

	warn(message: string, error?: unknown): void {
		this.getChannel().appendLine(this.format('WARN', message, error));
	}

	error(message: string, error?: unknown): void {
		const formatted = this.format('ERROR', message, error);
		this.getChannel().appendLine(formatted);
		const entry: LogEntry = {
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

	debug(message: string): void {
		if (process.env['MINICODE_DEBUG']) {
			this.getChannel().appendLine(this.format('DEBUG', message));
		}
	}

	getRecentErrors(): ReadonlyArray<LogEntry> {
		return this._recentErrors;
	}

	show(): void {
		this.getChannel().show(true);
	}

	dispose(): void {
		this._channel?.dispose();
		this._channel = undefined;
		this._recentErrors = [];
	}
}

// ── 工厂函数 ────────────────────────────────────────────────────

/** 为指定模块创建独立 Logger（独立的 OutputChannel） */
export function createLogger(channelName: string): Logger {
	return new Logger(channelName);
}

// ── 向后兼容的单例 ──────────────────────────────────────────────

/** 主扩展实例使用的默认 Logger（历史兼容） */
export const logger: Logger = new Logger('Minicode Agent OS');
