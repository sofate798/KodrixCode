/*---------------------------------------------------------------------------------------------
 *  Minicode SOLO — 统一日志模块
 *
 *  大厂工程化标准：
 *   1. 与 agent-os 使用相同的 ILlogger 接口 + Logger 类模式
 *   2. 通过工厂函数创建，支持单元测试 mock
 *   3. 模块级单例供历史代码兼容
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
		if (process.env['MINICODE_DEBUG']) {
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

// ── 工厂 + 单例 ──────────────────────────────────────────────

/** 为指定模块创建独立 Logger */
export function createLogger(channelName: string): Logger {
	return new Logger(channelName);
}

/** 默认 SOLO 扩展 Logger */
export const logger: Logger = new Logger('Minicode SOLO');
