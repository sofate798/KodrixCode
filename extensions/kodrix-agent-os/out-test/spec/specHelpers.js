"use strict";
/*---------------------------------------------------------------------------------------------
 *  Spec 共享工具 — 工作流 + 三栏工作台
 *--------------------------------------------------------------------------------------------*/
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SPEC_FILES = void 0;
exports.slugify = slugify;
exports.listSpecSlugs = listSpecSlugs;
exports.getSpecDir = getSpecDir;
exports.readSpecFile = readSpecFile;
exports.readSpecBundle = readSpecBundle;
exports.pickSpecSlug = pickSpecSlug;
exports.openSpecFile = openSpecFile;
exports.requirementsTemplate = requirementsTemplate;
exports.designTemplate = designTemplate;
exports.tasksTemplate = tasksTemplate;
exports.createSpecFiles = createSpecFiles;
exports.launchSpecImplementation = launchSpecImplementation;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const paths_1 = require("../paths");
exports.SPEC_FILES = ['requirements.md', 'design.md', 'tasks.md'];
function slugify(name) {
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
function listSpecSlugs() {
    const specsDir = (0, paths_1.getSpecsDir)();
    if (!specsDir || !fs.existsSync(specsDir)) {
        return [];
    }
    return fs.readdirSync(specsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
}
function getSpecDir(slug) {
    const specsDir = (0, paths_1.getSpecsDir)();
    return specsDir ? path.join(specsDir, slug) : undefined;
}
function readSpecFile(slug, file) {
    const dir = getSpecDir(slug);
    if (!dir) {
        return '';
    }
    const p = path.join(dir, file);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}
function readSpecBundle(slug) {
    return {
        slug,
        requirements: readSpecFile(slug, 'requirements.md'),
        design: readSpecFile(slug, 'design.md'),
        tasks: readSpecFile(slug, 'tasks.md'),
    };
}
async function pickSpecSlug(placeHolder) {
    const slugs = listSpecSlugs();
    if (!slugs.length) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('尚无 Spec，请先创建'));
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(slugs.map(s => ({ label: s, description: `.kodrix/specs/${s}/` })), { placeHolder: placeHolder || vscode_1.l10n.t('选择 Spec') });
    return picked?.label;
}
async function openSpecFile(slug, file) {
    const dir = getSpecDir(slug);
    if (!dir) {
        return;
    }
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('文件不存在：{0}', file));
        return;
    }
    const doc = await vscode.workspace.openTextDocument(p);
    await vscode.window.showTextDocument(doc, { preview: false });
}
function requirementsTemplate(feature, description) {
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
function designTemplate(feature) {
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
function tasksTemplate(feature, slug) {
    return `# 实施任务 — ${feature}

> 创建于 ${new Date().toISOString().slice(0, 10)}

## 任务列表

- [ ] **T1** — 创建数据模型与类型定义
- [ ] **T2** — 实现 API 层
- [ ] **T3** — 实现 UI 组件
- [ ] **T4** — 编写单元测试
- [ ] **T5** — 编写属性测试（\`Kodrix: 生成属性测试\`）
- [ ] **T6** — 集成测试与文档更新

## 实施顺序

1. T1 → T2 → T3 → T4 → T5 → T6

## Agent 提示词

\`\`\`
请按照 .kodrix/specs/${slug}/ 下的 requirements.md、design.md、tasks.md 实施功能。
\`\`\`
`;
}
async function createSpecFiles(feature, description) {
    const specsDir = (0, paths_1.getSpecsDir)();
    if (!specsDir) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('请先打开工作区'));
        return undefined;
    }
    const slug = slugify(feature);
    const specDir = path.join(specsDir, slug);
    // 同名 Spec 已存在时不静默覆盖，先征求用户确认
    if (fs.existsSync(specDir)) {
        const choice = await vscode.window.showWarningMessage(vscode_1.l10n.t('Spec「{0}」已存在，是否覆盖三件套？', slug), { modal: true }, '覆盖', '取消');
        if (choice !== '覆盖') {
            return undefined;
        }
    }
    try {
        (0, paths_1.ensureDir)(specDir);
        fs.writeFileSync(path.join(specDir, 'requirements.md'), requirementsTemplate(feature, description), 'utf-8');
        fs.writeFileSync(path.join(specDir, 'design.md'), designTemplate(feature), 'utf-8');
        fs.writeFileSync(path.join(specDir, 'tasks.md'), tasksTemplate(feature, slug), 'utf-8');
        return specDir;
    }
    catch (err) {
        vscode.window.showErrorMessage(vscode_1.l10n.t('创建 Spec 失败：{0}', err instanceof Error ? err.message : String(err)));
        return undefined;
    }
}
async function launchSpecImplementation(specDir) {
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
