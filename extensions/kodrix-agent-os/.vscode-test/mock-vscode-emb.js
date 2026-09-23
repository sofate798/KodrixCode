'use strict';
module.exports = {
	workspace: { workspaceFolders: [{ uri: { fsPath: "C:\\Users\\Deto\\AppData\\Local\\Temp\\kodrix-emb-mzyazP\\ws" } }], openTextDocument: async (o) => ({ uri: {}, getText: () => (o && o.content) || '' }) },
	window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }), showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined, showQuickPick: async () => undefined, showInputBox: async () => undefined, showTextDocument: async () => ({}) },
	commands: { registerCommand: (_id, fn) => ({ dispose() {}, fn }), executeCommand: async () => undefined },
	Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
	lm: { selectChatModels: async () => [] },
	LanguageModelChatMessage: { User: (t) => ({ role: 'user', text: t }), Assistant: (t) => ({ role: 'assistant', text: t }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ViewColumn: { Active: 1 },
	ThemeIcon: class {},
	languages: { registerInlineCompletionItemProvider: () => ({ dispose() {} }) },
};
