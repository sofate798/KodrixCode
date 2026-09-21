/*---------------------------------------------------------------------------------------------
 *  Repo Wiki — Qoder Knowledge Engine 风格
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerInstructionFolders, writeWikiInstructionsFile } from '../context/instructionRegistry';
import { notifyContextChanged } from '../context/contextEvents';
import { recordLearning } from '../learning/learningEngine';
import { ensureDir, getWikiDir } from '../paths';
import { logger } from '../logger';

interface ProjectManifest {
	type: string;
	name: string;
	version?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
}

function readJsonSafe<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
	} catch {
		return undefined;
	}
}

function detectManifest(root: string): ProjectManifest | undefined {
	const pkg = path.join(root, 'package.json');
	if (fs.existsSync(pkg)) {
		const data = readJsonSafe<{ name?: string; version?: string; scripts?: Record<string, string>; dependencies?: Record<string, string> }>(pkg);
		if (data) {
			return { type: 'node', name: data.name || path.basename(root), version: data.version, scripts: data.scripts, dependencies: data.dependencies };
		}
	}
	const pyproject = path.join(root, 'pyproject.toml');
	if (fs.existsSync(pyproject)) {
		return { type: 'python', name: path.basename(root) };
	}
	const goMod = path.join(root, 'go.mod');
	if (fs.existsSync(goMod)) {
		const first = fs.readFileSync(goMod, 'utf-8').split('\n').find(l => l.startsWith('module '));
		return { type: 'go', name: first?.replace('module ', '').trim() || path.basename(root) };
	}
	if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
		return { type: 'rust', name: path.basename(root) };
	}
	return undefined;
}

function listTopLevelDirs(root: string, maxDepth = 2): string[] {
	const results: string[] = [];
	const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.minicode', '__pycache__', '.venv', 'target']);

	function walk(dir: string, depth: number, prefix: string): void {
		if (depth > maxDepth) {
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (!e.isDirectory() || skip.has(e.name) || e.name.startsWith('.')) {
				continue;
			}
			const rel = prefix ? `${prefix}/${e.name}` : e.name;
			results.push(rel);
			walk(path.join(dir, e.name), depth + 1, rel);
		}
	}
	walk(root, 0, '');
	return results.sort();
}

function findEntryPoints(root: string, manifest?: ProjectManifest): string[] {
	const entries: string[] = [];
	const candidates = [
		'src/index.ts', 'src/main.ts', 'src/main.tsx', 'src/App.tsx',
		'index.js', 'main.py', 'app.py', 'main.go', 'src/main.rs',
		'extensions/*/src/extension.ts',
	];
	for (const c of candidates) {
		if (c.includes('*')) {
			continue;
		}
		if (fs.existsSync(path.join(root, c))) {
			entries.push(c);
		}
	}
	if (manifest?.scripts?.main) {
		entries.push(`npm script: ${manifest.scripts.main}`);
	}
	if (manifest?.scripts?.dev) {
		entries.push(`npm script: dev → ${manifest.scripts.dev}`);
	}
	return [...new Set(entries)];
}

// 硬性预算：防止在超大 monorepo 上同步遍历阻塞 extension host
const WIKI_MAX_FILES = 20_000;
const WIKI_MAX_DEPTH = 8;

function countFilesByExt(root: string): { counts: Record<string, number>; truncated: boolean } {
	const counts: Record<string, number> = {};
	const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'target']);
	let seen = 0;
	let truncated = false;

	function walk(dir: string, depth: number): void {
		if (depth > WIKI_MAX_DEPTH || seen >= WIKI_MAX_FILES) {
			if (seen >= WIKI_MAX_FILES) {
				truncated = true;
			}
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (seen >= WIKI_MAX_FILES) {
				truncated = true;
				return;
			}
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (!skip.has(e.name) && !e.name.startsWith('.')) {
					walk(full, depth + 1);
				}
			} else if (e.isFile()) {
				const ext = path.extname(e.name) || '(no ext)';
				counts[ext] = (counts[ext] || 0) + 1;
				seen++;
			}
		}
	}
	walk(root, 0);
	return { counts, truncated };
}

function buildArchitectureMd(root: string, manifest?: ProjectManifest): string {
	const dirs = listTopLevelDirs(root);
	const entries = findEntryPoints(root, manifest);
	const { counts: extCounts, truncated } = countFilesByExt(root);
	const topExts = Object.entries(extCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

	return `# 项目架构

> 由 Minicode Repo Wiki 自动生成 · ${new Date().toISOString().slice(0, 10)}

## 概览

| 属性 | 值 |
|------|-----|
| 项目类型 | ${manifest?.type ?? 'unknown'} |
| 名称 | ${manifest?.name ?? path.basename(root)} |
| 版本 | ${manifest?.version ?? '—'} |

## 目录结构

\`\`\`
${dirs.slice(0, 40).map(d => `${d}/`).join('\n') || '(空)'}
\`\`\`

## 入口点

${entries.length ? entries.map(e => `- \`${e}\``).join('\n') : '- 未检测到常见入口文件'}

## 文件类型分布

${topExts.map(([ext, n]) => `- \`${ext}\`: ${n} 个文件`).join('\n')}${truncated ? `\n\n> 注：文件数超过 ${WIKI_MAX_FILES}，以上为部分统计。` : ''}

## Agent 使用提示

- 修改功能前先阅读 \`MODULES.md\` 定位模块
- 使用 \`#codebase\` 或 \`@file\` 补充上下文
- 复杂功能请创建 Spec：\`Minicode: 新建 Spec\`
`;
}

function buildModulesMd(root: string): string {
	const modules: string[] = [];
	const scanDirs = ['src', 'extensions', 'lib', 'app', 'packages'];

	for (const d of scanDirs) {
		const full = path.join(root, d);
		if (!fs.existsSync(full)) {
			continue;
		}
		const subs = fs.readdirSync(full, { withFileTypes: true })
			.filter(e => e.isDirectory() && !e.name.startsWith('.'))
			.map(e => e.name);
		if (subs.length) {
			modules.push(`## ${d}/\n\n${subs.map(s => `- **${s}** — \`${d}/${s}/\``).join('\n')}`);
		}
	}

	return `# 模块索引

> Repo Wiki · ${new Date().toISOString().slice(0, 10)}

${modules.length ? modules.join('\n\n') : '未检测到标准模块目录（src / extensions / lib）。'}

## 扩展阅读

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 项目架构概览
- [INDEX.md](./INDEX.md) — 快速索引
`;
}

function buildIndexMd(root: string, manifest?: ProjectManifest): string {
	const readme = fs.existsSync(path.join(root, 'README.md'));
	const migration = fs.existsSync(path.join(root, 'MIGRATION.md'));
	const agents = fs.existsSync(path.join(root, 'AGENTS.md'));

	return `# Repo Wiki 索引

> Minicode Agent OS · Qoder Repo Wiki 风格

## 文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 架构概览
- [MODULES.md](./MODULES.md) — 模块索引
${readme ? '- [../../README.md](../../README.md) — 项目 README' : ''}
${migration ? '- [../../MIGRATION.md](../../MIGRATION.md) — 迁移指南' : ''}
${agents ? '- [../../AGENTS.md](../../AGENTS.md) — Agent 说明' : ''}

## 快捷命令

| 命令 | 说明 |
|------|------|
| \`Minicode: 生成 Repo Wiki\` | 重新生成 Wiki |
| \`Minicode: 新建 Spec\` | Kiro 风格 Spec 三件套 |
| \`Minicode: 智能路由\` | 自动选 SOLO/Plan/Agent |
| \`#codebase\` | 语义搜索代码库 |

## 项目信息

- **类型**: ${manifest?.type ?? 'unknown'}
- **名称**: ${manifest?.name ?? path.basename(root)}
- **生成时间**: ${new Date().toLocaleString('zh-CN')}
`;
}

export async function generateRepoWiki(options?: { recordLearning?: boolean }): Promise<string | undefined> {
	const wikiEnabled = vscode.workspace.getConfiguration('minicode.features').get<boolean>('wiki', true);
	if (!wikiEnabled) {
		return undefined;
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showWarningMessage('请先打开工作区文件夹');
		return undefined;
	}

	const root = folder.uri.fsPath;
	const wikiDir = getWikiDir();
	if (!wikiDir) {
		return undefined;
	}

	const manifest = detectManifest(root);

	try {
		ensureDir(wikiDir);
		fs.writeFileSync(path.join(wikiDir, 'ARCHITECTURE.md'), buildArchitectureMd(root, manifest), 'utf-8');
		fs.writeFileSync(path.join(wikiDir, 'MODULES.md'), buildModulesMd(root), 'utf-8');
		fs.writeFileSync(path.join(wikiDir, 'INDEX.md'), buildIndexMd(root, manifest), 'utf-8');
	} catch (err) {
		logger.error('生成 Repo Wiki 写入失败', err);
		vscode.window.showErrorMessage(`生成 Repo Wiki 失败：${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}

	writeWikiInstructionsFile();
	await registerInstructionFolders();
	if (options?.recordLearning !== false) {
		recordLearning(`Repo Wiki 已更新（${manifest?.type ?? 'unknown'} / ${manifest?.name ?? path.basename(root)}）`, {
			source: 'wiki',
			category: 'architecture',
		});
	}
	notifyContextChanged();

	return wikiDir;
}

export async function openRepoWiki(): Promise<void> {
	let wikiDir = getWikiDir();
	if (!wikiDir || !fs.existsSync(path.join(wikiDir, 'INDEX.md'))) {
		await generateRepoWiki();
		wikiDir = getWikiDir();
	}
	if (!wikiDir) {
		vscode.window.showWarningMessage('无法定位 Wiki 目录，请先打开工作区');
		return;
	}
	const indexPath = path.join(wikiDir, 'INDEX.md');
	if (!fs.existsSync(indexPath)) {
		vscode.window.showWarningMessage('Wiki 尚未生成，请运行「Minicode: 生成 Repo Wiki」');
		return;
	}
	const doc = await vscode.workspace.openTextDocument(indexPath);
	await vscode.window.showTextDocument(doc, { preview: false });
}

export function registerWiki(context: vscode.ExtensionContext): void {
	const wikiEnabled = vscode.workspace.getConfiguration('minicode.features').get<boolean>('wiki', true);
	if (!wikiEnabled) {
		return;
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('minicode.wiki.generate', async () => {
			const dir = await generateRepoWiki();
			if (dir) {
				vscode.window.showInformationMessage(`Repo Wiki 已生成：${dir}`);
			}
		}),
		vscode.commands.registerCommand('minicode.wiki.open', () => openRepoWiki()),
	);

	const autoBuild = vscode.workspace.getConfiguration('minicode.features').get<boolean>('wikiAutoBuild', true);
	if (autoBuild && vscode.workspace.workspaceFolders?.length) {
		const autoBuildTimer = setTimeout(() => {
			const wikiDir = getWikiDir();
			if (wikiDir && !fs.existsSync(path.join(wikiDir, 'INDEX.md'))) {
				void generateRepoWiki({ recordLearning: false });
			}
		}, 5000);
		context.subscriptions.push({ dispose: () => clearTimeout(autoBuildTimer) });
	}
}

export function getWikiContextForAgent(): string {
	const wikiDir = getWikiDir();
	if (!wikiDir || !fs.existsSync(wikiDir)) {
		return '';
	}
	const parts: string[] = [];
	for (const file of ['ARCHITECTURE.md', 'MODULES.md']) {
		const p = path.join(wikiDir, file);
		if (fs.existsSync(p)) {
			const content = fs.readFileSync(p, 'utf-8').slice(0, 4000);
			parts.push(`## ${file}\n${content}`);
		}
	}
	return parts.length ? `[Repo Wiki Context]\n${parts.join('\n\n')}` : '';
}
