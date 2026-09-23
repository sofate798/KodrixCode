'use strict';
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "C:\\Users\\Deto\\AppData\\Local\\Temp\\kodrix-ap-9m4DAc\\ws" } }],
		getConfiguration: (section) => ({
			get: (key, def) => {
				const o = global.__kodrixApConfig || {};
				return o[section + '.' + key] ?? def;
			},
		}),
		openTextDocument: async () => ({ uri: {} }),
	},
	window: {
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		showTextDocument: async () => ({}),
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
		createTerminal: () => ({ sendText() {}, show() {}, dispose() {}, exitStatus: undefined, onDidWriteData() {}, onDidClose() {} }),
	},
	commands: { registerCommand: (_id, fn) => ({ dispose() {} }), executeCommand: async () => undefined },
	lm: { selectChatModels: async ({ family } = {}) => { const p = global.__kodrixApPool; return family ? p.filter(m => m.family === family) : p; } },
	LanguageModelChatMessage: { User: (text) => ({ role: 'user', text }), Assistant: (text) => ({ role: 'assistant', text }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ThemeIcon: class {},
};
