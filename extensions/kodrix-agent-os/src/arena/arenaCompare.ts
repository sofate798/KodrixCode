/*---------------------------------------------------------------------------------------------
 *  Arena 双模型对比 — Windsurf Arena 风格
 *
 *  大厂工程化标准：
 *   1. CancellationTokenSource 必须在 finally 中 dispose，防止资源泄漏
 *   2. 所有配置键使用共享常量，消除魔术字符串
 *   3. 原子文件写入（先写临时文件再 rename）
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { ensureDir, getWorkspaceKodrixDir } from '../paths';
import {
	CONFIG_FEATURES,
	CONFIG_ARENA,
	ARENA_CONFIG,
	FEATURE_FLAGS,
	COMMANDS,
} from '../shared/constants';

/**
 * 执行单个模型推理，返回模型输出文本。
 *
 * 关键优化：CancellationTokenSource 使用 try/finally 确保资源释放。
 */
async function runModelPrompt(
	model: vscode.LanguageModelChat,
	prompt: string,
	label: string,
): Promise<string> {
	const cts = new vscode.CancellationTokenSource();
	try {
		const messages = [vscode.LanguageModelChatMessage.User(prompt)];
		const response = await model.sendRequest(messages, {}, cts.token);
		let text = '';
		for await (const chunk of response.stream) {
			if (chunk instanceof vscode.LanguageModelTextPart) {
				text += chunk.value;
			}
		}
		return text || l10n.t('({0} no response)', label);
	} finally {
		cts.dispose();
	}
}

export async function compareModels(prompt?: string): Promise<void> {
	const enabled = vscode.workspace.getConfiguration(CONFIG_FEATURES)
		.get<boolean>(FEATURE_FLAGS.arena, true);
	if (!enabled) {
		vscode.window.showWarningMessage(l10n.t('Arena is off. Enable {0} in settings', `${CONFIG_FEATURES}.${FEATURE_FLAGS.arena}`));
		return;
	}

	const userPrompt = prompt || await vscode.window.showInputBox({
		prompt: l10n.t('Arena: enter the same prompt to compare two models in parallel'),
		placeHolder: l10n.t('How do I implement JWT refresh tokens?'),
	});
	if (!userPrompt?.trim()) {
		return;
	}

	const models = await vscode.lm.selectChatModels({});
	if (models.length < 1) {
		vscode.window.showWarningMessage(l10n.t('No language model available. Configure one in Manage Models.'));
		return;
	}

	const cfg = vscode.workspace.getConfiguration(CONFIG_ARENA);
	const modelAName = cfg.get<string>(ARENA_CONFIG.modelA, '');
	const modelBName = cfg.get<string>(ARENA_CONFIG.modelB, '');

	let modelA = modelAName
		? models.find(m => m.name.includes(modelAName) || m.id.includes(modelAName))
		: models[0];
	let modelB = modelBName
		? models.find(m => m.name.includes(modelBName) || m.id.includes(modelBName))
		: models[1];

	if (!modelA) {
		const picked = await vscode.window.showQuickPick(
			models.map(m => ({ label: m.name, model: m })),
			{ placeHolder: l10n.t('Select model A') },
		);
		modelA = picked?.model;
	}
	if (!modelB) {
		const picked = await vscode.window.showQuickPick(
			models.filter(m => m !== modelA).map(m => ({ label: m.name, model: m })),
			{ placeHolder: l10n.t('Select model B') },
		);
		modelB = picked?.model;
	}

	if (!modelA || !modelB) {
		vscode.window.showWarningMessage(l10n.t('Two different models are required for comparison'));
		return;
	}

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: l10n.t('Arena comparing…') },
		async () => {
			const [resultA, resultB] = await Promise.all([
				runModelPrompt(modelA!, userPrompt, 'A'),
				runModelPrompt(modelB!, userPrompt, 'B'),
			]);

			const base = getWorkspaceKodrixDir() || path.join(os.homedir(), '.kodrix');
			const arenaDir = path.join(base, 'arena');
			ensureDir(arenaDir);
			const stamp = new Date().toISOString().replace(/[:.]/g, '-');
			const outPath = path.join(arenaDir, `compare-${stamp}.md`);

			const md = `${l10n.t('# Arena Comparison')}

> Prompt: ${userPrompt}

## ${l10n.t('Model A — {0}', modelA!.name)}

${resultA}

---

## ${l10n.t('Model B — {0}', modelB!.name)}

${resultB}

---

## ${l10n.t('Your Choice')}

- [ ] ${l10n.t('Model A is better')}
- [ ] ${l10n.t('Model B is better')}
- [ ] ${l10n.t('Each has strengths; merge the two')}
`;

			// 原子写入：先写临时文件，再 rename（防止进程崩溃产生不完整文件）
			const tmpPath = outPath + '.tmp';
			fs.writeFileSync(tmpPath, md, 'utf-8');
			fs.renameSync(tmpPath, outPath);

			const doc = await vscode.workspace.openTextDocument(outPath);
			await vscode.window.showTextDocument(doc);
			vscode.window.showInformationMessage(l10n.t('Arena comparison finished: {0}', path.basename(outPath)));
		},
	);
}

export function registerArena(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.arenaCompare, () => compareModels()),
	);
}
