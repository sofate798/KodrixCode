/*---------------------------------------------------------------------------------------------
 *  VS Code Mock — 单元测试中拦截 require('vscode')
 *
 *  通过 Module._resolveFilename 将 'vscode' 模块重定向到本文件预注册的缓存条目，
 *  使被测源文件无需 @vscode/test-electron 即可加载。
 *
 *  配置 mock：维护一张全键值表，getConfiguration(section).get(key) 按
 *  「section.key」拼接查找；未注入的键回退调用方默认值（与真实 VS Code 一致）。
 *  测试通过 __setTestConfig / __resetTestConfig 注入设置项。
 *--------------------------------------------------------------------------------------------*/

import Module from 'module';

/** 测试注入的配置值（全键 → 值），如 'kodrix.crew.maxParallel' → 5 */
const _testConfigValues = new Map<string, unknown>();

const mockVscode = {
	// ── workspace ────────────────────────────────────────────────
	workspace: {
		workspaceFolders: undefined as unknown[] | undefined,
		/** 测试默认按"已信任"处理；不受信任场景由用例自己改成 false */
		isTrusted: true,
		textDocuments: [] as unknown[],
		getConfiguration(section?: string) {
			const prefix = section ? `${section}.` : '';
			return {
				get<T>(key: string, defaultValue?: T): T | undefined {
					const full = prefix + key;
					return _testConfigValues.has(full) ? (_testConfigValues.get(full) as T) : defaultValue;
				},
				has(key: string): boolean { return _testConfigValues.has(prefix + key); },
				inspect(_key: string): undefined { return undefined; },
				update: async (key: string, value: unknown) => {
					if (value === undefined) {
						_testConfigValues.delete(prefix + key);
					} else {
						_testConfigValues.set(prefix + key, value);
					}
				},
			};
		},
		/** 设置项变更事件（registerKanban 等订阅；测试可 fire 触发） */
		onDidChangeConfiguration(_listener: (e: { affectsConfiguration: (id: string) => boolean }) => void) {
			return { dispose: () => { /* no-op */ } };
		},
		onDidChangeWorkspaceFolders(_listener: () => void) {
			return { dispose: () => { /* no-op */ } };
		},
		openTextDocument: async (_uriOrOptions?: unknown) => ({
			getText: () => '',
			lineCount: 0,
		}),
		fs: {
			readFile: async () => Buffer.from(''),
			writeFile: async () => { /* no-op */ },
			stat: async () => ({ type: 1, size: 0 }),
		},
		onDidSaveTextDocument: () => ({ dispose: () => { /* no-op */ } }),
	},

	// ── window ───────────────────────────────────────────────────
	window: {
		showInformationMessage: async (..._args: unknown[]) => undefined,
		showWarningMessage: async (..._args: unknown[]) => undefined,
		showErrorMessage: async (..._args: unknown[]) => undefined,
		createOutputChannel(_name: string) {
			return {
				appendLine: () => { /* no-op */ },
				append: () => { /* no-op */ },
				show: () => { /* no-op */ },
				dispose: () => { /* no-op */ },
			};
		},
		showQuickPick: async (_items: unknown[], ..._args: unknown[]) => undefined,
		showTextDocument: async (..._args: unknown[]) => undefined,
		showInputBox: async (..._args: unknown[]) => undefined,
		createQuickPick() {
			return {
				items: [],
				selectedItems: [],
				activeItems: [],
				placeholder: '',
				title: '',
				onDidAccept: () => ({ dispose: () => { /* no-op */ } }),
				onDidHide: () => ({ dispose: () => { /* no-op */ } }),
				onDidChangeSelection: () => ({ dispose: () => { /* no-op */ } }),
				show: () => { /* no-op */ },
				hide: () => { /* no-op */ },
				dispose: () => { /* no-op */ },
			};
		},
		createTreeView: (_id: string, _opts: unknown) => ({
			dispose: () => { /* no-op */ },
			refresh: async () => { /* no-op */ },
		}),
		activeTextEditor: undefined,
	},

	// ── env ─────────────────────────────────────────────────────
	env: {
		/** loadWebviewHtml 会读取 vscode.env.language 注入 {{htmlLang}} */
		language: 'en',
	},

	// ── commands ─────────────────────────────────────────────────
	commands: {
		/** 测试断言用：记录 executeCommand 的全部调用 */
		__executedCommands: [] as Array<{ command: string; args: unknown[] }>,
		/** 测试断言用：记录 registerCommand 注册的 handler（按命令 ID） */
		__commands: Object.create(null) as Record<string, ((...args: unknown[]) => unknown) | undefined>,
		executeCommand: async (...args: unknown[]) => {
			(mockVscode.commands as { __executedCommands: Array<{ command: string; args: unknown[] }> })
				.__executedCommands.push({ command: String(args[0]), args: args.slice(1) });
			return undefined;
		},
		registerCommand(_command: string, _callback: (...args: unknown[]) => unknown) {
			(mockVscode.commands as { __commands: Record<string, (...args: unknown[]) => unknown> }).__commands[_command] = _callback;
			return { dispose: () => { delete (mockVscode.commands as { __commands: Record<string, (...args: unknown[]) => unknown> }).__commands[_command]; } };
		},
	},

	// ── Uri ──────────────────────────────────────────────────────
	Uri: {
		parse(value: string) { return { fsPath: value, scheme: 'file', path: value, toString: () => value }; },
		file(value: string) { return { fsPath: value, scheme: 'file', path: value, toString: () => value }; },
		joinPath(base: { fsPath: string }, ...pathSegments: string[]) {
			const path = require('path');
			const joined = path.join(base.fsPath, ...pathSegments);
			return { fsPath: joined, scheme: 'file', path: joined, toString: () => joined };
		},
	},

	// ── languages ──────────────────────────────────────────────────
	languages: {
		/** 测试断言用：记录 registerInlineCompletionItemProvider 注册的 provider */
		__inlineProviders: [] as Array<{ provideInlineCompletionItems: (...args: unknown[]) => unknown }>,
		registerInlineCompletionItemProvider(_selector: unknown, provider: { provideInlineCompletionItems: (...args: unknown[]) => unknown }) {
			(mockVscode.languages as unknown as { __inlineProviders: Array<{ provideInlineCompletionItems: (...args: unknown[]) => unknown }> })
				.__inlineProviders.push(provider);
			return { dispose: () => { /* no-op */ } };
		},
	},

	// ── InlineCompletion / LanguageModel 基础类型 ──────────────────
	Position: class {
		constructor(public line: number, public character: number) { /* no-op */ }
	},
	Range: class {
		constructor(public start: { line: number; character: number }, public end: { line: number; character: number }) { /* no-op */ }
	},
	CancellationTokenSource: class {
		private _listeners: Array<() => void> = [];
		token = {
			isCancellationRequested: false,
			onCancellationRequested: (fn: () => void) => {
				this._listeners.push(fn);
				return { dispose: () => { this._listeners = this._listeners.filter(l => l !== fn); } };
			},
		};
		cancel() {
			if (!this.token.isCancellationRequested) {
				this.token.isCancellationRequested = true;
				for (const fn of this._listeners) { fn(); }
			}
		}
		dispose() { /* no-op */ }
	},
	LanguageModelTextPart: class {
		constructor(public value: string) { /* no-op */ }
	},
	LanguageModelChatMessage: class {
		role: string;
		content: unknown;
		constructor(role: string, content: unknown) { this.role = role; this.content = content; }
		static User(content: unknown) { return new this('user', content); }
		static Assistant(content: unknown) { return new this('assistant', content); }
	},

	// ── ConfigurationTarget ──────────────────────────────────────
	ConfigurationTarget: {
		Global: 1,
		Workspace: 2,
		WorkspaceFolder: 3,
	},

	// ── EventEmitter ─────────────────────────────────────────────
	EventEmitter: class {
		private _listeners: Array<(...args: unknown[]) => void> = [];
		event = (listener: (...args: unknown[]) => void) => {
			this._listeners.push(listener);
			return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
		};
		fire(data?: unknown) { for (const l of this._listeners) { l(data); } }
		dispose() { this._listeners = []; }
	},

	// ── Disposable ───────────────────────────────────────────────
	Disposable: class {
		private _callOnDispose?: () => void;
		constructor(callOnDispose: () => void) { this._callOnDispose = callOnDispose; }
		dispose() { this._callOnDispose?.(); }
		static from(...disposables: Array<{ dispose: () => void }>) {
			return new this(() => { for (const d of disposables) { d.dispose(); } });
		}
	},

	// ── l10n ─────────────────────────────────────────────────────
	l10n: {
		t(message: string, ...args: unknown[]) {
			if (args.length) {
				return message.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? `{${i}}`));
			}
			return message;
		},
	},

	// ── TreeItem / TreeItemCollapsibleState ──────────────────────
	TreeItem: class {
		label: string;
		constructor(label: string) { this.label = label; }
	},
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ThemeIcon: class { constructor(_id: string) { /* no-op */ } },
	ThemeColor: class { constructor(_id?: string) { /* no-op */ } },
	MarkdownString: class { value: string; constructor(value?: string) { this.value = value ?? ''; } },
	ViewColumn: { One: 1, Two: 2, Three: 3 },
};

// ── 测试辅助：注入 / 清空配置值（全键，如 'kodrix.crew.maxParallel'） ──

(mockVscode as unknown as Record<string, unknown>).__setTestConfig = (key: string, value: unknown) => {
	_testConfigValues.set(key, value);
};
(mockVscode as unknown as Record<string, unknown>).__resetTestConfig = () => {
	_testConfigValues.clear();
	(mockVscode.commands as { __executedCommands: unknown[] }).__executedCommands.length = 0;
	(mockVscode.commands as { __commands: Record<string, unknown> }).__commands = {};
	(mockVscode.languages as unknown as { __inlineProviders: unknown[] }).__inlineProviders.length = 0;
};

// ── 注册到 Module 缓存 ──────────────────────────────────────────

const fakeVscodePath = 'vscode-mock-fake-path';
const originalResolveFilename = (Module as unknown as { _resolveFilename: Function })._resolveFilename;
(Module as unknown as { _resolveFilename: Function })._resolveFilename = function (
	request: string,
	parent: unknown,
	isMain: boolean,
	options: unknown,
) {
	if (request === 'vscode') {
		return fakeVscodePath;
	}
	return originalResolveFilename.call(this, request, parent, isMain, options);
};

const fakeModule: { exports: unknown } = {
	exports: mockVscode,
};
require.cache[fakeVscodePath] = fakeModule as unknown as NodeModule;

module.exports = mockVscode;
