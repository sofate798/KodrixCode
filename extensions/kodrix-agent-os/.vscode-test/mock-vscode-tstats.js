'use strict';
class Position { constructor(line, char) { this.line = line; this.character = char; } }
class Range { constructor(s, e) { this.start = s; this.end = e; } }
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "C:\\Users\\Deto\\AppData\\Local\\Temp\\kodrix-tstats-fiWQV0\\ws" } }],
		getConfiguration: () => ({ get: (key, def) => { const v = global.__tstatsConfig[key]; return v === undefined ? def : v; } }),
		openTextDocument: async (o) => { global.__tstatsDocs.push(o.content); return { uri: {}, getText: () => (o && o.content) || '' }; },
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
	commands: { registerCommand: (id, fn) => { global.__tstatsRegistered.push({ id, fn }); return { dispose() {}, fn }; }, executeCommand: async () => undefined },
	Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
	lm: { selectChatModels: async () => [{ id: 'm', name: 'M', vendor: 'v', maxInputTokens: 1000, maxOutputTokens: 1000 }] },
	LanguageModelChatMessage: { User: (t) => ({ role: 'user', text: t }), Assistant: (t) => ({ role: 'assistant', text: t }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ViewColumn: { Active: 1 },
	ThemeIcon: class {},
	Position, Range,
	languages: {
		registerInlineCompletionItemProvider: (_sel, provider) => {
			global.__tstatsProvider.provider = provider;
			return { dispose() {} };
		},
	},
};
