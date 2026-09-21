/*---------------------------------------------------------------------------------------------
 *  属性测试生成 — Kiro fast-check 风格
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getSpecsDir, ensureDir } from '../paths';

function propertyTestTemplate(moduleName: string, properties: string[]): string {
	return `/**
 * 属性测试 — ${moduleName}
 * 由 Minicode Agent OS 生成（Kiro / fast-check 风格）
 *
 * 运行: npm test 或 npx vitest run
 */
import { describe, it, expect } from 'vitest';
// import fc from 'fast-check';

describe('${moduleName} properties', () => {
${properties.map(p => `\tit('${p}', () => {
\t\t// TODO: 使用 fast-check 验证属性
\t\t// fc.assert(fc.property(fc.string(), (input) => { ... }));
\t\texpect(true).toBe(true);
\t});`).join('\n\n')}
});
`;
}

export async function generatePropertyTests(): Promise<void> {
	const specsDir = getSpecsDir();
	let requirements = '';

	if (specsDir && fs.existsSync(specsDir)) {
		const specs = fs.readdirSync(specsDir, { withFileTypes: true }).filter(d => d.isDirectory());
		if (specs.length) {
			const picked = await vscode.window.showQuickPick(
				specs.map(s => ({ label: s.name })),
				{ placeHolder: '基于 Spec 生成属性测试（可选）' },
			);
			if (picked) {
				const reqPath = path.join(specsDir, picked.label, 'requirements.md');
				if (fs.existsSync(reqPath)) {
					requirements = fs.readFileSync(reqPath, 'utf-8');
				}
			}
		}
	}

	const moduleName = await vscode.window.showInputBox({
		prompt: '模块名称',
		value: 'authService',
	}) || 'module';

	const properties = requirements
		.split('\n')
		.filter(l => l.includes('**当**') || l.includes('**如果**') || l.includes('**在**'))
		.map(l => l.replace(/^-\s*/, '').trim())
		.slice(0, 5);

	if (!properties.length) {
		properties.push(
			'对于任意合法输入，输出应满足类型约束',
			'对于任意非法输入，应抛出错误或返回错误码',
			'同一输入多次调用应产生相同结果（幂等）',
		);
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showWarningMessage('请先打开工作区');
		return;
	}

	const testDir = path.join(folder.uri.fsPath, 'tests', 'property');
	ensureDir(testDir);
	const outPath = path.join(testDir, `${moduleName}.property.test.ts`);
	fs.writeFileSync(outPath, propertyTestTemplate(moduleName, properties), 'utf-8');

	const doc = await vscode.workspace.openTextDocument(outPath);
	await vscode.window.showTextDocument(doc);
	vscode.window.showInformationMessage(
		`属性测试已生成：${outPath}`,
		'Agent 完善测试',
	).then(c => {
		if (c === 'Agent 完善测试') {
			void vscode.commands.executeCommand('workbench.action.chat.open', {
				mode: 'agent',
				query: `请完善 ${outPath} 中的 fast-check 属性测试，基于 Spec 验收标准实现真实断言。`,
				isPartialQuery: false,
			});
		}
	});
}

export function registerPropertyTests(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('minicode.testing.generatePropertyTests', () => generatePropertyTests()),
	);
}
