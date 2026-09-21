/*---------------------------------------------------------------------------------------------
 *  Spec 共享工具 — 工作流 + 三栏工作台
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureDir, getSpecsDir } from '../paths';

export const SPEC_FILES = ['requirements.md', 'design.md', 'tasks.md'] as const;
export type SpecFileName = typeof SPEC_FILES[number];

export function slugify(name: string): string {
	const slug = name.toLowerCase()
		.replace(/[^\w\u4e00-\u9fff]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 48);
	// 防御路径穿越：`.`/`..`/含分隔符的结果一律回退为安全默认值
	if (!slug || slug === '.' || slug === '..' || slug.includes('/') || slug.includes('\\')) {
		return 'feature';
	}
	return slug;
}

export function listSpecSlugs(): string[] {
	const specsDir = getSpecsDir();
	if (!specsDir || !fs.existsSync(specsDir)) {
		return [];
	}
	return fs.readdirSync(specsDir, { withFileTypes: true })
		.filter(d => d.isDirectory())
		.map(d => d.name)
		.sort();
}

export function getSpecDir(slug: string): string | undefined {
	const specsDir = getSpecsDir();
	return specsDir ? path.join(specsDir, slug) : undefined;
}

export function readSpecFile(slug: string, file: SpecFileName): string {
	const dir = getSpecDir(slug);
	if (!dir) {
		return '';
	}
	const p = path.join(dir, file);
	return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

export interface SpecBundle {
	slug: string;
	requirements: string;
	design: string;
	tasks: string;
}

export function readSpecBundle(slug: string): SpecBundle {
	return {
		slug,
		requirements: readSpecFile(slug, 'requirements.md'),
		design: readSpecFile(slug, 'design.md'),
		tasks: readSpecFile(slug, 'tasks.md'),
	};
}

export async function pickSpecSlug(placeHolder?: string): Promise<string | undefined> {
	const slugs = listSpecSlugs();
	if (!slugs.length) {
		vscode.window.showWarningMessage('尚无 Spec，请先创建');
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		slugs.map(s => ({ label: s, description: `.minicode/specs/${s}/` })),
		{ placeHolder: placeHolder || '选择 Spec' },
	);
	return picked?.label;
}

export async function openSpecFile(slug: string, file: SpecFileName): Promise<void> {
	const dir = getSpecDir(slug);
	if (!dir) {
		return;
	}
	const p = path.join(dir, file);
	if (!fs.existsSync(p)) {
		vscode.window.showWarningMessage(`文件不存在：${file}`);
		return;
	}
	const doc = await vscode.workspace.openTextDocument(p);
	await vscode.window.showTextDocument(doc, { preview: false });
}

export function requirementsTemplate(feature: string, description: string): string {
	return `# 需求规格 — ${feature}

> Kiro 风格 · EARS 用户故事格式 · 创建于 ${new Date().toISOString().slice(0, 10)}

## 背景

${description}

## 用户故事

### US-1: 核心功能

**作为** 用户  
**我希望** _（描述期望行为）_  
**以便** _（业务价值）_

#### 验收标准（EARS）

- **当** 用户执行 X **则** 系统应 Y
- **如果** 条件 A **则** 系统应 B
- **在** 状态 C 下 **系统应** D

### US-2: 边界情况

**作为** 用户  
**我希望** 系统在异常情况下优雅处理  
**以便** 保证可靠性

#### 验收标准

- **当** 输入无效 **则** 返回明确错误信息
- **当** 网络失败 **则** 支持重试

## 非功能需求

- [ ] 性能：响应时间 < 200ms
- [ ] 安全：输入校验、权限检查
- [ ] 可访问性：键盘导航
- [ ] 测试：单元测试 + 属性测试

## 待澄清问题

- [ ] _（Agent 实施前需确认的问题）_
`;
}

export function designTemplate(feature: string): string {
	return `# 技术设计 — ${feature}

> 创建于 ${new Date().toISOString().slice(0, 10)}

## 架构概览

\`\`\`mermaid
flowchart LR
    UI[UI Layer] --> API[API Layer]
    API --> DB[(Database)]
\`\`\`

## 数据模型

\`\`\`typescript
interface Entity {
  id: string;
  createdAt: Date;
}
\`\`\`

## API 设计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/... | ... |
| POST | /api/... | ... |

## 文件变更计划

| 文件 | 操作 | 说明 |
|------|------|------|
| \`src/...\` | 新建/修改 | ... |

## 依赖与集成

- 内部模块：...
- 外部服务：...

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| ... | ... |
`;
}

export function tasksTemplate(feature: string, slug: string): string {
	return `# 实施任务 — ${feature}

> 创建于 ${new Date().toISOString().slice(0, 10)}

## 任务列表

- [ ] **T1** — 创建数据模型与类型定义
- [ ] **T2** — 实现 API 层
- [ ] **T3** — 实现 UI 组件
- [ ] **T4** — 编写单元测试
- [ ] **T5** — 编写属性测试（\`Minicode: 生成属性测试\`）
- [ ] **T6** — 集成测试与文档更新

## 实施顺序

1. T1 → T2 → T3 → T4 → T5 → T6

## Agent 提示词

\`\`\`
请按照 .minicode/specs/${slug}/ 下的 requirements.md、design.md、tasks.md 实施功能。
\`\`\`
`;
}

export async function createSpecFiles(feature: string, description: string): Promise<string | undefined> {
	const specsDir = getSpecsDir();
	if (!specsDir) {
		vscode.window.showWarningMessage('请先打开工作区');
		return undefined;
	}
	const slug = slugify(feature);
	const specDir = path.join(specsDir, slug);

	// 同名 Spec 已存在时不静默覆盖，先征求用户确认
	if (fs.existsSync(specDir)) {
		const choice = await vscode.window.showWarningMessage(
			`Spec「${slug}」已存在，是否覆盖三件套？`,
			{ modal: true },
			'覆盖',
			'取消',
		);
		if (choice !== '覆盖') {
			return undefined;
		}
	}

	try {
		ensureDir(specDir);
		fs.writeFileSync(path.join(specDir, 'requirements.md'), requirementsTemplate(feature, description), 'utf-8');
		fs.writeFileSync(path.join(specDir, 'design.md'), designTemplate(feature), 'utf-8');
		fs.writeFileSync(path.join(specDir, 'tasks.md'), tasksTemplate(feature, slug), 'utf-8');
		return specDir;
	} catch (err) {
		vscode.window.showErrorMessage(`创建 Spec 失败：${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
}

export async function launchSpecImplementation(specDir: string): Promise<void> {
	const slug = path.basename(specDir);
	const bundle = readSpecBundle(slug);
	const prompt = [
		'【Spec 驱动实施 — Kiro 风格】',
		'请严格按照以下 Spec 文档逐条实施，每完成一个任务在 tasks.md 中标记完成。',
		'实施前先阅读 requirements 的验收标准，确保 design 中的架构一致。',
		`\n## requirements.md\n${bundle.requirements.slice(0, 3000)}`,
		`\n## design.md\n${bundle.design.slice(0, 3000)}`,
		// tasks 同样限长，避免超大 Spec 撑爆 chat query 的 token 上限
		`\n## tasks.md\n${bundle.tasks.slice(0, 4000)}`,
	].join('\n');

	await vscode.commands.executeCommand('workbench.action.chat.open', {
		mode: 'agent',
		query: prompt,
		isPartialQuery: false,
	});
}

