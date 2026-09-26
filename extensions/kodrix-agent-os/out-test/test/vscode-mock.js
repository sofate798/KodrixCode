"use strict";
/*---------------------------------------------------------------------------------------------
 *  vscode 模块 Mock — 独立 mocha 测试中使用，替代真实 VS Code API
 *
 *  在 require('vscode') 时注入 Module._cache，使后续所有 require('vscode') 返回此 mock。
 *  各测试文件可在 before() 中进一步覆盖特定 API（如 workspace.workspaceFolders）。
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable @typescript-eslint/no-explicit-any */
const { Module } = require('module');
/** 配置检查 mock */
function createMockConfiguration(defaults = {}) {
    return {
        get(key, defaultValue) {
            return defaults[key] !== undefined ? defaults[key] : defaultValue;
        },
        has(key) { return key in defaults; },
        inspect(key) {
            return { key, defaultValue: defaults[key], globalValue: undefined, workspaceValue: undefined, workspaceFolderValue: undefined };
        },
        update: async () => { },
    };
}
/** 输出通道 mock */
function createMockOutputChannel(name) {
    return {
        append: () => { }, appendLine: () => { }, clear: () => { }, show: () => { },
        hide: () => { }, dispose: () => { }, replace: () => { }, name: name || 'mock',
    };
}
/** vscode mock 对象 */
const vscodeMock = {
    workspace: {
        workspaceFolders: undefined,
        textDocuments: [],
        getConfiguration: (_section) => createMockConfiguration(),
        onDidSaveTextDocument: () => ({ dispose: () => { } }),
        onDidChangeTextDocument: () => ({ dispose: () => { } }),
        onDidOpenTextDocument: () => ({ dispose: () => { } }),
        onDidCloseTextDocument: () => ({ dispose: () => { } }),
        openTextDocument: async () => ({ getText: () => '', uri: { fsPath: '', scheme: 'file' } }),
        fs: {
            stat: async () => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
            readFile: async () => Buffer.from(''),
            writeFile: async () => { },
            delete: async () => { },
            rename: async () => { },
        },
    },
    window: {
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        showInputBox: async () => undefined,
        showQuickPick: async () => undefined,
        createOutputChannel: (name) => createMockOutputChannel(name),
        createQuickPick: () => ({
            title: '', placeholder: '', items: [], activeItems: [],
            onDidAccept: () => ({ dispose: () => { } }),
            onDidHide: () => ({ dispose: () => { } }),
            show: () => { }, hide: () => { }, dispose: () => { },
        }),
        activeTextEditor: undefined,
    },
    commands: {
        registerCommand: (_cmd, _handler) => ({ dispose: () => { } }),
        executeCommand: async () => undefined,
    },
    Uri: {
        file: (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => p }),
        parse: (s) => ({ fsPath: s, scheme: 'file', path: s, toString: () => s }),
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    EventEmitter: class MockEventEmitter {
        _listeners = [];
        event = (listener) => {
            this._listeners.push(listener);
            return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
        };
        fire(...args) { for (const l of this._listeners) {
            l(...args);
        } }
        dispose() { this._listeners = []; }
    },
    CancellationTokenSource: class MockCts {
        token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => { } }) };
        cancel() { this.token.isCancellationRequested = true; }
        dispose() { }
    },
    Disposable: {
        from: (...disposables) => ({
            dispose: () => { disposables.forEach(d => d.dispose()); }
        }),
    },
    __createMockContext: () => {
        const state = new Map();
        return {
            subscriptions: [],
            globalState: {
                get: (key) => state.get(key),
                update: async (key, value) => { state.set(key, value); },
                keys: () => [...state.keys()],
            },
            workspaceState: {
                get: (key) => state.get(key),
                update: async (key, value) => { state.set(key, value); },
                keys: () => [...state.keys()],
            },
            secrets: {
                get: async () => undefined,
                store: async () => { },
                delete: async () => { },
                onDidChange: () => ({ dispose: () => { } }),
            },
            extensionPath: process.cwd(),
            extensionUri: { fsPath: process.cwd(), scheme: 'file' },
            globalStoragePath: process.cwd(),
            storagePath: process.cwd(),
        };
    },
};
// ── 注入 Module._cache ──
try {
    const resolvedId = require.resolve('vscode');
    Module._cache[resolvedId] = {
        id: resolvedId, filename: resolvedId, loaded: true,
        exports: vscodeMock, children: [], paths: [], path: '',
    };
}
catch (_e) {
    // vscode 不在 node_modules 中（正常情况），使用 _resolveFilename 钩子
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, isMain, options) {
        if (request === 'vscode') {
            return 'vscode-mock-stub';
        }
        return origResolve.call(this, request, parent, isMain, options);
    };
    Module._cache['vscode-mock-stub'] = {
        id: 'vscode-mock-stub', filename: 'vscode-mock-stub', loaded: true,
        exports: vscodeMock, children: [], paths: [], path: '',
    };
}
module.exports = vscodeMock;
