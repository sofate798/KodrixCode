/*---------------------------------------------------------------------------------------------
 *  Rules Manager — Rules .mdc 多文件体系（对标 Cursor .cursor/rules/*.mdc）
 *
 *  能力：
 *    1. 多文件规则源：.kodrix/rules/*.mdc（Cursor 风格 frontmatter）
 *    2. 自动同步：.mdc → .instructions.md（VS Code 原生指令格式），
 *       写入已注册的 .kodrix/instructions/rules/ 目录，随 Chat 自动注入
 *    3. 三种激活方式（对标 Cursor）：
 *       - globs: 适用文件 glob（如 src 目录下所有 .ts 文件）→ applyTo 对应 glob
 *       - alwaysApply: true     → applyTo: '**'（所有文件）
 *       - 无 globs 也无 alwaysApply → applyTo: '**'（默认全局）
 *    4. /create-rule：AI 根据描述自动生成规则文件（vscode.lm）
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { ensureDir, getWorkspaceKodrixDir } from '../paths';
import { logger } from '../logger';
import { COMMANDS } from '../shared/constants';
import { atomicWriteFileSync } from '../utils/fsSafe';
import { IDEA_FLOW_MODEL_FAMILIES } from '../shared/constants';

// ── 路径 ────────────────────────────────────────────────────────

/** 规则源目录：.kodrix/rules（Cursor 风格 .mdc） */
function getRulesDir(): string | undefined {
	const base = getWorkspaceKodrixDir();
	return base ? path.join(base, 'rules') : undefined;
}

/** 同步产物目录：.kodrix/instructions/rules（已被 chat.instructionsFilesLocations 注册） */
function getRulesInstructionsDir(): string | undefined {
	const base = getWorkspaceKodrixDir();
	return base ? path.join(base, 'instructions', 'rules') : undefined;
}

// ── frontmatter 解析 ────────────────────────────────────────────

export interface RuleMeta {
	description: string;
	globs?: string;
	alwaysApply?: boolean;
}

export interface ParsedRule {
	fileName: string;
	meta: RuleMeta;
	body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 解析 .mdc frontmatter（description / globs / alwaysApply），解析失败视为空 meta */
export function parseRuleFile(content: string): { meta: RuleMeta; body: string } {
	const match = content.match(FRONTMATTER_RE);
	if (!match) {
		return { meta: { description: '' }, body: content.trim() };
	}

	const metaText = match[1];
	const body = content.slice(match[0].length).trim();
	const meta: RuleMeta = { description: '' };

	for (const line of metaText.split('\n')) {
		const m = line.match(/^(\w+):\s*(.*)$/);
		if (!m) continue;
		const key = m[1].trim();
		const value = m[2].trim();
		if (key === 'description') meta.description = value.replace(/^["']|["']$/g, '');
		else if (key === 'globs') meta.globs = value.replace(/^["']|["']$/g, '');
		else if (key === 'alwaysApply') meta.alwaysApply = value.toLowerCase() === 'true';
	}

	return { meta, body };
}

/** 由 meta + body 生成 VS Code 原生 .instructions.md 内容 */
export function ruleToInstructions(meta: RuleMeta, body: string): string {
	const applyTo = meta.alwaysApply || !meta.globs?.trim() ? '**' : meta.globs;
	const description = meta.description
		? meta.description
		: 'Kodrix Agent Rule（自动同步自 .kodrix/rules）';
	return `---
applyTo: '${applyTo}'
description: ${description}
---

${body}
`;
}

// ── 扫描与同步 ──────────────────────────────────────────────────

/** 扫描 rules 源目录中的规则文件（.mdc 与 .instructions.md） */
export function scanRuleFiles(): string[] {
	const dir = getRulesDir();
	if (!dir || !fs.existsSync(dir)) return [];
	try {
		return fs.readdirSync(dir)
			.filter(f => f.endsWith('.mdc') || f.endsWith('.instructions.md'))
			.sort();
	} catch {
		return [];
	}
}

/**
 * 同步 rules 源 → instructions 产物目录。
 * - 生成：每个源文件 → instructions/rules/<name>.instructions.md
 * - 清理：产物目录中已无对应源文件的旧产物
 * - 返回本次同步的文件数
 */
export function syncRulesToInstructions(): number {
	const srcDir = getRulesDir();
	const outDir = getRulesInstructionsDir();
	if (!srcDir || !outDir) return 0;
	if (!fs.existsSync(srcDir)) {
		// 无规则源：清理历史产物（幂等）
		if (fs.existsSync(outDir)) {
			for (const f of fs.readdirSync(outDir)) {
				try { fs.unlinkSync(path.join(outDir, f)); } catch { /* ignore */ }
			}
		}
		return 0;
	}

	ensureDir(outDir);
	const synced: string[] = [];

	for (const fileName of scanRuleFiles()) {
		const srcPath = path.join(srcDir, fileName);
		const baseName = fileName.replace(/\.(mdc|instructions\.md)$/, '');
		const outName = `${baseName}.instructions.md`;
		const outPath = path.join(outDir, outName);
		try {
			const { meta, body } = parseRuleFile(fs.readFileSync(srcPath, 'utf-8'));
			atomicWriteFileSync(outPath, ruleToInstructions(meta, body));
			synced.push(outName);
		} catch (err) {
			logger.warn(`[Rules] sync failed for ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// 清理已删除源文件的产物
	for (const f of fs.readdirSync(outDir)) {
		if (!synced.includes(f)) {
			try { fs.unlinkSync(path.join(outDir, f)); } catch { /* ignore */ }
		}
	}

	return synced.length;
}

/** 查询当前生效的规则清单（供 UI/状态展示） */
export function listActiveRules(): Array<{ name: string; applyTo: string; description: string }> {
	const outDir = getRulesInstructionsDir();
	if (!outDir || !fs.existsSync(outDir)) return [];
	const rules: Array<{ name: string; applyTo: string; description: string }> = [];
	for (const f of fs.readdirSync(outDir).filter(x => x.endsWith('.instructions.md')).sort()) {
		try {
			const { meta } = parseRuleFile(fs.readFileSync(path.join(outDir, f), 'utf-8'));
			rules.push({
				name: f.replace(/\.instructions\.md$/, ''),
				applyTo: meta.alwaysApply || !meta.globs?.trim() ? '**' : meta.globs!,
				description: meta.description || '（无描述）',
			});
		} catch { /* skip corrupt */ }
	}
	return rules;
}

// ── AI 生成规则（对标 Cursor /create-rule） ───────────────────

/** 将用户输入转为安全的文件名 slug */
export function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	return slug || 'rule';
}

async function selectRuleModel(): Promise<vscode.LanguageModelChat | undefined> {
	try {
		for (const family of IDEA_FLOW_MODEL_FAMILIES) {
			try {
				const [found] = await vscode.lm.selectChatModels({ family });
				if (found) return found;
			} catch { continue; }
		}
		const all = await vscode.lm.selectChatModels({});
		return all[0];
	} catch {
		return undefined;
	}
}

const RULE_GENERATION_PROMPT = `你是规则文件生成器。根据用户描述生成 Cursor 风格的规则文件（.mdc）。

格式要求（严格遵守）：
---
description: <一句话说明该规则的用途与生效范围>
globs: <适用的文件 glob，多个用英文逗号分隔，如 "src/**/*.ts,src/**/*.tsx"；若 alwaysApply 为 true 则省略 globs>
alwaysApply: <true 表示对所有文件生效；false 或省略表示仅按 globs 生效>
---

<规则正文>
- 使用 Markdown，简洁可执行
- 以「## Rules」开头
- 每条规则用「-」列表，聚焦具体约束：命名、结构、错误处理、安全、测试等
- 使用中文，避免空话

只输出 .mdc 文件内容本身，不要任何额外说明。`;

/**
 * 创建规则：用户描述 → LLM 生成 .mdc → 写入 rules 目录 → 同步。
 * 无可用模型时降级为手动创建（询问名称与 globs，写入模板文件）。
 */
export async function createRule(): Promise<void> {
	const rulesDir = getRulesDir();
	if (!rulesDir) {
		vscode.window.showWarningMessage(l10n.t('请先打开工作区'));
		return;
	}

	const description = await vscode.window.showInputBox({
		prompt: l10n.t('规则描述（AI 将据此生成规则文件）'),
		placeHolder: l10n.t('例如：React 组件文件必须使用函数组件并导出默认组件'),
	});
	if (!description?.trim()) return;

	ensureDir(rulesDir);
	const model = await selectRuleModel();

	if (!model) {
		// 降级：手动创建模板
		const name = await vscode.window.showInputBox({
			prompt: l10n.t('规则文件名（不含扩展名）'),
			placeHolder: 'react-component-conventions',
			value: slugify(description),
		});
		if (!name?.trim()) return;
		const fileName = `${slugify(name)}.mdc`;
		const content = `---
description: ${description.trim()}
globs: '**/*'
---

## Rules

- ${description.trim()}
`;
		atomicWriteFileSync(path.join(rulesDir, fileName), content);
		const count = syncRulesToInstructions();
		vscode.window.showInformationMessage(l10n.t('规则已创建（手动模板）：{0}，同步 {1} 个指令文件', fileName, count));
		return;
	}

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: l10n.t('AI 生成规则中…'), cancellable: false },
		async () => {
			const cts = new vscode.CancellationTokenSource();
			try {
				const messages = [vscode.LanguageModelChatMessage.User(`${RULE_GENERATION_PROMPT}\n\n用户规则描述：${description.trim()}`)];
				const response = await model.sendRequest(messages, {}, cts.token);
				let content = '';
				for await (const chunk of response.stream) {
					if (chunk instanceof vscode.LanguageModelTextPart) {
						content += chunk.value;
					}
				}
				content = content.trim();
				if (!content) {
					vscode.window.showErrorMessage(l10n.t('AI 未生成有效规则内容'));
					return;
				}

				// 提取文件名：优先用生成内容中的 name，否则用描述 slug
				const nameMatch = content.match(/^name:\s*(.+)$/m);
				const fileName = `${slugify(nameMatch?.[1]?.trim() || description)}.mdc`;
				atomicWriteFileSync(path.join(rulesDir, fileName), content);
				const count = syncRulesToInstructions();
				vscode.window.showInformationMessage(l10n.t('规则已生成：{0}，同步 {1} 个指令文件', fileName, count));
			} catch (err) {
				logger.error('[Rules] createRule failed', err);
				vscode.window.showErrorMessage(l10n.t('规则生成失败：{0}', err instanceof Error ? err.message : String(err)));
			} finally {
				cts.dispose();
			}
		},
	);
}

// ── 注册 ────────────────────────────────────────────────────────

export function registerRules(context: vscode.ExtensionContext): void {
	// 启动时同步一次（幂等）
	try {
		const count = syncRulesToInstructions();
		if (count > 0) {
			logger.info(`[Rules] synced ${count} rule files to instructions`);
		}
	} catch (err) {
		logger.warn('[Rules] initial sync failed', err);
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.rulesCreate, () => { void createRule(); }),
		vscode.commands.registerCommand(COMMANDS.rulesSync, () => {
			const count = syncRulesToInstructions();
			const rules = listActiveRules();
			const lines = [
				'# Kodrix Rules — 生效规则',
				'',
				`> 同步完成：${count} 个规则文件已同步到 Agent 指令`,
				'',
				rules.length
					? [
						'| 规则 | 生效范围 | 说明 |',
						'|------|---------|------|',
						...rules.map(r => `| \`${r.name}\` | \`${r.applyTo}\` | ${r.description} |`),
					].join('\n')
					: '_暂无规则。使用「Kodrix: 创建 Agent 规则」生成第一个规则。_',
				'',
				'## 规则源目录',
				'',
				'- 源文件（Cursor 风格 .mdc）：`.kodrix/rules/`',
				'- 同步产物（VS Code 原生指令）：`.kodrix/instructions/rules/`',
				'- 修改源文件后运行「Kodrix: 同步 Rules 到 Agent 指令」即时生效',
			];
			void vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' })
				.then(doc => vscode.window.showTextDocument(doc, { preview: true }));
		}),
	);

	// 查看生效规则（不触发同步）
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.rulesList, () => {
			const rules = listActiveRules();
			if (!rules.length) {
				void vscode.window.showInformationMessage(l10n.t('暂无生效规则。在 .kodrix/rules/ 下添加 .mdc 文件，或使用「Kodrix: 创建 Agent 规则」'));
				return;
			}
			const lines = [
				'# Kodrix Rules — 生效规则',
				'',
				'| 规则 | 生效范围 | 说明 |',
				'|------|---------|------|',
				...rules.map(r => `| \`${r.name}\` | \`${r.applyTo}\` | ${r.description} |`),
				'',
				`共 ${rules.length} 条规则 · 源目录 .kodrix/rules/ · 注入 .kodrix/instructions/rules/`,
			];
			void vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' })
				.then(doc => vscode.window.showTextDocument(doc, { preview: true }));
		}),
	);
}
