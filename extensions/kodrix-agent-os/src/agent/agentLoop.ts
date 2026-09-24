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
import * as fs from 'fs';
import * as path from 'path';
import { getModelCandidates, routeModel, recordModelCall } from '../model/modelRouter';
import { runCommandInTerminal } from '../terminal/terminalAi';
import { logger } from '../logger';
import { loadRuns, pickRun } from './threads';
import type { ApplyProposal, FileChange } from '../apply/applyManager';
import {
	COMMANDS,
	AGENT_LOOP_CONFIG,
	AGENT_LOOP_CONFIG_KEYS,
	AGENT_LOOP_DEFAULT_MAX_ITERATIONS,
	AGENT_LOOP_DEFAULT_TIMEOUT_MS,
	AGENT_LOOP_DEFAULT_CHECKPOINT,
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

/** read_file：读取文件（带行号，截断） */
const readFileTool: AgentTool = {
	name: 'read_file',
	description: '读取文件（带行号）',
	async execute(args, session) {
		const p = resolveInWorkspace(String(args.path ?? ''), session.workspace);
		if (!p) return { ok: false, output: '路径越界：仅允许工作区内文件' };
		if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return { ok: false, output: `文件不存在或为目录：${args.path}` };
		try {
			const startLine = Math.max(1, Number(args.startLine) || 1);
			const maxLines = Math.max(1, Number(args.maxLines) || READ_DEFAULT_LINES);
			const content = fs.readFileSync(p, 'utf-8').split(/\r?\n/);
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

/** write_file：写入/覆盖文件 */
const writeFileTool: AgentTool = {
	name: 'write_file',
	description: '写入/覆盖文件',
	async execute(args, session) {
		const p = resolveInWorkspace(String(args.path ?? ''), session.workspace);
		if (!p) return { ok: false, output: '路径越界：仅允许工作区内文件' };
		const content = String(args.content ?? '');
		try {
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.writeFileSync(p, content, 'utf-8');
			return { ok: true, output: `已写入 ${args.path}（${content.length} 字符）` };
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
		if (!p) return { ok: false, output: '路径越界：仅允许工作区内文件' };
		const oldText = String(args.old ?? '');
		const newText = String(args.new ?? '');
		if (!oldText) return { ok: false, output: 'old 不能为空' };
		if (!fs.existsSync(p)) return { ok: false, output: `文件不存在：${args.path}` };
		try {
			const content = fs.readFileSync(p, 'utf-8');
			const count = content.split(oldText).length - 1;
			if (count === 0) return { ok: false, output: `未找到匹配文本（${args.path}）。请先 read_file 核对内容。` };
			if (count > 1) return { ok: false, output: `匹配 ${count} 处，old 必须唯一。请扩大上下文。` };
			fs.writeFileSync(p, content.replace(oldText, newText), 'utf-8');
			return { ok: true, output: `已编辑 ${args.path}：替换 1 处（${oldText.length} → ${newText.length} 字符）` };
		} catch (err) {
			return { ok: false, output: `编辑失败：${err instanceof Error ? err.message : String(err)}` };
		}
	},
};

/** list_dir：列目录 */
const listDirTool: AgentTool = {
	name: 'list_dir',
	description: '列出目录内容',
	async execute(args, session) {
		const p = resolveInWorkspace(String(args.path ?? '.'), session.workspace);
		if (!p) return { ok: false, output: '路径越界' };
		if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return { ok: false, output: `目录不存在：${args.path ?? '.'}` };
		try {
			const entries = fs.readdirSync(p, { withFileTypes: true });
			const lines = entries.map(e => `${e.isDirectory() ? '[dir] ' : '      '}${e.name}`).slice(0, 200);
			if (entries.length > 200) lines.push(`…（共 ${entries.length} 项）`);
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
		if (!query) return { ok: false, output: 'query 不能为空' };
		const startPath = args.path ? resolveInWorkspace(String(args.path), session.workspace) : session.workspace;
		if (!startPath) return { ok: false, output: '路径越界' };
		const glob = String(args.glob ?? '').replace(/\\/g, '/');
		// 支持 *.ts / **/*.ts / *ext 等常见写法（勿用块注释：**/ 会提前结束 /* */）
		const matchGlob = (fileName: string, relPosix: string): boolean => {
			if (!glob) return true;
			const extFromStar = (p: string) => p.startsWith('*') && !p.includes('/') ? p.slice(1) : undefined;
			if (glob.startsWith('**/')) {
				const rest = glob.slice(3);
				const ext = extFromStar(rest);
				if (ext !== undefined) return fileName.endsWith(ext);
				return relPosix.endsWith(rest) || fileName === rest;
			}
			const ext = extFromStar(glob);
			if (ext !== undefined) return fileName.endsWith(ext);
			if (glob.includes('/')) {
				return relPosix === glob || relPosix.endsWith('/' + glob.split('/').pop()!);
			}
			return fileName === glob || fileName.endsWith(glob);
		};
		try {
			const re = new RegExp(query, 'i');
			const hits: string[] = [];
			const SKIP = new Set(['node_modules', '.git', 'out', 'out-build', '.build', '.kodrix']);
			const walk = (dir: string, depth: number) => {
				if (depth > 6 || hits.length >= 50) return;
				let entries;
				try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
				for (const e of entries) {
					if (SKIP.has(e.name)) continue;
					const full = path.join(dir, e.name);
					if (e.isDirectory()) walk(full, depth + 1);
					else if (e.isFile()) {
						const rel = path.relative(session.workspace, full).replace(/\\/g, '/');
						if (!matchGlob(e.name, rel)) continue;
						try {
							const lines = fs.readFileSync(full, 'utf-8').split(/\r?\n/);
							lines.forEach((l, i) => {
								if (re.test(l) && hits.length < 50) {
									hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 120)}`);
								}
							});
						} catch { /* skip unreadable */ }
					}
				}
			};
			walk(startPath, 0);
			return hits.length
				? { ok: true, output: `命中 ${hits.length} 处：\n${hits.join('\n')}` }
				: { ok: true, output: '无命中' };
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
		if (!query) return { ok: false, output: 'query 不能为空' };
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
				if (seen.has(key)) continue;
				seen.add(key);
				lines.push(`  ${path.relative(session.workspace, fp)} :: ${s.symbol.name} (score ${s.score.toFixed(3)})`);
				if (lines.length >= limit) break;
			}
			for (const f of files) {
				if (lines.length >= limit) break;
				if (seen.has(f.filePath)) continue;
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
		if (!session.allowCommands) return { ok: false, output: '命令执行已禁用（kodrix.agentLoop.allowCommands=false）' };
		const command = String(args.command ?? '');
		if (!command.trim()) return { ok: false, output: 'command 不能为空' };
		try {
			const res = await runCommandInTerminal(command, { timeoutMs: 60000 });
			const out = (res.output || '').slice(0, TOOL_RESULT_MAX_CHARS);
			if (res.timedOut) {
				return { ok: false, output: `命令超时（60s）\n${out}` };
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
		if (!rawChanges.length) return { ok: false, output: 'changes 不能为空数组' };
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
		if (!changes.length) return { ok: false, output: '未解析到有效变更（每项需 filePath）' };
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
	const maxIterations = opts.maxIterations
		?? vscode.workspace.getConfiguration(AGENT_LOOP_CONFIG).get<number>(AGENT_LOOP_CONFIG_KEYS.maxIterations, AGENT_LOOP_DEFAULT_MAX_ITERATIONS);
	const timeoutMs = opts.timeoutMs
		?? vscode.workspace.getConfiguration(AGENT_LOOP_CONFIG).get<number>(AGENT_LOOP_CONFIG_KEYS.timeoutMs, AGENT_LOOP_DEFAULT_TIMEOUT_MS);
	const allowCommands = vscode.workspace.getConfiguration(AGENT_LOOP_CONFIG)
		.get<boolean>(AGENT_LOOP_CONFIG_KEYS.allowCommands, true);

	// planOnly：只读工具集（read/list_dir/search/codebase_search）+ complete，禁止写/改/执行/提案
	const READONLY_TOOLS = new Set(['read_file', 'list_dir', 'search', 'codebase_search']);
	const tools = (opts.tools?.length
		? DEFAULT_TOOLS.filter(t => opts.tools!.includes(t.name))
		: DEFAULT_TOOLS)
		.filter(t => !opts.planOnly || READONLY_TOOLS.has(t.name) || t.name === 'complete');
	const session: AgentLoopSession = {
		workspace: opts.workspace,
		allowCommands,
		iterations: 0,
		onUpdate: opts.onUpdate,
	};

	const trace: AgentTraceStep[] = [];
	let finalText = '';
	let status: AgentLoopResult['status'] = 'completed';

	const routed = await routeModel({ preferred: opts.model, taskType: 'coding' });
	if (!routed) {
		return { status: 'failed', output: '无可用语言模型（请在 Manage Models 中配置 BYOK 模型）', trace, iterations: 0, durationMs: Date.now() - start };
	}
	// 模型候选列表（故障转移：失败自动降级下一个可用模型）
	const candidates = await getModelCandidates({ preferred: opts.model, taskType: 'coding' });
	if (!candidates.length) {
		return { status: 'failed', output: '无可用语言模型（请在 Manage Models 中配置 BYOK 模型）', trace, iterations: 0, durationMs: Date.now() - start };
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
	messages.push(vscode.LanguageModelChatMessage.User(`${AGENT_LOOP_SYSTEM_PROMPT}\n\n${modeNote}【任务】${opts.task}`));

	const isCancelled = () => opts.cancellationToken?.isCancellationRequested === true;
	const elapsed = () => Date.now() - start;

	outer: for (let i = 1; i <= maxIterations; i++) {
		session.iterations = i;
		opts.onUpdate?.('thinking', `第 ${i} 轮推理`);

		if (isCancelled()) {
			status = 'cancelled';
			break;
		}
		if (elapsed() > timeoutMs) {
			status = 'failed';
			trace.push({ iteration: i, phase: 'final', content: `总超时（${timeoutMs}ms）` });
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
			try {
				const resp = await m.model.sendRequest(messages, {}, cts.token);
				text = '';
				for await (const chunk of resp.stream) {
					if (cts.token.isCancellationRequested || isCancelled()) {
						throw new Error(`模型请求超时或已取消（>${requestTimeoutMs}ms）`);
					}
					if (chunk instanceof vscode.LanguageModelTextPart) {
						text += chunk.value;
					}
				}
				llmOk = true;
				recordModelCall(m.model.name, m.tier, true, Date.now() - start);
				break;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				recordModelCall(m.model.name, m.tier, false, Date.now() - start, msg);
				if (ai + 1 < candidates.length) {
					trace.push({ iteration: i, phase: 'thought', content: `模型 ${m.model.name} 调用失败（${msg.slice(0, 120)}），降级到 ${candidates[ai + 1].model.name}` });
					opts.onUpdate?.('thinking', `模型降级 → ${candidates[ai + 1].model.name}`);
				} else {
					trace.push({ iteration: i, phase: 'final', content: `模型调用失败：${msg}` });
					status = 'failed';
					break outer;
				}
			} finally {
				clearTimeout(reqTimer);
				parentCancel?.dispose();
				cts.dispose();
			}
		}
		if (!llmOk) break;
		trace.push({ iteration: i, phase: 'thought', content: text.slice(0, 3000) });
		messages.push(vscode.LanguageModelChatMessage.Assistant(text));

		// 2) 解析工具调用
		const calls = parseToolCalls(text);
		if (!calls.length) {
			// 无工具调用 → 视为最终答案
			finalText = stripToolCalls(text) || text;
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
			const resultText = (result.error ? `${result.output}\n[错误] ${result.error}` : result.output).slice(0, TOOL_RESULT_MAX_CHARS);
			trace.push({ iteration: i, phase: 'tool_result', content: `${call.name} → ${resultText.slice(0, 1000)}` });
			messages.push(vscode.LanguageModelChatMessage.User(`<tool_result name="${call.name}">\n${resultText}\n</tool_result>`));
			logger.info(`[AgentLoop] iter ${i} ${call.name} ok=${result.ok}`);
		}
		if (i >= maxIterations) {
			status = 'max_iterations';
			trace.push({ iteration: i, phase: 'final', content: `达到最大迭代次数 ${maxIterations}` });
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
		`# Agent 运行记录`,
		'',
		`- 任务：${task}`,
		`- 状态：${result.status}`,
		`- 迭代：${result.iterations} 轮 · 耗时 ${(result.durationMs / 1000).toFixed(1)}s`,
		'',
		'## 轨迹',
		'',
	];
	for (const step of result.trace) {
		if (step.phase === 'thought') {
			lines.push(`### 第 ${step.iteration} 轮 · 模型输出`);
			lines.push('```text');
			lines.push(step.content.slice(0, 1500));
			lines.push('```');
		} else if (step.phase === 'tool_result') {
			lines.push(`> ${step.content.slice(0, 600)}`);
		} else if (step.phase === 'final') {
			lines.push(`**最终：** ${step.content.slice(0, 1500)}`);
		}
		lines.push('');
	}
	lines.push('## 最终成果', '', result.output.slice(0, 4000), '');
	return lines.join('\n');
}

/** 注册 Agent 循环命令 */
/** 落盘一次运行（会话节点）：name/parentId/createdAt/status/mode 齐备 → 支撑 Threads 树/分支/命名/搜索 */
function persistRun(runDir: string, task: string, result: AgentLoopResult, parentId?: string, mode?: 'act' | 'plan'): string {
	const id = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
	fs.writeFileSync(path.join(runDir, `${id}.md`), renderTraceMarkdown(task, result), 'utf-8');
	const record = {
		id, name: task.slice(0, 40), task, parentId, mode,
		createdAt: new Date().toISOString(), status: result.status, result,
	};
	fs.writeFileSync(path.join(runDir, `${id}.json`), JSON.stringify(record, null, 2), 'utf-8');
	return id;
}

export function registerAgentLoop(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.agent.plan', async () => {
			const task = await vscode.window.showInputBox({
				prompt: '描述任务（计划模式：只读分析代码库，输出实施计划，不修改任何文件）',
				placeHolder: '例如：为 src/router 增加并发限流的实施方案',
			});
			if (!task) return;
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) return;
			const ws = folder.uri.fsPath;
			const runDir = path.join(ws, WORKSPACE_KODRIX_DIR, AGENT_RUNS_DIR);
			fs.mkdirSync(runDir, { recursive: true });
			void vscode.window.showInformationMessage(`Plan 模式分析中：${task.slice(0, 40)}…`);
			const result = await runAgentLoop({ task, workspace: ws, planOnly: true });
			const pid = persistRun(runDir, task, result, undefined, 'plan');
			const doc = await vscode.workspace.openTextDocument(path.join(runDir, `${pid}.md`));
			await vscode.window.showTextDocument(doc, { preview: false });
		}),

		vscode.commands.registerCommand('kodrix.agent.run', async () => {
			const task = await vscode.window.showInputBox({
				prompt: '描述 Agent 任务（Agent 将自主读/写/搜索/执行并迭代完成）',
				placeHolder: '例如：读取 src/utils.ts 中的 TODO，整理并写入 docs/todos.md',
			});
			if (!task) return;
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				await vscode.window.showErrorMessage('请先打开工作区');
				return;
			}
			const ws = folder.uri.fsPath;
			const runDir = path.join(ws, WORKSPACE_KODRIX_DIR, AGENT_RUNS_DIR);
			fs.mkdirSync(runDir, { recursive: true });
			await vscode.window.showInformationMessage(`Agent 任务已启动：${task.slice(0, 40)}…（完成后自动打开记录）`);
			const result = await runAgentLoop({ task, workspace: ws });
			const id = persistRun(runDir, task, result);
			const doc = await vscode.workspace.openTextDocument(path.join(runDir, `${id}.md`));
			await vscode.window.showTextDocument(doc, { preview: true });
			if (result.checkpointId) {
				await vscode.window.showInformationMessage(`已创建检查点 ${result.checkpointId}（可运行「Kodrix: 恢复检查点」回滚 Agent 改动）`);
			}
			if (result.status === 'completed') {
				await vscode.window.showInformationMessage(`Agent 任务完成（${result.iterations} 轮，${(result.durationMs / 1000).toFixed(1)}s）`);
			} else {
				await vscode.window.showWarningMessage(`Agent 任务未完成：${result.status}（${(result.durationMs / 1000).toFixed(1)}s）`);
			}
		}),

		vscode.commands.registerCommand(COMMANDS.agentResume, async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) return;
			const runDir = path.join(folder.uri.fsPath, WORKSPACE_KODRIX_DIR, AGENT_RUNS_DIR);
			const runs = loadRuns(runDir);
			if (!runs.length) {
				await vscode.window.showInformationMessage('暂无会话记录（先运行 Agent 任务）');
				return;
			}
			const picked = await pickRun(runs, '选择要续聊的会话（同一节点多次续聊即分支）');
			if (!picked) return;
			const task = await vscode.window.showInputBox({ prompt: '续聊任务（将作为该会话的子分支继续）', value: `继续：${picked.task}` });
			if (!task) return;
			await vscode.window.showInformationMessage(`Agent 续聊已启动：${task.slice(0, 40)}…`);
			const result = await runAgentLoop({ task, workspace: folder.uri.fsPath, resumeFrom: picked.result as AgentLoopResult });
			const id2 = persistRun(runDir, task, result, picked.id);
			const doc2 = await vscode.workspace.openTextDocument(path.join(runDir, `${id2}.md`));
			await vscode.window.showTextDocument(doc2, { preview: true });
			if (result.status === 'completed') {
				await vscode.window.showInformationMessage(`Agent 续聊完成（${result.iterations} 轮）`);
			} else {
				await vscode.window.showWarningMessage(`Agent 续聊未完成：${result.status}`);
			}
		}),

		vscode.commands.registerCommand('kodrix.agent.list', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) return;
			const runDir = path.join(folder.uri.fsPath, WORKSPACE_KODRIX_DIR, AGENT_RUNS_DIR);
			if (!fs.existsSync(runDir)) {
				await vscode.window.showInformationMessage('暂无 Agent 运行记录');
				return;
			}
			const files = fs.readdirSync(runDir).filter(f => f.endsWith('.md')).sort().reverse();
			if (!files.length) {
				await vscode.window.showInformationMessage('暂无 Agent 运行记录');
				return;
			}
			const picked = await vscode.window.showQuickPick(files, { placeHolder: '选择 Agent 运行记录' });
			if (!picked) return;
			const doc = await vscode.workspace.openTextDocument(path.join(runDir, picked));
			await vscode.window.showTextDocument(doc, { preview: true });
		}),
	);
}
