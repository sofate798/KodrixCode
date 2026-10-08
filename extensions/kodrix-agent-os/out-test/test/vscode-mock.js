"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const module_1 = __importDefault(require("module"));
/** 测试注入的配置值（全键 → 值），如 'kodrix.crew.maxParallel' → 5 */
const _testConfigValues = new Map();
const mockVscode = {
    // ── workspace ────────────────────────────────────────────────
    workspace: {
        workspaceFolders: undefined,
        /** 测试默认按"已信任"处理；不受信任场景由用例自己改成 false */
        isTrusted: true,
        textDocuments: [],
        getConfiguration(section) {
            const prefix = section ? `${section}.` : '';
            return {
                get(key, defaultValue) {
                    const full = prefix + key;
                    return _testConfigValues.has(full) ? _testConfigValues.get(full) : defaultValue;
                },
                has(key) { return _testConfigValues.has(prefix + key); },
                inspect(_key) { return undefined; },
                update: async (key, value) => {
                    if (value === undefined) {
                        _testConfigValues.delete(prefix + key);
                    }
                    else {
                        _testConfigValues.set(prefix + key, value);
                    }
                },
            };
        },
        /** 设置项变更事件（registerKanban 等订阅；测试可 fire 触发） */
        onDidChangeConfiguration(_listener) {
            return { dispose: () => { } };
        },
        onDidChangeWorkspaceFolders(_listener) {
            return { dispose: () => { } };
        },
        openTextDocument: async (_uriOrOptions) => ({
            getText: () => '',
            lineCount: 0,
        }),
        fs: {
            readFile: async () => Buffer.from(''),
            writeFile: async () => { },
            stat: async () => ({ type: 1, size: 0 }),
        },
        onDidSaveTextDocument: () => ({ dispose: () => { } }),
    },
    // ── window ───────────────────────────────────────────────────
    window: {
        showInformationMessage: async (..._args) => undefined,
        showWarningMessage: async (..._args) => undefined,
        showErrorMessage: async (..._args) => undefined,
        createOutputChannel(_name) {
            return {
                appendLine: () => { },
                append: () => { },
                show: () => { },
                dispose: () => { },
            };
        },
        showQuickPick: async (_items, ..._args) => undefined,
        showTextDocument: async (..._args) => undefined,
        showInputBox: async (..._args) => undefined,
        createQuickPick() {
            return {
                items: [],
                selectedItems: [],
                activeItems: [],
                placeholder: '',
                title: '',
                onDidAccept: () => ({ dispose: () => { } }),
                onDidHide: () => ({ dispose: () => { } }),
                onDidChangeSelection: () => ({ dispose: () => { } }),
                show: () => { },
                hide: () => { },
                dispose: () => { },
            };
        },
        createTreeView: (_id, _opts) => ({
            dispose: () => { },
            refresh: async () => { },
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
        __executedCommands: [],
        /** 测试断言用：记录 registerCommand 注册的 handler（按命令 ID） */
        __commands: Object.create(null),
        executeCommand: async (...args) => {
            mockVscode.commands
                .__executedCommands.push({ command: String(args[0]), args: args.slice(1) });
            return undefined;
        },
        registerCommand(_command, _callback) {
            mockVscode.commands.__commands[_command] = _callback;
            return { dispose: () => { delete mockVscode.commands.__commands[_command]; } };
        },
    },
    // ── Uri ──────────────────────────────────────────────────────
    Uri: {
        parse(value) { return { fsPath: value, scheme: 'file', path: value, toString: () => value }; },
        file(value) { return { fsPath: value, scheme: 'file', path: value, toString: () => value }; },
        joinPath(base, ...pathSegments) {
            const path = require('path');
            const joined = path.join(base.fsPath, ...pathSegments);
            return { fsPath: joined, scheme: 'file', path: joined, toString: () => joined };
        },
    },
    // ── languages ──────────────────────────────────────────────────
    languages: {
        /** 测试断言用：记录 registerInlineCompletionItemProvider 注册的 provider */
        __inlineProviders: [],
        registerInlineCompletionItemProvider(_selector, provider) {
            mockVscode.languages
                .__inlineProviders.push(provider);
            return { dispose: () => { } };
        },
    },
    // ── InlineCompletion / LanguageModel 基础类型 ──────────────────
    Position: class {
        line;
        character;
        constructor(line, character) {
            this.line = line;
            this.character = character;
        }
    },
    Range: class {
        start;
        end;
        constructor(start, end) {
            this.start = start;
            this.end = end;
        }
    },
    CancellationTokenSource: class {
        token = { isCancellationRequested: false };
        cancel() { this.token.isCancellationRequested = true; }
        dispose() { }
    },
    LanguageModelTextPart: class {
        value;
        constructor(value) {
            this.value = value;
        }
    },
    LanguageModelChatMessage: class {
        role;
        content;
        constructor(role, content) { this.role = role; this.content = content; }
        static User(content) { return new this('user', content); }
        static Assistant(content) { return new this('assistant', content); }
    },
    // ── ConfigurationTarget ──────────────────────────────────────
    ConfigurationTarget: {
        Global: 1,
        Workspace: 2,
        WorkspaceFolder: 3,
    },
    // ── EventEmitter ─────────────────────────────────────────────
    EventEmitter: class {
        _listeners = [];
        event = (listener) => {
            this._listeners.push(listener);
            return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
        };
        fire(data) { for (const l of this._listeners) {
            l(data);
        } }
        dispose() { this._listeners = []; }
    },
    // ── Disposable ───────────────────────────────────────────────
    Disposable: class {
        _callOnDispose;
        constructor(callOnDispose) { this._callOnDispose = callOnDispose; }
        dispose() { this._callOnDispose?.(); }
        static from(...disposables) {
            return new this(() => { for (const d of disposables) {
                d.dispose();
            } });
        }
    },
    // ── l10n ─────────────────────────────────────────────────────
    l10n: {
        t(message, ...args) {
            if (args.length) {
                return message.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? `{${i}}`));
            }
            return message;
        },
    },
    // ── TreeItem / TreeItemCollapsibleState ──────────────────────
    TreeItem: class {
        label;
        constructor(label) { this.label = label; }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {
        constructor(_id) { }
    },
    ThemeColor: class {
        constructor(_id) { }
    },
    MarkdownString: class {
        value;
        constructor(value) { this.value = value ?? ''; }
    },
    ViewColumn: { One: 1, Two: 2, Three: 3 },
};
// ── 测试辅助：注入 / 清空配置值（全键，如 'kodrix.crew.maxParallel'） ──
mockVscode.__setTestConfig = (key, value) => {
    _testConfigValues.set(key, value);
};
mockVscode.__resetTestConfig = () => {
    _testConfigValues.clear();
    mockVscode.commands.__executedCommands.length = 0;
    mockVscode.commands.__commands = {};
    mockVscode.languages.__inlineProviders.length = 0;
};
// ── 注册到 Module 缓存 ──────────────────────────────────────────
const fakeVscodePath = 'vscode-mock-fake-path';
const originalResolveFilename = module_1.default._resolveFilename;
module_1.default._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'vscode') {
        return fakeVscodePath;
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
};
const fakeModule = {
    exports: mockVscode,
};
require.cache[fakeVscodePath] = fakeModule;
module.exports = mockVscode;
