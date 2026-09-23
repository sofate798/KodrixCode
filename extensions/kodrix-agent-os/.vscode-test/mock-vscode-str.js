'use strict';
const __pool = [
	{ id: 'gpt-4o-mini', name: 'GPT-4o mini', family: 'gpt-4o-mini',
		async sendRequest() {
			return { stream: (async function* () {
				yield new (require('vscode').LanguageModelTextPart)('后台任务成果已完成调研');
			})() };
		} },
];
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "C:\\Users\\Deto\\AppData\\Local\\Temp\\kodrix-str-gwl5qw\\ws" } }],
		getConfiguration: (section) => ({
			get: (key, def) => {
				const o = global.__kodrixStrConfig || {};
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
	},
	commands: { registerCommand: (_id, fn) => ({ dispose() {} }), executeCommand: async () => undefined },
	lm: {
		selectChatModels: async ({ family } = {}) => {
			if (!family) return __pool;
			return __pool.filter(m => m.family === family);
		},
	},
	languages: { registerInlineCompletionItemProvider: () => ({ dispose() {} }) },
	LanguageModelChatMessage: { User: (text) => ({ role: 'user', text }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ThemeIcon: class {},
};
