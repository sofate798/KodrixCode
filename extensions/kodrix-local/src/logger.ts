/*---------------------------------------------------------------------------------------------
 *  Kodrix Local — 统一日志模块
 *
 *  大厂工程化标准：
 *   1. 与 agent-os 使用相同的 ILogger 接口 + Logger 类模式
 *   2. 保留 logInfo/logWarn/logError 函数导出（向后兼容）
 *   3. 工厂函数支持单元测试 mock
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

// ── 类型定义 ────────────────────────────────────────────────────

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

/** 日志接口 — 依赖倒置，支持 mock 注入 */
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
	private readonly _channelName: string;

	constructor(channelName: string) {
		this._channelName = channelName;
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
		this.getChannel().appendLine(this.format('ERROR', message, error));
	}

	debug(message: string): void {
		if (process.env['KODRIX_DEBUG']) {
			this.getChannel().appendLine(this.format('DEBUG', message));
		}
	}

	show(): void {
		this.getChannel().show(true);
	}

	dispose(): void {
		this._channel?.dispose();
		this._channel = undefined;
	}
}

// ── 单例 ──────────────────────────────────────────────────────

export const logger: Logger = new Logger('Kodrix');

// ── 向后兼容的函数导出 ──────────────────────────────────────────

/** @deprecated 使用 logger.info() 替代 */
export const logInfo = logger.info.bind(logger);

/** @deprecated 使用 logger.warn() 替代 */
export const logWarn = logger.warn.bind(logger);

/** @deprecated 使用 logger.error() 替代 */
export const logError = logger.error.bind(logger);

/** @deprecated 使用 logger.dispose() 替代 */
export const disposeLogger = logger.dispose.bind(logger);
