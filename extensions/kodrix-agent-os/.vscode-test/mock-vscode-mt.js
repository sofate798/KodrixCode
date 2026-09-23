'use strict';
const __pool = [{"id":"gpt-4o-mini","name":"GPT-4o mini","family":"gpt-4o-mini"},{"id":"claude-3.5-haiku","name":"Claude 3.5 Haiku","family":"claude-3.5-haiku"},{"id":"copilot-gpt-4-mini","name":"Copilot GPT-4 mini","family":"copilot-gpt-4-mini"}];
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "C:\\Users\\Deto\\AppData\\Local\\Temp\\kodrix-mt-P1dT6I\\ws" } }],
		getConfiguration: (section) => ({
			get: (key, def) => {
				const o = global.__kodrixMtConfig || {};
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
	},
	commands: { registerCommand: (_id, fn) => ({ dispose() {} }), executeCommand: async () => undefined },
	lm: {
		selectChatModels: async ({ family } = {}) => {
			if (!family) return __pool;
			return __pool.filter(m => m.family === family);
		},
	},
	LanguageModelChatMessage: { User: (text) => ({ role: 'user', text }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ThemeIcon: class {},
};
