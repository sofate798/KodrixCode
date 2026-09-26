/*---------------------------------------------------------------------------------------------
 *  VS Code Mock — 单元测试中拦截 require('vscode')
 *
 *  通过 Module._resolveFilename 将 'vscode' 模块重定向到本文件预注册的缓存条目，
 *  使被测源文件无需 @vscode/test-electron 即可加载。
 *--------------------------------------------------------------------------------------------*/

import Module from 'module';

const mockVscode = {
	// ── workspace ────────────────────────────────────────────────
	workspace: {
		workspaceFolders: undefined as unknown[] | undefined,
		textDocuments: [] as unknown[],
		getConfiguration(_section?: string) {
			return {
				get<T>(_key: string, defaultValue?: T): T | undefined { return defaultValue; },
				has(_key: string): boolean { return false; },
				inspect(_key: string): undefined { return undefined; },
				update: async () => { /* no-op */ },
			};
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

	// ── commands ─────────────────────────────────────────────────
	commands: {
		executeCommand: async (..._args: unknown[]) => undefined,
		registerCommand(_command: string, _callback: (...args: unknown[]) => unknown) {
			return { dispose: () => { /* no-op */ } };
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
	MarkdownString: class { value: string; constructor(value?: string) { this.value = value ?? ''; } },
	ViewColumn: { One: 1, Two: 2, Three: 3 },
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

require.cache[fakeVscodePath] = {
	exports: mockVscode,
} as unknown as NodeModule;

module.exports = mockVscode;
