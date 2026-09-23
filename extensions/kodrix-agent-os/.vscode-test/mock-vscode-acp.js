'use strict';
module.exports = {
	workspace: { workspaceFolders: [{ uri: { fsPath: "C:\\Users\\Deto\\AppData\\Local\\Temp\\kodrix-acp-dJEHkT\\ws" } }], openTextDocument: async (o) => ({ uri: {}, getText: () => (o && o.content) || '' }) },
	window: {
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		showInformationMessage: async () => undefined,
		showWarningMessage: async (m) => { global.__acpWarning = m; return undefined; },
		showErrorMessage: async () => undefined,
		showQuickPick: async (items) => (items && items.length ? items[0] : undefined),
		showInputBox: async () => '调研 src 目录重复代码',
		showTextDocument: async () => ({}),
	},
	commands: { registerCommand: (_id, fn) => ({ dispose() {}, fn }), executeCommand: async () => undefined },
	Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
	lm: { selectChatModels: async () => [] },
	LanguageModelChatMessage: { User: (t) => ({ role: 'user', text: t }), Assistant: (t) => ({ role: 'assistant', text: t }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ViewColumn: { Active: 1 },
	ThemeIcon: class {},
};
