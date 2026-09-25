/*---------------------------------------------------------------------------------------------
 *  Code Lens Provider — Agent 快捷操作入口
 *
 *  在 TypeScript 函数/类/方法上方提供 Optimize · Test · Explain · Show Dependencies · Show Callers
 *  数据源：ProjectIndex（符号表、调用图、依赖图）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { getProjectIndex } from './projectIndexer';
import { SymbolKind } from './types';
import type { CodeSymbol, ProjectIndex } from './types';

// ── 事件触发器（索引变更时刷新 CodeLens） ──

const _onDidChangeCodeLenses = new vscode.EventEmitter<void>();

/** 触发 CodeLens 刷新（索引更新后调用） */
export function fireChange(): void {
	_onDidChangeCodeLenses.fire();
}

// ── CodeLens Provider ──

export class AgentCodeLensProvider implements vscode.CodeLensProvider {
	readonly onDidChangeCodeLenses = _onDidChangeCodeLenses.event;

	provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.CodeLens[] {
		const index = getProjectIndex();
		if (!index) {
			return [];
		}

		const filePath = document.uri.fsPath;
		const fileSymbols = this.getFileSymbols(index, filePath);
		if (!fileSymbols.length) {
			return [];
		}

		const lenses: vscode.CodeLens[] = [];

		for (const sym of fileSymbols) {
			// CodeLens 显示在符号声明行的上方一行
			const lensLine = Math.max(sym.line - 1, 0);
			const range = new vscode.Range(lensLine, 0, lensLine, 0);

			// Optimize / Test / Explain — 对所有函数/方法/类符号可用
			if (this.isCallableSymbol(sym.kind)) {
				lenses.push(new vscode.CodeLens(range, {
					title: `$(zap) ${l10n.t('Optimize')}`,
					command: 'workbench.action.chat.open',
					arguments: [{ query: `@codebase ${l10n.t('优化此函数')} ${sym.name}` }],
				}));

				lenses.push(new vscode.CodeLens(range, {
					title: `$(beaker) ${l10n.t('Test')}`,
					command: 'workbench.action.chat.open',
					arguments: [{ query: `@codebase ${l10n.t('为此函数生成测试')} ${sym.name}` }],
				}));

				lenses.push(new vscode.CodeLens(range, {
					title: `$(info) ${l10n.t('Explain')}`,
					command: 'workbench.action.chat.open',
					arguments: [{ query: `@codebase ${l10n.t('解释此函数')} ${sym.name}` }],
				}));
			}

			// Show Dependencies — 仅文件/模块级符号（无 parentId）
			if (this.isModuleLevelSymbol(sym)) {
				lenses.push(new vscode.CodeLens(range, {
					title: `$(git-compare) ${l10n.t('Show Dependencies')}`,
					command: 'kodrix.codebase.showDependencies',
					arguments: [filePath],
				}));
			}

			// Show Callers — 仅函数/方法
			if (sym.kind === SymbolKind.Function || sym.kind === SymbolKind.Method) {
				lenses.push(new vscode.CodeLens(range, {
					title: `$(call-outgoing) ${l10n.t('Show Callers')}`,
					command: 'kodrix.codebase.showCallers',
					arguments: [sym.id],
				}));
			}
		}

		return lenses;
	}

	/** 获取当前文件的所有符号 */
	private getFileSymbols(index: ProjectIndex, filePath: string): CodeSymbol[] {
		const result: CodeSymbol[] = [];
		for (const sym of Object.values(index.symbols)) {
			if (sym.filePath === filePath) {
				result.push(sym);
			}
		}
		// 按行号排序，保证 CodeLens 顺序稳定
		result.sort((a, b) => a.line - b.line);
		return result;
	}

	/** 是否为可调用的符号类型（函数/方法/类） */
	private isCallableSymbol(kind: SymbolKind): boolean {
		return kind === SymbolKind.Function
			|| kind === SymbolKind.Method
			|| kind === SymbolKind.Class;
	}

	/** 是否为模块级符号（无 parentId，且为文件/命名空间/模块/类/枚举等顶层定义） */
	private isModuleLevelSymbol(sym: CodeSymbol): boolean {
		if (sym.parentId) {
			return false;
		}
		return sym.kind === SymbolKind.Class
			|| sym.kind === SymbolKind.Interface
			|| sym.kind === SymbolKind.Enum
			|| sym.kind === SymbolKind.Namespace
			|| sym.kind === SymbolKind.Module
			|| sym.kind === SymbolKind.Function
			|| sym.kind === SymbolKind.Variable;
	}
}

// ── 辅助命令注册 ──

/** 注册 Show Dependencies / Show Callers 辅助命令 */
export function registerCodeLensCommands(context: vscode.ExtensionContext): void {
	// Show Dependencies — QuickPick 展示文件依赖关系
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.codebase.showDependencies', async (filePath: string) => {
			const index = getProjectIndex();
			if (!index) {
				vscode.window.showWarningMessage(l10n.t('暂无项目索引，无法显示依赖关系'));
				return;
			}

			const deps = index.dependencyGraph[filePath] ?? [];
			const revDeps = index.reverseDependencyGraph[filePath] ?? [];

			if (!deps.length && !revDeps.length) {
				vscode.window.showInformationMessage(l10n.t('该文件无依赖关系'));
				return;
			}

			type DepItem = vscode.QuickPickItem & { filePath?: string };
			const items: DepItem[] = [];

			if (deps.length) {
				items.push({ label: l10n.t('依赖的文件'), kind: vscode.QuickPickItemKind.Separator });
				for (const dep of deps) {
					items.push({
						label: `$(file) ${vscode.workspace.asRelativePath(dep)}`,
						description: l10n.t('此文件导入'),
						filePath: dep,
					});
				}
			}

			if (revDeps.length) {
				items.push({ label: l10n.t('被以下文件依赖'), kind: vscode.QuickPickItemKind.Separator });
				for (const rev of revDeps) {
					items.push({
						label: `$(file) ${vscode.workspace.asRelativePath(rev)}`,
						description: l10n.t('导入了此文件'),
						filePath: rev,
					});
				}
			}

			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: l10n.t('选择文件以打开'),
				title: l10n.t('文件依赖关系'),
			});
			if (picked?.filePath) {
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(picked.filePath));
				await vscode.window.showTextDocument(doc, { preview: true });
			}
		}),
	);

	// Show Callers — QuickPick 展示调用方列表
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.codebase.showCallers', async (symbolId: string) => {
			const index = getProjectIndex();
			if (!index) {
				vscode.window.showWarningMessage(l10n.t('暂无项目索引，无法显示调用方'));
				return;
			}

			const callers = index.calls.filter(c => c.calleeId === symbolId);
			if (!callers.length) {
				const sym = index.symbols[symbolId];
				const name = sym?.name ?? symbolId;
				vscode.window.showInformationMessage(l10n.t('未找到 {0} 的调用方', name));
				return;
			}

			type CallerItem = vscode.QuickPickItem & { callerId?: string; line?: number };
			const items: CallerItem[] = [];

			for (const call of callers) {
				const callerSym = index.symbols[call.callerId];
				const callerName = callerSym?.name ?? call.callerId.split('#').pop() ?? l10n.t('未知');
				const callerFile = callerSym?.filePath ?? call.callerId.split('#')[0] ?? '';
				items.push({
					label: `$(call-outgoing) ${callerName}`,
					description: `${vscode.workspace.asRelativePath(callerFile)}:${call.line}`,
					detail: callerSym?.signature,
					callerId: call.callerId,
					line: call.line,
				});
			}

			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: l10n.t('选择调用方以跳转'),
				title: l10n.t('调用方列表'),
			});
			if (picked?.callerId) {
				const callerSym = index.symbols[picked.callerId];
				if (callerSym) {
					const uri = vscode.Uri.file(callerSym.filePath);
					const pos = new vscode.Position(callerSym.line - 1, callerSym.column - 1);
					await vscode.window.showTextDocument(uri, {
						preview: true,
						selection: new vscode.Range(pos, pos),
					});
				}
			}
		}),
	);
}
