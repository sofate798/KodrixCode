'use strict';
const __saveCbs = [];
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "C:\\Users\\Deto\\AppData\\Local\\Temp\\kodrix-cp-5mC7ew\\ws" } }],
		textDocuments: global.__kodrixCpDocs,
		getConfiguration: (section) => ({
			get: (key, def) => {
				const o = global.__kodrixCpConfig || {};
				return o[section + '.' + key] ?? def;
			},
		}),
		onDidSaveTextDocument: (cb) => { __saveCbs.push(cb); return { dispose() {} }; },
		openTextDocument: async () => ({ uri: {} }),
	},
	window: {
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
		createQuickPick: () => ({ value: '', items: [], show() {}, hide() {}, dispose() {}, onDidAccept() {}, onDidHide() {}, onDidTriggerButton() {}, onDidChangeValue() {} }),
		showTextDocument: async () => ({}),
	},
	commands: { registerCommand: (_id, fn) => ({ dispose() {} }), executeCommand: async () => undefined },
	lm: { selectChatModels: async () => [] },
	LanguageModelChatMessage: { User: () => ({}) },
	ThemeIcon: class {},
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
};
global.__kodrixCpSaveCbs = __saveCbs;
