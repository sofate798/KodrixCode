'use strict';
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "C:\\Users\\Deto\\AppData\\Local\\Temp\\kodrix-fim-73Bvx6\\ws" } }],
		getConfiguration: () => ({ get: (key, def) => { const v = global.__fimConfig[key]; return v === undefined ? def : v; } }),
		openTextDocument: async (o) => ({ uri: {}, getText: () => (o && o.content) || '' }),
	},
	window: {
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
		showTextDocument: async () => ({}),
	},
	commands: { registerCommand: (_id, fn) => ({ dispose() {}, fn }), executeCommand: async () => undefined },
	Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
	lm: {
		selectChatModels: async () => [{ id: 'mock-fast', name: 'Mock Fast', vendor: 'mock', maxInputTokens: 1000, maxOutputTokens: 1000 }],
	},
	LanguageModelChatMessage: { User: (t) => ({ role: 'user', text: t }), Assistant: (t) => ({ role: 'assistant', text: t }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ViewColumn: { Active: 1 },
	ThemeIcon: class {},
	languages: { registerInlineCompletionItemProvider: () => ({ dispose() {} }) },
};
