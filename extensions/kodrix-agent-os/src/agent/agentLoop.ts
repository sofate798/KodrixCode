/*---------------------------------------------------------------------------------------------
 *  Agent Loop — 端到端 Agent 推理循环（对标 Cursor Agent tool-use loop）
 *
 *  核心能力（本轮最大战略差距）：
 *    1. 自研推理循环：LLM 自主决策下一步 → 调用工具 → 观察结果 → 迭代纠错，直到 [DONE]
 *    2. 工具集（工作区内安全执行）：read_file / write_file / edit_file / list_dir /
 *       search / codebase_search / run_command / complete
 *    3. 结构化协议：模型输出 <tool_call> XML 块，解析器容错提取 name + arguments
 *    4. 收敛控制：maxIterations / 总超时 / CancellationToken 中断 / 错误恢复
 *    5. 完整轨迹：每个迭代的思考、工具调用、工具结果均可追溯（写入 agent-runs/<id>.md）
 *
 *  不依赖上游 Copilot chat agent：全部走 vscode.lm + 自有工具执行器。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getModelCandidates, routeModel, recordModelCall } from '../model/modelRouter';
import { runCommandInTerminal } from '../terminal/terminalAi';
import { logger } from '../logger';
import { assertWorkspaceWriteAllowed } from '../utils/fsSafe';
import { getGrepIndexFiles, ensureGrepIndex } from '../codebase/projectIndexer';
import { loadRuns, pickRun } from './threads';
import type { ApplyProposal, FileChange } from '../apply/applyManager';
import {
	COMMANDS,
	AGENT_LOOP_CONFIG,
	AGENT_LOOP_CONFIG_KEYS,
	AGENT_LOOP_DEFAULT_MAX_ITERATIONS,
	AGENT_LOOP_DEFAULT_TIMEOUT_MS,
	AGENT_LOOP_DEFAULT_CHECKPOINT,
	clampAgentIterations,
	clampAgentTimeoutMs,
	AGENT_RUNS_DIR,
	TOOL_RESULT_MAX_CHARS,
	WORKSPACE_KODRIX_DIR,
} from '../shared/constants';

// ── 类型定义 ────────────────────────────────────────────────────

/** 工具调用（解析后的结构化动作） */
export interface AgentToolCall {
	name: string;
	args: Record<string, unknown>;
	raw: string;
}

/** 工具执行结果 */
export interface AgentToolResult {
	ok: boolean;
	output: string;
	error?: string;
}

/** 工具定义 */
export interface AgentTool {
	name: string;
	description: string;
	execute(args: Record<string, unknown>, session: AgentLoopSession): Promise<AgentToolResult>;
}

/** 循环会话上下文（工具可访问） */
export interface AgentLoopSession {
	workspace: string;
	allowCommands: boolean;
	iterations: number;
	onUpdate?: (phase: string, detail: string) => void;
	/** 取消令牌：贯通到终端命令执行（否则取消只能在"轮次边界"生效，长命令跑完才停） */
	token?: vscode.CancellationToken;
	/** 运行前创建的检查点 id：写文件前把原内容补进该检查点，让"可回滚"名副其实 */
	checkpointId?: string;
}

/** 轨迹步骤 */
export interface AgentTraceStep {
	iteration: number;
	phase: 'thought' | 'tool_call' | 'tool_result' | 'final';
	content: string;
}

/** 循环选项 */
export interface AgentLoopOptions {
	/** 任务描述 */
	task: string;
	/** 工作区根目录（路径安全边界） */
	workspace: string;
	/** 最大迭代轮数 */
	maxIterations?: number;
	/** 总超时（ms） */
	timeoutMs?: number;
	/** 首选模型 family */
	model?: string;
	/** 允许的工具子集（默认全部） */
	tools?: string[];
	/** 进度回调 */
	onUpdate?: (phase: string, detail: string) => void;
	/** 取消令牌 */
	cancellationToken?: vscode.CancellationToken;
	/** 运行前自动创建检查点（默认 true，可回滚 Agent 改动） */
	checkpoint?: boolean;
	/** 会话续聊：基于上次运行结果继续（Threads 简化） */
	resumeFrom?: AgentLoopResult;
	/** 计划模式（Plan）：只读分析、不修改文件/不执行命令/不提变更，输出实施计划（对标 Cursor Plan 模式） */
	planOnly?: boolean;
}

/** 循环结果 */
export interface AgentLoopResult {
	status: 'completed' | 'failed' | 'cancelled' | 'max_iterations';
	output: string;
	trace: AgentTraceStep[];
	iterations: number;
	durationMs: number;
	/** 运行前自动创建的检查点 id（可回滚） */
	checkpointId?: string;
}

// ── 系统提示（工具协议） ─────────────────────────────────────────

export const AGENT_LOOP_SYSTEM_PROMPT = [
	'你是 Kodrix Agent 推理循环（对标 Cursor Agent）。通过反复调用工具自主完成任务：',
	'1. 先分析任务，用工具获取信息（read_file / list_dir / search / codebase_search）',
	'2. 修改代码或生成文件（write_file / edit_file）',
	'3. 必要时运行命令验证（run_command）',
	'4. 完成后输出 [DONE] 并附最终成果',
	'',
	'工具调用协议：每次输出一个或多个 <tool_call> 块，格式如下：',
	'<tool_call>',
	'<name>工具名</name>',
	'<arguments>{"参数":"值"}</arguments>',
	'</tool_call>',
	'',
	'可用工具：',
	'- read_file {"path","startLine?","maxLines?"}：读取文件（带行号，path 相对工作区）',
	'- write_file {"path","content"}：写入/覆盖文件',
	'- edit_file {"path","old","new"}：精确替换，old 必须在文件中唯一匹配',
	'- list_dir {"path"}：列目录（含文件类型）',
	'- search {"query","path?","glob?"}：正则搜索文件内容，返回 命中行',
	'- codebase_search {"query","limit?"}：语义检索代码库（需先构建索引）',
	'- run_command {"command"}：执行终端命令（可验证构建/测试）',
	'- propose_changes {"task","changes":[{filePath,type:write|edit|delete,oldContent,newContent,reason}]}：提出多文件变更提案（不实际修改，用户审查 diff 后确认）',
	'- complete {"summary"}：声明任务完成',
	'',
	'规则：',
	'- 一次输出一个工具调用，等待 <tool_result> 后再决定下一步',
	'- 路径相对工作区根，禁止访问工作区之外',
	'- 编辑失败时读取文件核对内容后重试，不要重复相同错误',
	'- 完成时输出 [DONE] 并附最终成果摘要',
].join('\n');

// ── 路径安全 ─────────────────────────────────────────────────────

/** 将相对路径解析到工作区内（越界返回 undefined） */
export function resolveInWorkspace(relPath: string, workspace: string): string | undefined {
	const resolved = path.resolve(workspace, relPath);
	const wsNorm = path.normalize(workspace);
	if (resolved === wsNorm || resolved.startsWith(wsNorm + path.sep)) {
		return resolved;
	}
	return undefined;
}

/**
 * Agent 写入前的统一闸门：
 *  1) `.git/**` 一律拒绝——改写 git hook/config 等于向用户仓库注入任意代码执行；
 *  2) 不受信任工作区拒绝写工作区文件（复用 fsSafe 的统一闸门，与 wiki/索引/记忆链路一致）。
 * 通过 `resolveInWorkspace` 的路径检查之后调用。
 */
export function assertAgentCanWrite(target: string, workspace: string): void {
	const rel = path.relative(workspace, target).replace(/\\/g, '/');
	if (rel === '.git' || rel.startsWith('.git/')) {
		throw new Error('拒绝写入 .git 目录（改写 git hook/config 会导致任意代码执行）');
	}
	assertWorkspaceWriteAllowed(target);
}

// ── 工具调用解析 ─────────────────────────────────────────────────

const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;

/** 解析模型输出中的工具调用（容错：跳过格式不完整的块） */
export function parseToolCalls(text: string): AgentToolCall[] {
	const calls: AgentToolCall[] = [];
	for (const m of text.matchAll(TOOL_CALL_RE)) {
		const body = m[1];
		const nameM = body.match(/<name>\s*([\w-]+)\s*<\/name>/);
		const argsM = body.match(/<arguments>\s*([\s\S]*?)\s*<\/arguments>/);
		if (!nameM) {
			continue;
		}
		let args: Record<string, unknown> = {};
		if (argsM) {
			try {
				const parsed = JSON.parse(argsM[1]);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					args = parsed as Record<string, unknown>;
				}
			} catch {
				args = { raw: argsM[1] };
			}
		}
		calls.push({ name: nameM[1], args, raw: m[0] });
	}
	return calls;
}

/** 从模型输出中剥离工具调用块（剩余视为思考/最终文本） */
export function stripToolCalls(text: string): string {
	return text
		.replace(TOOL_CALL_RE, '')
		.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
		.replace(/\[DONE\]/g, '')
		.trim();
}

// ── 内置工具 ─────────────────────────────────────────────────────

const READ_DEFAULT_LINES = 200;
/** 单次 read_file 的大小上限：防止误读产物/日志（几十 MB）阻塞扩展宿主并灌爆上下文 */
const READ_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** read_file：读取文件（带行号，截断） */
const readFileTool: AgentTool = {
	name: 'read_file',
	description: '读取文件（带行号）',
	async execute(args, session) {
		const p = resolveInWorkspace(String(args.path ?? ''), session.workspace);
		if (!p) {return { ok: false, output: '路径越界：仅允许工作区内文件' };}
		if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) {return { ok: false, output: `文件不存在或为目录：${args.path}` };}
		try {
			// 大小闸门：此前无条件同步整读，Agent 误读产物/日志（几十 MB）会直接卡住扩展宿主
			const size = fs.statSync(p).size;
			if (size > READ_MAX_FILE_BYTES) {
				return {
					ok: false,
					output: `文件过大（${(size / 1024 / 1024).toFixed(1)} MB，上限 ${(READ_MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} MB）。请改用 search 定位，或对目标文件指定 startLine/maxLines 分段读取。`,
				};
			}
			const buf = fs.readFileSync(p);
			// 二进制检测：把二进制当文本喂给模型既无意义又浪费上下文
			const probeLen = Math.min(buf.length, 8000);
			if (buf.subarray(0, probeLen).includes(0)) {
				return { ok: false, output: `疑似二进制文件（含 NUL 字节），已拒绝按文本读取：${args.path}` };
			}
			const startLine = Math.max(1, Number(args.startLine) || 1);
			const maxLines = Math.max(1, Number(args.maxLines) || READ_DEFAULT_LINES);
			const content = buf.toString('utf-8').split(/\r?\n/);
			const slice = content.slice(startLine - 1, startLine - 1 + maxLines);
			const numbered = slice.map((l, i) => `${String(startLine + i).padStart(4, ' ')} | ${l}`).join('\n');
			const total = content.length;
			const truncated = startLine - 1 + maxLines < total;
			return { ok: true, output: `${args.path}（共 ${total} 行，显示 ${slice.length} 行）\n${numbered}${truncated ? '\n…（文件更长，可用 startLine 续读）' : ''}` };
		} catch (err) {
			return { ok: false, output: `读取失败：${err instanceof Error ? err.message : String(err)}` };
		}
	},
};

/**
 * 写入前把原文件补进检查点。
 * 检查点创建时只快照"已打开的文档"，Agent 新建/修改的文件不在其中 —— 不补这一步，
 * 用户点"回滚"时会发现 Agent 改过的文件没被还原（承诺与能力不符）。
 */
async function snapshotBeforeAgentWrite(session: AgentLoopSession, absPath: string): Promise<void> {
	if (!session.checkpointId) {return;}
	try {
		const { snapshotFilesIntoCheckpoint } = require('../checkpoint/checkpointManager') as typeof import('../checkpoint/checkpointManager');
		await snapshotFilesIntoCheckpoint(session.checkpointId, [absPath]);
	} catch (err) {
		logger.warn('[AgentLoop] 补检查点快照失败（继续写入）', err);
	}
}

/**
 * 同一文件的写入串行化。
 * Subagent 会并行跑多个 Agent 循环，它们可能同时改同一个文件（后写覆盖先写、编辑基于过期内容）；
 * 这里以文件路径为粒度加进程内写锁，保证"读-改-写"整体串行。
 */
const _fileWriteLocks = new Map<string, Promise<void>>();

async function withFileWriteLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
	const key = filePath.toLowerCase();
	const prev = _fileWriteLocks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const chained = prev.then(() => gate);
	_fileWriteLocks.set(key, chained);
	await prev;
	try {
		return await fn();
	} finally {
		release();
		// 只清理自己那一环，避免把后来者的锁删掉
		if (_fileWriteLocks.get(key) === chained) {_fileWriteLocks.delete(key);}
	}
}

/**
 * 截断工具输出并**显式标注**。
 * 静默截断会让模型把"看到的部分"当成全部（例如把被截断的测试输出误判为通过），
 * 所以必须把"原文多少字符、只给了多少"写进结果里。
 */
export function truncateToolResult(text: string, max: number = TOOL_RESULT_MAX_CHARS): string {
	if (text.length <= max) {return text;}
	return `${text.slice(0, max)}\n…[结果已截断：原文 ${text.length} 字符，仅提供前 ${max} 字符。如需更多请缩小范围或用 startLine/maxLines 分段读取]`;
}

/**
 * 按"本次实际可用的工具"过滤系统提示里的工具说明行。
 * plan 模式下工具集被裁剪为只读，但提示词仍会列出 write_file/run_command，
 * 模型于是反复尝试被禁用的工具（浪费轮次，还会输出与事实相反的措辞）。
 * 规则：`- <ascii 工具名> …` 形式且不在可用集合里的行被移除；协议/规则行原样保留。
 */
export function filterToolDocsForActiveTools(prompt: string, activeToolNames: Iterable<string>): string {
	const allowed = new Set(activeToolNames);
	return prompt
		.split('\n')
		.filter(line => {
			const m = /^-\s+([a-z_]+)\s/.exec(line);
			return !m || allowed.has(m[1]);
		})
		.join('\n');
}

/** write_file：写入/覆盖文件 */
const writeFileTool: AgentTool = {
	name: 'write_file',
	description: '写入/覆盖文件',
	async execute(args, session) {
		const p = resolveInWorkspace(String(args.path ?? ''), session.workspace);
		if (!p) {return { ok: false, output: '路径越界：仅允许工作区内文件' };}
		const content = String(args.content ?? '');
		try {
			assertAgentCanWrite(p, session.workspace);
			return await withFileWriteLock(p, async () => {
				await snapshotBeforeAgentWrite(session, p);
				fs.mkdirSync(path.dirname(p), { recursive: true });
				fs.writeFileSync(p, content, 'utf-8');
				return { ok: true, output: `已写入 ${args.path}（${content.length} 字符）` };
			});
		} catch (err) {
			return { ok: false, output: `写入失败：${err instanceof Error ? err.message : String(err)}` };
		}
	},
};

/** edit_file：精确替换（old 必须唯一匹配） */
const editFileTool: AgentTool = {
	name: 'edit_file',
	description: '精确替换文件内容',
	async execute(args, session) {
		const p = resolveInWorkspace(String(args.path ?? ''), session.workspace);
		if (!p) {return { ok: false, output: '路径越界：仅允许工作区内文件' };}
		const oldText = String(args.old ?? '');
		const newText = String(args.new ?? '');
		if (!oldText) {return { ok: false, output: 'old 不能为空' };}
		if (!fs.existsSync(p)) {return { ok: false, output: `文件不存在：${args.path}` };}
		try {
			// 读-改-写整体加锁：并行子 Agent 同时编辑同一文件时，
			// 不加锁会出现"基于过期内容做替换 → 覆盖对方的修改"
			return await withFileWriteLock(p, async () => {
				const content = fs.readFileSync(p, 'utf-8');
				const count = content.split(oldText).length - 1;
				if (count === 0) {return { ok: false, output: `未找到匹配文本（${args.path}）。请先 read_file 核对内容。` };}
				if (count > 1) {return { ok: false, output: `匹配 ${count} 处，old 必须唯一。请扩大上下文。` };}
				assertAgentCanWrite(p, session.workspace);
				await snapshotBeforeAgentWrite(session, p);
				fs.writeFileSync(p, content.replace(oldText, newText), 'utf-8');
				return { ok: true, output: `已编辑 ${args.path}：替换 1 处（${oldText.length} → ${newText.length} 字符）` };
			});
		} catch (err) {
			return { ok: false, output: `编辑失败：${err instanceof Error ? err.message : String(err)}` };
		}
	},
};

/**
 * glob → 正则（支持 `*`、`**`、`?`）。导出以便单测。
 * `**\/` 匹配零层或多层目录，因此 `src/**\/*.ts` 能匹配 `src/a.ts` 与 `src/x/y.ts`。
 *
 * 注意：必须先替换 `**`/`**\/` 为占位符，最后再还原 —— 否则后续的 `*` → `[^/]*`
 * 会把刚引入的 `.*`、`(?:` 等元字符一并改写掉（实测会得到 `([^/]:.[^/]*)` 这种废正则）。
 */
export function compileSearchGlob(glob: string): RegExp {
	const DS_SLASH = '\u0001DSS\u0001';
	const DS = '\u0001DS\u0001';
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*\//g, DS_SLASH)
		.replace(/\*\*/g, DS)
		.replace(/\*/g, '[^/]*')
		.replace(/\?/g, '[^/]')
		.replace(new RegExp(DS_SLASH, 'g'), '(?:.*/)?')
		.replace(new RegExp(DS, 'g'), '.*');
	return new RegExp(`^${escaped}$`, 'i');
}

/** list_dir：列目录 */
const listDirTool: AgentTool = {	name: 'list_dir',
	description: '列出目录内容',
	async execute(args, session) {
		const p = resolveInWorkspace(String(args.path ?? '.'), session.workspace);
		if (!p) {return { ok: false, output: '路径越界' };}
		if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {return { ok: false, output: `目录不存在：${args.path ?? '.'}` };}
		try {
			const entries = fs.readdirSync(p, { withFileTypes: true });
			const lines = entries.map(e => `${e.isDirectory() ? '[dir] ' : '      '}${e.name}`).slice(0, 200);
			if (entries.length > 200) {lines.push(`…（共 ${entries.length} 项）`);}
			return { ok: true, output: `${args.path ?? '.'}（${entries.length} 项）\n${lines.join('\n')}` };
		} catch (err) {
			return { ok: false, output: `列目录失败：${err instanceof Error ? err.message : String(err)}` };
		}
	},
};

/** search：正则搜索文件内容 */
const searchTool: AgentTool = {
	name: 'search',
	description: '正则搜索文件内容',
	async execute(args, session) {
		const query = String(args.query ?? '');
		if (!query) {return { ok: false, output: 'query 不能为空' };}
		const startPath = args.path ? resolveInWorkspace(String(args.path), session.workspace) : session.workspace;
		if (!startPath) {return { ok: false, output: '路径越界' };}
		const glob = String(args.glob ?? '').replace(/\\/g, '/');
		// 用真正的 glob → 正则转换（此前手写的 endsWith 分支对 `src/**/*.ts` 永不命中，
		// 模型据此误判"代码里没有该实现"）
		const globRe = glob ? compileSearchGlob(glob) : undefined;
		const matchGlob = (fileName: string, relPosix: string): boolean => {
			if (!globRe) {return true;}
			if (globRe.test(relPosix)) {return true;}
			// 不带路径分隔符的模式（如 `*.ts`）允许只匹配文件名
			return !glob.includes('/') && globRe.test(fileName);
		};
		try {
			const re = new RegExp(query, 'i');
			const hits: string[] = [];
			const MAX_HITS = 50;
			const MAX_FILES_SCANNED = 5000;
			const MAX_FILE_BYTES = 2 * 1024 * 1024;

			// 候选文件：优先用「即时 Grep 索引」的落盘清单（这就是该功能的真实消费者），
			// 没有索引时按需构建一次；构建失败再退回目录遍历。
			let candidates: string[] = [];
			let usedIndex = false;
			try {
				const indexed = getGrepIndexFiles();
				if (indexed.length) {
					candidates = indexed;
					usedIndex = true;
				} else {
					const built = await ensureGrepIndex();
					if (built.length) {
						candidates = built;
						usedIndex = true;
					}
				}
			} catch (err) {
				logger.warn(`[AgentLoop] grep 索引不可用，退回目录遍历：${err instanceof Error ? err.message : String(err)}`);
			}

			if (candidates.length) {
				const rootRel = path.relative(session.workspace, startPath).replace(/\\/g, '/');
				let scanned = 0;
				for (const rel of candidates) {
					if (hits.length >= MAX_HITS || scanned >= MAX_FILES_SCANNED) {break;}
					if (session.token?.isCancellationRequested) {break;}
					const relPosix = rel.replace(/\\/g, '/');
					if (rootRel && rootRel !== '.' && !relPosix.startsWith(rootRel + '/')) {continue;}
					const fileName = relPosix.split('/').pop() ?? relPosix;
					if (!matchGlob(fileName, relPosix)) {continue;}
					const full = path.join(session.workspace, rel);
					try {
						const stat = fs.statSync(full);
						if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {continue;}
						scanned++;
						const lines = fs.readFileSync(full, 'utf-8').split(/\r?\n/);
						for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
							if (re.test(lines[i])) {
								hits.push(`${relPosix}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
							}
						}
					} catch { /* 文件已删除或不可读：跳过 */ }
					// 每 200 个文件让出一次事件循环，避免长搜索阻塞扩展宿主
					if (scanned % 200 === 0) {
						await new Promise<void>(resolve => setImmediate(resolve));
					}
				}
			} else {
				const SKIP = new Set(['node_modules', '.git', 'out', 'out-build', '.build', '.kodrix']);
				const walk = (dir: string, depth: number) => {
					if (depth > 6 || hits.length >= MAX_HITS) {return;}
					let entries;
					try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
					for (const e of entries) {
						if (SKIP.has(e.name)) {continue;}
						const full = path.join(dir, e.name);
						if (e.isDirectory()) {walk(full, depth + 1);}
						else if (e.isFile()) {
							const rel = path.relative(session.workspace, full).replace(/\\/g, '/');
							if (!matchGlob(e.name, rel)) {continue;}
							try {
								const stat = fs.statSync(full);
								if (stat.size > MAX_FILE_BYTES) {continue;}
								const lines = fs.readFileSync(full, 'utf-8').split(/\r?\n/);
								lines.forEach((l, i) => {
									if (re.test(l) && hits.length < MAX_HITS) {
										hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 120)}`);
									}
								});
							} catch { /* skip unreadable */ }
						}
					}
				};
				walk(startPath, 0);
			}

			if (!hits.length) {
				return { ok: true, output: `无命中${usedIndex ? '（已用仓库文本索引扫描，可先运行「Kodrix: 重建索引」刷新清单）' : ''}` };
			}
			return { ok: true, output: `命中 ${hits.length} 处${usedIndex ? '（基于仓库文本索引）' : ''}：\n${hits.join('\n')}` };
		} catch (err) {
			return { ok: false, output: `搜索失败：${err instanceof Error ? err.message : String(err)}` };
		}
	},
};

/** codebase_search：语义检索代码库（优先内存索引，避免每次全量读盘） */
const codebaseSearchTool: AgentTool = {
	name: 'codebase_search',
	description: '语义检索代码库（需先构建索引）',
	async execute(args, session) {
		const query = String(args.query ?? '');
		if (!query) {return { ok: false, output: 'query 不能为空' };}
		try {
			const { searchSymbolsAsync, searchFilesAsync } = require('../codebase/semanticIndex') as typeof import('../codebase/semanticIndex');
			const { getProjectIndex, ensureProjectIndex } = require('../codebase/projectIndexer') as typeof import('../codebase/projectIndexer');
			let index = getProjectIndex();
			if (!index) {
				try {
					index = await ensureProjectIndex(false);
				} catch {
					return { ok: false, output: '代码库索引未构建。请先运行「Kodrix: 构建代码库索引」后重试。' };
				}
			}
			const limit = Math.min(20, Number(args.limit) || 8);
			const syms = await searchSymbolsAsync(index, query, limit);
			const files = await searchFilesAsync(index, query, Math.min(limit, 5));
			const seen = new Set<string>();
			const lines: string[] = [];
			for (const s of syms) {
				const fp = s.symbol.filePath;
				const key = `${fp}::${s.symbol.name}`;
				if (seen.has(key)) {continue;}
				seen.add(key);
				lines.push(`  ${path.relative(session.workspace, fp)} :: ${s.symbol.name} (score ${s.score.toFixed(3)})`);
				if (lines.length >= limit) {break;}
			}
			for (const f of files) {
				if (lines.length >= limit) {break;}
				if (seen.has(f.filePath)) {continue;}
				seen.add(f.filePath);
				lines.push(`  ${path.relative(session.workspace, f.filePath)} (文件命中 ${f.score.toFixed(3)})`);
			}
			if (!lines.length) {
				return { ok: true, output: '语义检索无命中（可换关键词或构建索引后重试）' };
			}
			return { ok: true, output: `语义命中 ${lines.length} 项：\n${lines.join('\n')}` };
		} catch (err) {
			return { ok: false, output: `语义检索失败：${err instanceof Error ? err.message : String(err)}` };
		}
	},
};

/** run_command：执行终端命令（复用 runCommandInTerminal 封装） */
const runCommandTool: AgentTool = {
	name: 'run_command',
	description: '执行终端命令',
	async execute(args, session) {
		if (!session.allowCommands) {return { ok: false, output: '命令执行已禁用（kodrix.agentLoop.allowCommands=false）' };}
		const command = String(args.command ?? '');
		if (!command.trim()) {return { ok: false, output: 'command 不能为空' };}
		try {
			// 传入取消令牌：用户在运行中取消时，命令会被 Ctrl+C 中断（否则会继续跑完）
			const res = await runCommandInTerminal(command, { timeoutMs: 60000, token: session.token });
			const out = truncateToolResult(res.output || '');
			if (res.cancelled) {
				return { ok: false, output: `命令已取消（已向终端发送 Ctrl+C）\n${out}` };
			}
			if (res.timedOut) {
				return { ok: false, output: `命令超时（60s，已向终端发送 Ctrl+C）\n${out}` };
			}
			// 无 shell integration：退出码不可靠，按「尽力捕获」返回，勿判失败
			if (res.incomplete || res.exitCode === undefined) {
				return { ok: true, output: `exit=unknown（无可靠退出码，命令可能仍在运行）\n${out}` };
			}
			return { ok: res.exitCode === 0, output: `exit=${res.exitCode}\n${out}` };
		} catch (err) {
			return { ok: false, output: `命令执行失败：${err instanceof Error ? err.message : String(err)}` };
		}
	},
};

/** propose_changes：提出多文件变更提案（写 .kodrix/apply/，不实际修改，供用户审查） */
const proposeChangesTool: AgentTool = {
	name: 'propose_changes',
	description: '提出多文件变更提案（不实际修改）',
	async execute(args, session) {
		const rawChanges = Array.isArray(args.changes) ? args.changes : [];
		if (!rawChanges.length) {return { ok: false, output: 'changes 不能为空数组' };}
		const changes: FileChange[] = rawChanges
			.map(c => {
				const r = c as Record<string, unknown>;
				return {
					filePath: String(r.filePath ?? ''),
					type: (r.type === 'edit' || r.type === 'delete' ? r.type : 'write') as FileChange['type'],
					oldContent: r.oldContent ? String(r.oldContent) : undefined,
					newContent: String(r.newContent ?? ''),
					reason: r.reason ? String(r.reason) : undefined,
				};
			})
			.filter(c => c.filePath.trim().length > 0);
		if (!changes.length) {return { ok: false, output: '未解析到有效变更（每项需 filePath）' };}
		// 校验全部变更
		const { validateChange } = require('../apply/applyManager') as typeof import('../apply/applyManager');
		const bad = changes.filter(c => !validateChange(c, session.workspace).ok);
		if (bad.length) {
			return {
				ok: false,
				output: '以下变更校验失败：\n' + bad.map(c => `- ${c.filePath}: ${validateChange(c, session.workspace).error}`).join('\n'),
			};
		}
		// 写提案
		const name = `agent-${new Date().toISOString().replace(/[:.]/g, '-')}`;
		const proposal: ApplyProposal = { name, task: String(args.task ?? ''), createdAt: new Date().toISOString(), changes };
		const { saveProposal } = require('../apply/applyManager') as typeof import('../apply/applyManager');
		const file = saveProposal(session.workspace, proposal);
		return {
			ok: true,
			output: `提案已生成：${path.relative(session.workspace, file)}（${changes.length} 个文件）\n运行「Kodrix: 预览变更提案」审查 diff，确认后「Kodrix: 应用变更提案」`,
		};
	},
};

/** complete：声明任务完成 */
const completeTool: AgentTool = {
	name: 'complete',
	description: '声明任务完成',
	async execute(args) {
		return { ok: true, output: String(args.summary ?? '任务完成') };
	},
};

/** 默认工具集 */
export const DEFAULT_TOOLS: AgentTool[] = [
	readFileTool,
	writeFileTool,
	editFileTool,
	listDirTool,
	searchTool,
	codebaseSearchTool,
	runCommandTool,
	proposeChangesTool,
	completeTool,
];

// ── 核心推理循环 ─────────────────────────────────────────────────

/**
 * 运行端到端 Agent 推理循环。
 * 每轮：LLM 输出 → 解析工具调用 → 无调用视为完成 → 执行工具 → 结果回填 → 下一轮。
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
	const start = Date.now();
	const maxIterations = clampAgentIterations(opts.maxIterations
		?? vscode.workspace.getConfiguration(AGENT_LOOP_CONFIG).get<number>(AGENT_LOOP_CONFIG_KEYS.maxIterations, AGENT_LOOP_DEFAULT_MAX_ITERATIONS));
	const timeoutMs = clampAgentTimeoutMs(opts.timeoutMs
		?? vscode.workspace.getConfiguration(AGENT_LOOP_CONFIG).get<number>(AGENT_LOOP_CONFIG_KEYS.timeoutMs, AGENT_LOOP_DEFAULT_TIMEOUT_MS));
	const allowCommands = vscode.workspace.getConfiguration(AGENT_LOOP_CONFIG)
		.get<boolean>(AGENT_LOOP_CONFIG_KEYS.allowCommands, true);

	// planOnly：只读工具集（read/list_dir/search/codebase_search）+ complete，禁止写/改/执行/提案
	const READONLY_TOOLS = new Set(['read_file', 'list_dir', 'search', 'codebase_search']);
	// 不受信任工作区：与 planOnly 同样降级为只读（写文件/改文件/执行命令/提案全部移除），
	// 与 package.json 的 untrustedWorkspaces=limited 声明一致；写工具内部还有 assertAgentCanWrite 兜底。
	const untrustedWorkspace = vscode.workspace.isTrusted === false;
	const tools = (opts.tools?.length
		? DEFAULT_TOOLS.filter(t => opts.tools!.includes(t.name))
		: DEFAULT_TOOLS)
		.filter(t => !opts.planOnly || READONLY_TOOLS.has(t.name) || t.name === 'complete')
		.filter(t => !untrustedWorkspace || READONLY_TOOLS.has(t.name) || t.name === 'complete');
	if (untrustedWorkspace) {
		logger.warn('[AgentLoop] 工作区未受信任：本次运行降级为只读工具集');
	}
	const session: AgentLoopSession = {
		workspace: opts.workspace,
		allowCommands,
		iterations: 0,
		onUpdate: opts.onUpdate,
		// 让工具层也能感知取消（终端命令执行会据此发 Ctrl+C）
		token: opts.cancellationToken,
	};

	const trace: AgentTraceStep[] = [];
	let finalText = '';
	let status: AgentLoopResult['status'] = 'completed';
	/** 是否成功执行过至少一个工具：用于区分「模型给完答案收尾」与「模型根本没按协议调用工具」 */
	let usedAnyTool = false;

	const routed = await routeModel({ preferred: opts.model, taskType: 'coding' });
	if (!routed) {
		return { status: 'failed', output: l10n.t('No language model available (configure a BYOK model in Manage Models)'), trace, iterations: 0, durationMs: Date.now() - start };
	}
	// 模型候选列表（故障转移：失败自动降级下一个可用模型）
	const candidates = await getModelCandidates({ preferred: opts.model, taskType: 'coding' });
	if (!candidates.length) {
		return { status: 'failed', output: l10n.t('No language model available (configure a BYOK model in Manage Models)'), trace, iterations: 0, durationMs: Date.now() - start };
	}
	const routedIdx = candidates.findIndex(c => c.model.id === routed.model.id);
	if (routedIdx > 0) {
		const [r] = candidates.splice(routedIdx, 1);
		candidates.unshift(r);
	}

	// 运行前自动创建检查点（可回滚 Agent 造成的全部改动）
	let checkpointId: string | undefined;
	const checkpointEnabled = opts.checkpoint ?? vscode.workspace.getConfiguration(AGENT_LOOP_CONFIG)
		.get<boolean>(AGENT_LOOP_CONFIG_KEYS.checkpoint, AGENT_LOOP_DEFAULT_CHECKPOINT);
	if (checkpointEnabled) {
		try {
			const { createCheckpoint } = require('../checkpoint/checkpointManager') as typeof import('../checkpoint/checkpointManager');
			checkpointId = await createCheckpoint(`Agent: ${opts.task.slice(0, 60)}`);
			// 交给工具层：写文件前把原内容补进检查点（否则"可回滚全部改动"只覆盖已打开的文档）
			session.checkpointId = checkpointId;
		} catch (err) {
			logger.warn('[AgentLoop] 创建检查点失败（继续运行）', err);
		}
	}

	const messages: vscode.LanguageModelChatMessage[] = [];
	if (opts.resumeFrom) {
		messages.push(vscode.LanguageModelChatMessage.User(`【历史会话上下文（续聊）】\n${buildHistoryContext(opts.resumeFrom)}`));
	}
	const modeNote = opts.planOnly
		? '【模式】计划模式（Plan）：只读分析代码库，禁止修改文件、执行命令或提出变更提案；输出详细、可执行的实施计划后用 complete 结束。\n\n'
		: '';
	// 只列出**本次实际可用**的工具（plan 模式裁剪后不再宣传写/执行工具）
	const toolDocs = filterToolDocsForActiveTools(AGENT_LOOP_SYSTEM_PROMPT, tools.map(t => t.name));
	messages.push(vscode.LanguageModelChatMessage.User(`${toolDocs}\n\n${modeNote}【任务】${opts.task}`));

	const isCancelled = () => opts.cancellationToken?.isCancellationRequested === true;
	const elapsed = () => Date.now() - start;

	outer: for (let i = 1; i <= maxIterations; i++) {
		session.iterations = i;
		opts.onUpdate?.('thinking', l10n.t('Reasoning round {0}', i));

		if (isCancelled()) {
			status = 'cancelled';
			break;
		}
		if (elapsed() > timeoutMs) {
			status = 'failed';
			trace.push({ iteration: i, phase: 'final', content: l10n.t('Total timeout ({0}ms)', String(timeoutMs)) });
			break;
		}

		// 1) LLM 决策（带模型故障转移：失败自动降级下一个候选）
		let text = '';
		let llmOk = false;
		for (let ai = 0; ai < candidates.length; ai++) {
			const m = candidates[ai];
			const cts = new vscode.CancellationTokenSource();
			// 请求级超时：剩余总预算（至少 5s），避免模型挂起时 timeoutMs 形同虚设
			const requestTimeoutMs = Math.max(5_000, timeoutMs - elapsed());
			const reqTimer = setTimeout(() => cts.cancel(), requestTimeoutMs);
			const parentCancel = opts.cancellationToken?.onCancellationRequested(() => cts.cancel());
			// 单次调用的真实耗时：此前传入循环起始时间，导致"平均耗时"随轮次线性膨胀（统计错位）
			const callStart = Date.now();
			try {
				const resp = await m.model.sendRequest(messages, {}, cts.token);
				text = '';
				for await (const chunk of resp.stream) {
					if (cts.token.isCancellationRequested || isCancelled()) {
						throw new Error(l10n.t('Model request timed out or was canceled (>{0}ms)', String(requestTimeoutMs)));
					}
					if (chunk instanceof vscode.LanguageModelTextPart) {
						text += chunk.value;
					}
				}
				llmOk = true;
				recordModelCall(m.model.name, m.tier, true, Date.now() - callStart);
				break;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				recordModelCall(m.model.name, m.tier, false, Date.now() - callStart, msg);
				if (ai + 1 < candidates.length) {
					trace.push({ iteration: i, phase: 'thought', content: l10n.t('Model {0} call failed ({1}); falling back to {2}', m.model.name, msg.slice(0, 120), candidates[ai + 1].model.name) });
					opts.onUpdate?.('thinking', l10n.t('Falling back to model {0}', candidates[ai + 1].model.name));
				} else {
					trace.push({ iteration: i, phase: 'final', content: l10n.t('Model call failed: {0}', msg) });
					status = 'failed';
					break outer;
				}
			} finally {
				clearTimeout(reqTimer);
				parentCancel?.dispose();
				cts.dispose();
			}
		}
		if (!llmOk) {break;}
		trace.push({ iteration: i, phase: 'thought', content: text.slice(0, 3000) });
		messages.push(vscode.LanguageModelChatMessage.Assistant(text));

		// 2) 解析工具调用
		const calls = parseToolCalls(text);
		if (!calls.length) {
			const stripped = stripToolCalls(text) || text;
			// 模型没产出 <tool_call> 时不能一律当成「完成」：
			// 若整轮都没成功执行过任何工具，且文本也不像收尾总结，基本可判定为「模型不遵循工具协议」
			// （OpenAI/Claude 原生 function-call 或纯 JSON 输出的模型会走到这里）。
			// 静默判完成会让用户以为任务做完了，实际一个文件都没动 —— 必须报失败并给出可操作提示。
			const looksLikeCompletion = /(完成|已全部|全部完成|done|completed|finished|no further (changes|action))/i.test(stripped);
			if (!usedAnyTool && !looksLikeCompletion) {
				status = 'failed';
				finalText = [
					l10n.t('The model did not output per the tool-calling protocol (no <tool_call> block in the response), so the task performed no actions.'),
					'',
					l10n.t('Possible cause: the current model does not support the tool-calling protocol used by this extension (e.g., it only supports native function calling), or the response was truncated.'),
					l10n.t('Suggestion: switch to a model that supports the text tool-calling protocol in "Manage Models" and retry; if the model can complete the task on its own, switch to Plan mode to view its analysis.'),
					'',
					l10n.t('Raw model response (excerpt):'),
					stripped.slice(0, 500),
				].join('\n');
				trace.push({ iteration: i, phase: 'final', content: l10n.t('[Protocol mismatch] {0}', stripped.slice(0, 500)) });
				logger.warn('[AgentLoop] 模型未产出任何工具调用，判定为协议不兼容（未执行任何操作）');
				break;
			}
			finalText = stripped;
			status = 'completed';
			trace.push({ iteration: i, phase: 'final', content: finalText.slice(0, 2000) });
			break;
		}

		// 3) 顺序执行工具调用
		for (const call of calls) {
			if (isCancelled()) {
				status = 'cancelled';
				break outer;
			}
			if (call.name === 'complete') {
				finalText = String(call.args.summary ?? '');
				status = 'completed';
				trace.push({ iteration: i, phase: 'final', content: `[DONE] ${finalText.slice(0, 2000)}` });
				break outer;
			}
			const tool = tools.find(t => t.name === call.name);
			opts.onUpdate?.('tool', `${call.name}`);
			let result: AgentToolResult;
			if (!tool) {
				result = { ok: false, output: `未知工具「${call.name}」。可用：${tools.map(t => t.name).join(', ')}` };
			} else {
				try {
					result = await tool.execute(call.args, session);
				} catch (err) {
					result = { ok: false, output: `工具执行异常：${err instanceof Error ? err.message : String(err)}` };
				}
			}
			const resultText = truncateToolResult(result.error ? `${result.output}\n[错误] ${result.error}` : result.output);
			if (result.ok) { usedAnyTool = true; }
			trace.push({ iteration: i, phase: 'tool_result', content: `${call.name} → ${resultText.slice(0, 1000)}` });
			messages.push(vscode.LanguageModelChatMessage.User(`<tool_result name="${call.name}">\n${resultText}\n</tool_result>`));
			logger.info(`[AgentLoop] iter ${i} ${call.name} ok=${result.ok}`);
		}
		if (i >= maxIterations) {
			status = 'max_iterations';
			trace.push({ iteration: i, phase: 'final', content: l10n.t('Reached the maximum number of iterations ({0})', String(maxIterations)) });
		}
	}

	return { status, output: finalText, trace, iterations: session.iterations, durationMs: Date.now() - start, checkpointId };
}

/** 构建续聊上下文：上次任务 + 轨迹摘要（会话 Threads 简化） */
export function buildHistoryContext(prev: AgentLoopResult): string {
	const lines = [
		`上次任务状态：${prev.status}（${prev.iterations} 轮，${(prev.durationMs / 1000).toFixed(1)}s）`,
		'上次轨迹摘要：',
	];
	for (const step of prev.trace.slice(-30)) {
		if (step.phase === 'thought') {
			lines.push(`- 第 ${step.iteration} 轮：${step.content.slice(0, 300)}`);
		} else if (step.phase === 'tool_result') {
			lines.push(`  工具结果：${step.content.slice(0, 200)}`);
		} else if (step.phase === 'final') {
			lines.push(`- 最终：${step.content.slice(0, 300)}`);
		}
	}
	lines.push(`上次成果：${prev.output.slice(0, 1000)}`);
	return lines.join('\n');
}

// ── 轨迹渲染与命令注册 ──────────────────────────────────────────

/** 渲染轨迹为 Markdown 文档 */
export function renderTraceMarkdown(task: string, result: AgentLoopResult): string {
	const lines = [
		l10n.t('# Agent Run Record'),
		'',
		`- ${l10n.t('Task')}: ${task}`,
		`- ${l10n.t('Status')}: ${result.status}`,
		`- ${l10n.t('Iterations')}: ${l10n.t('{0} turns', String(result.iterations))} · ${l10n.t('Duration')}: ${(result.durationMs / 1000).toFixed(1)}s`,
		'',
		`## ${l10n.t('Trace')}`,
		'',
	];
	for (const step of result.trace) {
		if (step.phase === 'thought') {
			lines.push(l10n.t('### Round {0} · Model Output', String(step.iteration)));
			lines.push('```text');
			lines.push(step.content.slice(0, 1500));
			lines.push('```');
		} else if (step.phase === 'tool_result') {
			lines.push(`> ${step.content.slice(0, 600)}`);
		} else if (step.phase === 'final') {
			lines.push(`**${l10n.t('Final')}:** ${step.content.slice(0, 1500)}`);
		}
		lines.push('');
	}
	lines.push(`## ${l10n.t('Final Output')}`, '', result.output.slice(0, 4000), '');
	return lines.join('\n');
}

/** 注册 Agent 循环命令 */
/** 落盘一次运行（会话节点）：name/parentId/createdAt/status/mode 齐备 → 支撑 Threads 树/分支/命名/搜索 */
function persistRun(runDir: string, task: string, result: AgentLoopResult, parentId?: string, mode?: 'act' | 'plan'): string {
	const id = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
	// 运行记录写在工作区内：不受信任工作区会被闸门拒绝 —— 记录不落盘可以接受，但不能让整次运行失败
	try {
		assertWorkspaceWriteAllowed(path.join(runDir, `${id}.md`));
		fs.writeFileSync(path.join(runDir, `${id}.md`), renderTraceMarkdown(task, result), 'utf-8');
		const record = {
			id, name: task.slice(0, 40), task, parentId, mode,
			createdAt: new Date().toISOString(), status: result.status, result,
		};
		fs.writeFileSync(path.join(runDir, `${id}.json`), JSON.stringify(record, null, 2), 'utf-8');
	} catch (err) {
		logger.warn(`[AgentLoop] 运行记录未落盘（不受信任工作区或磁盘错误）：${err instanceof Error ? err.message : String(err)}`);
	}
	return id;
}

export function registerAgentLoop(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.agent.plan', async () => {
			const task = await vscode.window.showInputBox({
				prompt: l10n.t('Describe the task (Plan mode: read-only analysis of the codebase that produces an implementation plan without modifying any files)'),
				placeHolder: l10n.t('e.g., an implementation plan for adding concurrency rate limiting to src/router'),
			});
			if (!task) {return;}
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) { void vscode.window.showWarningMessage(l10n.t('Please open a workspace first')); return; }
			const ws = folder.uri.fsPath;
			const runDir = path.join(ws, WORKSPACE_KODRIX_DIR, AGENT_RUNS_DIR);
			fs.mkdirSync(runDir, { recursive: true });
			// 可取消进度：长任务期间用户能看到进展，并能真正中断（含终端命令）
			const result = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: l10n.t('Kodrix Agent: {0}…', task.slice(0, 40)), cancellable: true },
				async (progress, token) => runAgentLoop({
					task,
					workspace: ws,
					planOnly: true,
					cancellationToken: token,
					onUpdate: (phase, detail) => progress.report({ message: `${phase} · ${detail}` }),
				}),
			);
			const pid = persistRun(runDir, task, result, undefined, 'plan');
			const doc = await vscode.workspace.openTextDocument(path.join(runDir, `${pid}.md`));
			await vscode.window.showTextDocument(doc, { preview: false });
		}),

		vscode.commands.registerCommand('kodrix.agent.run', async () => {
			const task = await vscode.window.showInputBox({
				prompt: l10n.t('Describe the Agent task (the Agent will autonomously read/write/search/execute and iterate to completion)'),
				placeHolder: l10n.t('e.g., read the TODOs in src/utils.ts, organize them, and write to docs/todos.md'),
			});
			if (!task) {return;}
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				await vscode.window.showErrorMessage(l10n.t('Please open a workspace first'));
				return;
			}
			const ws = folder.uri.fsPath;
			const runDir = path.join(ws, WORKSPACE_KODRIX_DIR, AGENT_RUNS_DIR);
			fs.mkdirSync(runDir, { recursive: true });
			// 可取消进度：长任务（分钟级）必须有进展与中断入口
			const result = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: l10n.t('Kodrix Agent: {0}…', task.slice(0, 40)), cancellable: true },
				async (progress, token) => runAgentLoop({
					task,
					workspace: ws,
					cancellationToken: token,
					onUpdate: (phase, detail) => progress.report({ message: `${phase} · ${detail}` }),
				}),
			);
			const id = persistRun(runDir, task, result);
			const doc = await vscode.workspace.openTextDocument(path.join(runDir, `${id}.md`));
			await vscode.window.showTextDocument(doc, { preview: true });
			if (result.checkpointId) {
				await vscode.window.showInformationMessage(l10n.t('Checkpoint {0} created (run "Kodrix: Restore Checkpoint" to roll back files the Agent wrote via tools; side effects from terminal commands are not covered by the rollback)', result.checkpointId));
			}
			if (result.status === 'completed') {
				await vscode.window.showInformationMessage(l10n.t('Agent task completed ({0} turns, {1}s)', result.iterations, (result.durationMs / 1000).toFixed(1)));
			} else if (result.status === 'cancelled') {
				await vscode.window.showWarningMessage(l10n.t('Agent task canceled ({0}s)', (result.durationMs / 1000).toFixed(1)));
			} else {
				await vscode.window.showWarningMessage(l10n.t('Agent task incomplete: {0} ({1}s)', result.status, (result.durationMs / 1000).toFixed(1)));
			}
		}),

		vscode.commands.registerCommand(COMMANDS.agentResume, async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) { void vscode.window.showWarningMessage(l10n.t('Please open a workspace first')); return; }
			const runDir = path.join(folder.uri.fsPath, WORKSPACE_KODRIX_DIR, AGENT_RUNS_DIR);
			const runs = loadRuns(runDir);
			if (!runs.length) {
				await vscode.window.showInformationMessage(l10n.t('No sessions yet (run an Agent task first)'));
				return;
			}
			const picked = await pickRun(runs, l10n.t('Select a session to continue (continuing the same node multiple times creates branches)'));
			if (!picked) {return;}
			const task = await vscode.window.showInputBox({ prompt: l10n.t('Continue task (continues as a child branch of this session)'), value: l10n.t('Continue: {0}', picked.task) });
			if (!task) {return;}
			await vscode.window.showInformationMessage(l10n.t('Agent follow-up started: {0}…', task.slice(0, 40)));
			const result = await runAgentLoop({ task, workspace: folder.uri.fsPath, resumeFrom: picked.result as AgentLoopResult });
			const id2 = persistRun(runDir, task, result, picked.id);
			const doc2 = await vscode.workspace.openTextDocument(path.join(runDir, `${id2}.md`));
			await vscode.window.showTextDocument(doc2, { preview: true });
			if (result.status === 'completed') {
				await vscode.window.showInformationMessage(l10n.t('Agent follow-up completed ({0} turns)', result.iterations));
			} else {
				await vscode.window.showWarningMessage(l10n.t('Agent follow-up incomplete: {0}', result.status));
			}
		}),

		vscode.commands.registerCommand('kodrix.agent.list', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) { void vscode.window.showWarningMessage(l10n.t('Please open a workspace first')); return; }
			const runDir = path.join(folder.uri.fsPath, WORKSPACE_KODRIX_DIR, AGENT_RUNS_DIR);
			if (!fs.existsSync(runDir)) {
				await vscode.window.showInformationMessage(l10n.t('No Agent runs yet'));
				return;
			}
			const files = fs.readdirSync(runDir).filter(f => f.endsWith('.md')).sort().reverse();
			if (!files.length) {
				await vscode.window.showInformationMessage(l10n.t('No Agent runs yet'));
				return;
			}
			const picked = await vscode.window.showQuickPick(files, { placeHolder: l10n.t('Select an Agent run') });
			if (!picked) {return;}
			const doc = await vscode.workspace.openTextDocument(path.join(runDir, picked));
			await vscode.window.showTextDocument(doc, { preview: true });
		}),
	);
}
