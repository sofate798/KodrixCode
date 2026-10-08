/*---------------------------------------------------------------------------------------------
 *  属性测试生成 — Kiro fast-check 风格
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { getSpecsDir, ensureDir } from '../paths';
import { FEATURE_FLAGS } from '../shared/constants';
import { isKodrixFeatureEnabled, featureDisabledNotice } from '../utils/featureFlags';

function propertyTestTemplate(moduleName: string, properties: string[]): string {
	return `/**
 * 属性测试 — ${moduleName}
 * 由 Kodrix Agent OS 生成（Kiro / fast-check 风格）
 *
 * 运行: npm test 或 npx vitest run
 */
import { describe, it, expect } from 'vitest';
// import fc from 'fast-check';

describe('${moduleName} properties', () => {
${properties.map(p => `\tit('${p}', () => {
\t\t// 占位断言：本生成器只产出骨架，不引入 fast-check 依赖（避免新增第三方依赖）。
\t\t// 如需真实属性验证，请先接入 fast-check，再替换下面的断言：
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
				{ placeHolder: l10n.t('Generate property-based tests from Spec (optional)') },
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
		prompt: l10n.t('Module name'),
		value: 'authService',
	}) || 'module';

	const properties = requirements
		.split('\n')
		.filter(l => l.includes('**当**') || l.includes('**如果**') || l.includes('**在**'))
		.map(l => l.replace(/^-\s*/, '').trim())
		.slice(0, 5);

	if (!properties.length) {
		properties.push(
			l10n.t('For any valid input, the output should satisfy the type constraints'),
			l10n.t('For any invalid input, an error should be thrown or an error code returned'),
			l10n.t('Calling multiple times with the same input should produce the same result (idempotent)'),
		);
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showWarningMessage(l10n.t('Please open a workspace first'));
		return;
	}

	const testDir = path.join(folder.uri.fsPath, 'tests', 'property');
	ensureDir(testDir);
	const outPath = path.join(testDir, `${moduleName}.property.test.ts`);
	fs.writeFileSync(outPath, propertyTestTemplate(moduleName, properties), 'utf-8');

	const doc = await vscode.workspace.openTextDocument(outPath);
	await vscode.window.showTextDocument(doc);
	const refineWithAgent = l10n.t('Refine tests with Agent');
	vscode.window.showInformationMessage(
		l10n.t('Property tests generated: {0}', outPath),
		refineWithAgent,
	).then(c => {
		if (c === refineWithAgent) {
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
		vscode.commands.registerCommand('kodrix.testing.generatePropertyTests', async () => {
			// 功能开关 kodrix.features.propertyTests（默认开）
			if (!isKodrixFeatureEnabled(FEATURE_FLAGS.propertyTests)) {
				void vscode.window.showWarningMessage(featureDisabledNotice(FEATURE_FLAGS.propertyTests));
				return;
			}
			await generatePropertyTests();
		}),
	);
}
