'use strict';
const __evt = global.__kodrixTermEvents || (global.__kodrixTermEvents = { terminalData: [], shellExec: [] });
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: __dirname } }],
		getConfiguration: () => ({ get: () => true }),
	},
	window: {
		activeTerminal: global.__kodrixActiveTerminal,
		createTerminal: () => global.__kodrixCreatedTerminal,
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		onDidWriteTerminalData: cb => { __evt.terminalData.push(cb); return { dispose() {} }; },
		onDidStartTerminalShellExecution: cb => { __evt.shellExec.push(cb); return { dispose() {} }; },
		showInformationMessage: async () => undefined,
		showInputBox: async () => undefined,
		createQuickPick: () => ({ value: '', items: [], show() {}, hide() {}, dispose() {}, onDidChangeValue() {}, onDidAccept() {}, onDidHide() {}, onDidTriggerButton() {} }),
	},
	commands: { executeCommand: async () => undefined, registerCommand: (_id, fn) => ({ dispose() {} }) },
	lm: { selectChatModels: async () => [] },
	LanguageModelChatMessage: { User: () => ({}) },
	ThemeIcon: class {},
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	Disposable: class {},
};
