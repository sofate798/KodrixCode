"use strict";
/*---------------------------------------------------------------------------------------------
 *  Repo Wiki — Qoder Knowledge Engine 风格
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
exports.generateRepoWiki = generateRepoWiki;
exports.openRepoWiki = openRepoWiki;
exports.registerWiki = registerWiki;
exports.getWikiContextForAgent = getWikiContextForAgent;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const instructionRegistry_1 = require("../context/instructionRegistry");
const contextEvents_1 = require("../context/contextEvents");
const learningEngine_1 = require("../learning/learningEngine");
const paths_1 = require("../paths");
const logger_1 = require("../logger");
const projectIndexer_1 = require("../codebase/projectIndexer");
const codeSmellDetector_1 = require("./codeSmellDetector");
const fsSafe_1 = require("../utils/fsSafe");
const textFile_1 = require("../utils/textFile");
function readJsonSafe(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    catch {
        return undefined;
    }
}
function detectManifest(root) {
    const pkg = path.join(root, 'package.json');
    if (fs.existsSync(pkg)) {
        const data = readJsonSafe(pkg);
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
function listTopLevelDirs(root, maxDepth = 2) {
    const results = [];
    const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.kodrix', '__pycache__', '.venv', 'target']);
    function walk(dir, depth, prefix) {
        if (depth > maxDepth) {
            return;
        }
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
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
function findEntryPoints(root, manifest) {
    const entries = [];
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
function countFilesByExt(root) {
    const counts = {};
    const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'target']);
    let seen = 0;
    let truncated = false;
    function walk(dir, depth) {
        if (depth > WIKI_MAX_DEPTH || seen >= WIKI_MAX_FILES) {
            if (seen >= WIKI_MAX_FILES) {
                truncated = true;
            }
            return;
        }
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
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
            }
            else if (e.isFile()) {
                const ext = path.extname(e.name) || '(no ext)';
                counts[ext] = (counts[ext] || 0) + 1;
                seen++;
            }
        }
    }
    walk(root, 0);
    return { counts, truncated };
}
function buildArchitectureMd(root, manifest) {
    const dirs = listTopLevelDirs(root);
    const entries = findEntryPoints(root, manifest);
    const { counts: extCounts, truncated } = countFilesByExt(root);
    const topExts = Object.entries(extCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return `# 项目架构

> 由 Kodrix Repo Wiki 自动生成 · ${new Date().toISOString().slice(0, 10)}

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
- 复杂功能请创建 Spec：\`Kodrix: 新建 Spec\`
`;
}
/**
 * 使用 LLM 为各顶层模块生成语义描述（职责、关键 API、依赖关系）。
 * 降级策略：LLM 不可用或调用失败时返回 undefined，调用方保持静态生成。
 */
async function enhanceModulesWithLLM(root, index, token) {
    let models;
    try {
        models = await vscode.lm.selectChatModels({});
    }
    catch {
        return undefined;
    }
    if (!models.length) {
        return undefined;
    }
    const model = models[0];
    // 按顶层目录分组符号和文件
    const moduleMap = new Map();
    for (const filePath of Object.keys(index.files)) {
        const rel = path.relative(root, filePath).replace(/\\/g, '/');
        const topDir = rel.split('/')[0];
        if (!topDir || topDir.startsWith('.')) {
            continue;
        }
        if (!moduleMap.has(topDir)) {
            moduleMap.set(topDir, { files: [], symbols: [], exports: [] });
        }
        const entry = moduleMap.get(topDir);
        entry.files.push(rel);
    }
    for (const sym of Object.values(index.symbols)) {
        const rel = path.relative(root, sym.filePath).replace(/\\/g, '/');
        const topDir = rel.split('/')[0];
        if (!topDir || !moduleMap.has(topDir)) {
            continue;
        }
        const entry = moduleMap.get(topDir);
        entry.symbols.push(sym.name);
        if (sym.exportKind || sym.visibility === 'exported') {
            entry.exports.push(sym.name);
        }
    }
    const results = new Map();
    // 对每个顶层模块构造 prompt 请求 LLM
    for (const [moduleName, data] of moduleMap) {
        if (token.isCancellationRequested) {
            break;
        }
        // 只处理文件数 >= 2 的模块，跳过只有单文件的目录
        if (data.files.length < 2) {
            continue;
        }
        const sampleFiles = data.files.slice(0, 20).join('\n');
        const sampleExports = [...new Set(data.exports)].slice(0, 30).join(', ');
        const prompt = [
            `你是一个代码分析助手。请分析以下项目模块并输出 JSON 格式结果。`,
            ``,
            `模块名: ${moduleName}`,
            `文件列表（部分）:\n${sampleFiles}`,
            `导出符号（部分）: ${sampleExports || '(无)'}`,
            ``,
            `请输出如下 JSON（不要包含其他内容）:`,
            `{`,
            `  "responsibility": "模块职责描述（1-3句话）",`,
            `  "keyExports": ["关键导出API1 — 简述", "关键导出API2 — 简述"],`,
            `  "dependencies": "与其他模块的依赖关系摘要（1-2句话）"`,
            `}`,
        ].join('\n');
        try {
            const cts = new vscode.CancellationTokenSource();
            const timeoutId = setTimeout(() => cts.cancel(), 15_000);
            try {
                const messages = [vscode.LanguageModelChatMessage.User(prompt)];
                const response = await model.sendRequest(messages, {}, cts.token);
                let result = '';
                for await (const chunk of response.stream) {
                    if (chunk instanceof vscode.LanguageModelTextPart) {
                        result += chunk.value;
                    }
                }
                // 尝试解析 JSON
                const jsonMatch = result.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    results.set(moduleName, {
                        name: moduleName,
                        responsibility: parsed.responsibility || '',
                        exports: parsed.keyExports || [],
                        dependencies: parsed.dependencies || '',
                    });
                }
            }
            finally {
                clearTimeout(timeoutId);
            }
        }
        catch (err) {
            logger_1.logger.warn(`[RepoWiki] LLM enhancement failed for module ${moduleName}: ${err instanceof Error ? err.message : String(err)}`);
            // 降级：继续处理下一个模块
        }
    }
    return results.size > 0 ? results : undefined;
}
function buildModulesMd(root, llmDescriptions) {
    const modules = [];
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
            let section = `## ${d}/\n\n`;
            for (const s of subs) {
                const llmDesc = llmDescriptions?.get(s);
                if (llmDesc) {
                    // LLM 增强：输出语义描述
                    section += `### ${s}\n\n`;
                    section += `> ${llmDesc.responsibility}\n\n`;
                    if (llmDesc.exports.length > 0) {
                        section += `**关键 API：**\n`;
                        for (const exp of llmDesc.exports.slice(0, 10)) {
                            section += `- \`${exp}\`\n`;
                        }
                        section += '\n';
                    }
                    if (llmDesc.dependencies) {
                        section += `**依赖关系：** ${llmDesc.dependencies}\n\n`;
                    }
                }
                else {
                    // 降级：保持原有静态目录结构
                    section += `- **${s}** — \`${d}/${s}/\`\n`;
                }
            }
            modules.push(section);
        }
    }
    return `# 模块索引

> Repo Wiki · ${new Date().toISOString().slice(0, 10)}${llmDescriptions ? ' · LLM 语义增强' : ''}

${modules.length ? modules.join('\n\n') : '未检测到标准模块目录（src / extensions / lib）。'}

## 扩展阅读

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 项目架构概览
- [CODE_SMELLS.md](./CODE_SMELLS.md) — Code Smell 分析报告
- [INDEX.md](./INDEX.md) — 快速索引
`;
}
function buildIndexMd(root, manifest) {
    const readme = fs.existsSync(path.join(root, 'README.md'));
    const migration = fs.existsSync(path.join(root, 'MIGRATION.md'));
    const agents = fs.existsSync(path.join(root, 'AGENTS.md'));
    return `# Repo Wiki 索引

> Kodrix Agent OS · Qoder Repo Wiki 风格

## 文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 架构概览
- [MODULES.md](./MODULES.md) — 模块索引
- [CODE_SMELLS.md](./CODE_SMELLS.md) — Code Smell 分析报告
${readme ? '- [../../README.md](../../README.md) — 项目 README' : ''}
${migration ? '- [../../MIGRATION.md](../../MIGRATION.md) — 迁移指南' : ''}
${agents ? '- [../../AGENTS.md](../../AGENTS.md) — Agent 说明' : ''}

## 快捷命令

| 命令 | 说明 |
|------|------|
| \`Kodrix: 生成 Repo Wiki\` | 重新生成 Wiki |
| \`Kodrix: 新建 Spec\` | Kiro 风格 Spec 三件套 |
| \`Kodrix: 智能路由\` | 自动选 Plan/Agent/Ask |
| \`#codebase\` | 语义搜索代码库 |

## 项目信息

- **类型**: ${manifest?.type ?? 'unknown'}
- **名称**: ${manifest?.name ?? path.basename(root)}
- **生成时间**: ${new Date().toLocaleString('zh-CN')}
`;
}
/** 生成单飞：冷启动时 bootstrap 与 wiki 各自的定时器、以及手动命令可能同时触发（实测 2–3 次重复生成） */
let _generateInFlight;
/**
 * 生成 Repo Wiki。
 * - 并发调用共享同一次生成（单飞）
 * - 支持外部取消（`options.token`）：命令层用 withProgress(cancellable) 传入
 */
async function generateRepoWiki(options) {
    if (_generateInFlight) {
        return _generateInFlight;
    }
    _generateInFlight = doGenerateRepoWiki(options).finally(() => { _generateInFlight = undefined; });
    return _generateInFlight;
}
async function doGenerateRepoWiki(options) {
    const wikiEnabled = vscode.workspace.getConfiguration('kodrix.features').get('wiki', true);
    if (!wikiEnabled) {
        return undefined;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('Please open a workspace folder first'));
        return undefined;
    }
    if (options?.token?.isCancellationRequested) {
        logger_1.logger.info('[RepoWiki] 生成已取消');
        return undefined;
    }
    const root = folder.uri.fsPath;
    const wikiDir = (0, paths_1.getWikiDir)();
    if (!wikiDir) {
        return undefined;
    }
    const manifest = detectManifest(root);
    let llmDescriptions;
    // 尝试获取 ProjectIndex 并进行 LLM 语义增强
    let projectIndex;
    try {
        projectIndex = await (0, projectIndexer_1.ensureProjectIndex)();
    }
    catch (err) {
        logger_1.logger.warn(`[RepoWiki] Failed to get project index: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (projectIndex && !options?.token?.isCancellationRequested) {
        // LLM 增强 MODULES.md（带降级策略）
        const cts = new vscode.CancellationTokenSource();
        const llmTimeout = setTimeout(() => cts.cancel(), 60_000);
        // 外部取消 → 一并取消 LLM 增强（此前点了取消仍会跑满 60s）
        const externalSub = options?.token?.onCancellationRequested(() => cts.cancel());
        try {
            llmDescriptions = await enhanceModulesWithLLM(root, projectIndex, cts.token);
            if (llmDescriptions) {
                logger_1.logger.info(`[RepoWiki] LLM enhancement applied to ${llmDescriptions.size} modules`);
            }
        }
        catch (err) {
            logger_1.logger.warn(`[RepoWiki] LLM enhancement failed, falling back to static: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            clearTimeout(llmTimeout);
            externalSub?.dispose();
        }
    }
    if (options?.token?.isCancellationRequested) {
        logger_1.logger.info('[RepoWiki] 生成已取消（写入前）');
        return undefined;
    }
    try {
        (0, paths_1.ensureDir)(wikiDir);
        // 统一走原子写入：同时受"不受信任工作区禁止写工作区文件"闸门约束（此前是裸 fs.writeFileSync，可绕过）
        (0, fsSafe_1.atomicWriteFileSync)(path.join(wikiDir, 'ARCHITECTURE.md'), buildArchitectureMd(root, manifest));
        (0, fsSafe_1.atomicWriteFileSync)(path.join(wikiDir, 'MODULES.md'), buildModulesMd(root, llmDescriptions));
        (0, fsSafe_1.atomicWriteFileSync)(path.join(wikiDir, 'INDEX.md'), buildIndexMd(root, manifest));
        // Code Smell 检测与报告生成
        if (projectIndex && !options?.token?.isCancellationRequested) {
            try {
                const smells = await (0, codeSmellDetector_1.detectCodeSmells)(root, async () => projectIndex);
                const smellReport = (0, codeSmellDetector_1.renderCodeSmellsReport)(smells, root);
                (0, fsSafe_1.atomicWriteFileSync)(path.join(wikiDir, 'CODE_SMELLS.md'), smellReport);
                logger_1.logger.info(`[RepoWiki] Code Smells report generated: ${smells.length} issues found`);
            }
            catch (err) {
                logger_1.logger.warn(`[RepoWiki] Code smell detection failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    catch (err) {
        logger_1.logger.error('生成 Repo Wiki 写入失败', err);
        vscode.window.showErrorMessage(vscode_1.l10n.t('Failed to generate Repo Wiki: {0}', err instanceof Error ? err.message : String(err)));
        return undefined;
    }
    (0, instructionRegistry_1.writeWikiInstructionsFile)();
    await (0, instructionRegistry_1.registerInstructionFolders)();
    if (options?.recordLearning !== false) {
        (0, learningEngine_1.recordLearning)(`Repo Wiki 已更新（${manifest?.type ?? 'unknown'} / ${manifest?.name ?? path.basename(root)}）`, {
            source: 'wiki',
            category: 'architecture',
        });
    }
    (0, contextEvents_1.notifyContextChanged)();
    return wikiDir;
}
async function openRepoWiki() {
    let wikiDir = (0, paths_1.getWikiDir)();
    if (!wikiDir || !fs.existsSync(path.join(wikiDir, 'INDEX.md'))) {
        await generateRepoWiki();
        wikiDir = (0, paths_1.getWikiDir)();
    }
    if (!wikiDir) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('Cannot locate the Wiki directory. Open a workspace first.'));
        return;
    }
    const indexPath = path.join(wikiDir, 'INDEX.md');
    if (!fs.existsSync(indexPath)) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('Wiki has not been generated yet. Run "Kodrix: Generate Repo Wiki"'));
        return;
    }
    const doc = await vscode.workspace.openTextDocument(indexPath);
    await vscode.window.showTextDocument(doc, { preview: false });
}
function registerWiki(context) {
    const wikiEnabled = vscode.workspace.getConfiguration('kodrix.features').get('wiki', true);
    if (!wikiEnabled) {
        return;
    }
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.wiki.generate', async () => {
        // 进度 + 可取消：大仓上 LLM 增强可能跑几十秒，此前只有"开始/结束"两条提示，界面像卡死
        const dir = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode_1.l10n.t('Kodrix: Generating Repo Wiki…'),
            cancellable: true,
        }, async (_progress, token) => generateRepoWiki({ token }));
        if (dir) {
            vscode.window.showInformationMessage(vscode_1.l10n.t('Repo Wiki generated: {0}', dir));
        }
    }), vscode.commands.registerCommand('kodrix.wiki.open', () => openRepoWiki()));
    // 自动生成统一由 workspaceBootstrap 负责（它带"不受信任工作区不预热"的闸门）。
    // 此处曾另有一个 5s 定时器，与 bootstrap 的 4s 定时器在冷启动时并发触发 2 次重复生成。
}
function getWikiContextForAgent() {
    const wikiDir = (0, paths_1.getWikiDir)();
    if (!wikiDir || !fs.existsSync(wikiDir)) {
        return '';
    }
    const parts = [];
    for (const file of ['ARCHITECTURE.md', 'MODULES.md', 'CODE_SMELLS.md']) {
        const p = path.join(wikiDir, file);
        if (fs.existsSync(p)) {
            // 用户可编辑文档：容错 BOM/UTF-16/GBK，单个文件读失败不影响其余 wiki 内容注入
            const content = ((0, textFile_1.readUserTextFileSync)(p) ?? '').slice(0, 4000);
            if (!content.trim()) {
                continue;
            }
            parts.push(`## ${file}\n${content}`);
        }
    }
    return parts.length ? `[Repo Wiki Context]\n${parts.join('\n\n')}` : '';
}
