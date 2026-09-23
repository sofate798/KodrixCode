'use strict';
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "C:\\Users\\Deto\\AppData\\Local\\Temp\\kodrix-ai-upgrade-YYVJxg\\ws" } }],
		createFileSystemWatcher: () => ({ onDidCreate: () => ({ dispose(){} }), onDidChange: () => ({ dispose(){} }), onDidDelete: () => ({ dispose(){} }), dispose(){} }),
		getConfiguration: () => ({ get: () => true, update: async () => {} }),
		openTextDocument: async () => ({}),
	},
	window: {
		createOutputChannel: () => ({ appendLine(){}, show(){}, dispose(){} }),
		showWarningMessage: async () => undefined,
		showInformationMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showTextDocument: async () => ({}),
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
		withProgress: async (_opts, fn) => fn(),
	},
	commands: { executeCommand: async () => {} },
	lm: { selectChatModels: async () => [] },
	LanguageModelChatMessage: { User: () => ({}) },
	RelativePattern: class {},
	CancellationTokenSource: class { constructor(){ this.token = {}; } dispose(){} },
};
