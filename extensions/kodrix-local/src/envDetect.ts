/*---------------------------------------------------------------------------------------------
 *  Environment Detection — 智能环境检测（GPU · Ollama · Node · Python · Disk）
 *  大厂标准：首次引导自动识别最佳配置，减少用户决策负担
 *
 *  2026-09 重构：同步 execSync 串行探测会在 Windows 上长时间阻塞扩展宿主，
 *  且 ollama/wmic 等命令超时后杀不干净子进程，导致「正在扫描你的开发环境」永远卡住。
 *  现改为全异步并行探测：每个命令独立超时 + 绝对兜底，保证 detectEnvironment() 必定在
 *  有限时间内（最慢单个探测约 6-8s）返回，绝不挂起。
 *--------------------------------------------------------------------------------------------*/

import * as child_process from 'child_process';
import { logWarn } from './logger';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface EnvInfo {
	platform: string;
	arch: string;
	nodeVersion: string;
	cpus: number;
	totalMemoryGB: number;
	freeDiskGB: number;
	hasGPU: boolean;
	gpuInfo: string;
	hasOllama: boolean;
	ollamaModels: string[];
	hasPython: boolean;
	pythonVersion: string;
	hasGit: boolean;
	hasDocker: boolean;
	hasCursorConfig: boolean;
	hasCursorminiConfig: boolean;
	/** icon = codicon 名（见 resources/codicons），由引导页 `ki()` 渲染 */
	suggestions: { icon: string; text: string }[];
}

const ALLOWED_COMMANDS = new Set([
	'wmic', 'nvidia-smi', 'sysctl', 'ioreg', 'lspci', 'grep', 'head',
	'ollama', 'python', 'python3', 'git', 'docker', 'powershell',
]);

/**
 * 异步执行单条探测命令，超时 / 命令不存在 / 非零退出 一律返回 null，绝不挂起。
 * - windowsHide: 探测时不弹出黑窗口
 * - timeout + killSignal: 超时后杀掉子进程并触发回调
 * - 额外 setTimeout 绝对兜底：即使 exec 回调因极端情况未触发，Promise 也必定结算
 */
function execProbe(cmd: string, timeoutMs = 5000): Promise<string | null> {
	// 校验管道中**每一段**的首个二进制都在白名单内（而非只检查首段），
	// 防止 `allowed | not-allowed` 形式绕过。这些命令均为内部硬编码常量，无用户输入拼接。
	const segments = cmd.split('|');
	for (const seg of segments) {
		const binary = seg.trim().split(/\s+/)[0];
		if (!binary) {
			continue;
		}
		if (!ALLOWED_COMMANDS.has(binary)) {
			logWarn(`[EnvDetect] Blocked untrusted command segment: ${binary}`);
			return Promise.resolve(null);
		}
	}

	return new Promise<string | null>(resolve => {
		let settled = false;
		const done = (value: string | null): void => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		try {
			const child = child_process.exec(
				cmd,
				{
					timeout: timeoutMs,
					encoding: 'utf-8',
					windowsHide: true,
					killSignal: 'SIGKILL',
					maxBuffer: 2 * 1024 * 1024,
				},
				(err, stdout) => {
					done(err ? null : String(stdout ?? '').trim());
				},
			);
			// 防止 spawn 失败等场景触发未处理的 'error' 事件
			child.on('error', () => done(null));
		} catch {
			done(null);
		}
		// 绝对兜底：即使 exec 回调未触发，也保证在超时后结算
		setTimeout(() => done(null), timeoutMs + 2000);
	});
}

async function detectGPU(): Promise<{ hasGPU: boolean; gpuInfo: string }> {
	if (process.platform === 'win32') {
		// 三种方式并行探测，取最先成功的结果。
		// wmic 在新版 Windows 已废弃（可能缺失/极慢），因此并行加上了 nvidia-smi 与 PowerShell CIM 兜底。
		const [wmic, nvidia, cim] = await Promise.all([
			execProbe('wmic path win32_videocontroller get name /format:list', 4000),
			execProbe('nvidia-smi --query-gpu=name --format=csv,noheader', 4000),
			execProbe('powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_VideoController).Name"', 6000),
		]);
		if (nvidia) {
			return { hasGPU: true, gpuInfo: `NVIDIA: ${nvidia}` };
		}
		const lines = (wmic ?? '').split('\n').filter(l => l.includes('Name='));
		const gpus = lines.map(l => l.split('=')[1]?.trim()).filter(Boolean);
		if (gpus.length) {
			return { hasGPU: true, gpuInfo: gpus.join('; ') };
		}
		const cimGpus = (cim ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
		if (cimGpus.length) {
			return { hasGPU: true, gpuInfo: cimGpus.join('; ') };
		}
		return { hasGPU: false, gpuInfo: '未检测到独立 GPU（集成显卡可用）' };
	}

	if (process.platform === 'darwin') {
		// Apple Silicon（arm64）具备可用于推理的统一内存 GPU（Metal）；
		// Intel Mac 多为集成显卡，不应笼统标记为「可用于本地推理的 GPU」。
		const isAppleSilicon = os.arch() === 'arm64';
		const [ioreg, sysctl] = await Promise.all([
			execProbe('ioreg -l | grep -i "model" | grep -i "gpu\\|graphics" | head -1', 5000),
			execProbe('sysctl -n machdep.cpu.brand_string', 3000),
		]);
		const info = (ioreg ?? sysctl ?? (isAppleSilicon ? 'Apple Silicon GPU' : 'Intel 集成显卡'))
			.split('\n')[0]?.trim() || 'Apple GPU';
		return {
			hasGPU: isAppleSilicon,
			gpuInfo: isAppleSilicon ? info : `${info}（集成显卡，本地推理性能有限）`,
		};
	}

	// Linux
	const [lspci, nvidiaSmi] = await Promise.all([
		execProbe('lspci | grep -i vga', 3000),
		execProbe('nvidia-smi --query-gpu=name --format=csv,noheader', 5000),
	]);
	if (nvidiaSmi) {
		return { hasGPU: true, gpuInfo: `NVIDIA: ${nvidiaSmi.split('\n')[0]}` };
	}
	if (lspci) {
		return { hasGPU: true, gpuInfo: lspci.split(':').slice(-1)[0]?.trim() || '未知 GPU' };
	}
	return { hasGPU: false, gpuInfo: '未检测到独立 GPU' };
}

async function detectOllama(): Promise<{ hasOllama: boolean; ollamaModels: string[] }> {
	// 先探测 CLI 是否存在（快速、不拉起服务），再尝试列模型。
	// `ollama list` 在服务未启动时可能拉起 Ollama App 并长时间等待，故只给 2.5s 短超时。
	const version = await execProbe('ollama --version 2>&1', 3000);
	if (version) {
		const list = await execProbe('ollama list', 2500);
		if (list) {
			const lines = list.split('\n').slice(1); // skip header
			const models = lines
				.filter(l => l.trim())
				.map(l => l.split(/\s+/)[0])
				.filter(Boolean);
			return { hasOllama: true, ollamaModels: models };
		}
		return { hasOllama: true, ollamaModels: [] }; // 已安装但服务未运行/无模型
	}

	// Check common install paths
	const commonPaths = process.platform === 'win32'
		? [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')]
		: ['/usr/local/bin/ollama', '/usr/bin/ollama'];

	for (const p of commonPaths) {
		if (fs.existsSync(p)) return { hasOllama: true, ollamaModels: [] };
	}
	return { hasOllama: false, ollamaModels: [] };
}

async function detectPython(): Promise<{ hasPython: boolean; pythonVersion: string }> {
	const [py3, py] = await Promise.all([
		execProbe('python --version 2>&1', 4000),
		execProbe('python3 --version 2>&1', 4000),
	]);
	const raw = py3 ?? py;
	if (raw) return { hasPython: true, pythonVersion: raw.replace(/^Python\s+/i, '').trim() };
	return { hasPython: false, pythonVersion: '' };
}

async function detectTool(cmd: string, timeoutMs = 4000): Promise<boolean> {
	const result = await execProbe(cmd, timeoutMs);
	return !!result;
}

function detectCursorConfig(): boolean {
	const cursorHome = path.join(os.homedir(), '.cursor');
	return fs.existsSync(cursorHome);
}

function detectCursorminiConfig(): boolean {
	const miniHome = path.join(os.homedir(), '.cursormini');
	const kodrix = path.join(os.homedir(), '.kodrix');
	return fs.existsSync(miniHome) || fs.existsSync(kodrix);
}

function getFreeDiskGB(): number {
	try {
		const folder = os.homedir();
		if (typeof fs.statfsSync !== 'function') {
			return 0;
		}
		const stat: fs.StatsFs = fs.statfsSync(folder);
		// bsize / bavail 在部分平台为 bigint，统一转 number 计算
		const bsize = Number(stat.bsize);
		const bavail = Number(stat.bavail);
		if (Number.isFinite(bsize) && Number.isFinite(bavail)) {
			return Math.round((bavail * bsize) / (1024 * 1024 * 1024) * 10) / 10;
		}
	} catch { /* fallback */ }
	return 0;
}

export async function detectEnvironment(): Promise<EnvInfo> {
	const totalMemGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
	const freeDisk = getFreeDiskGB();

	// 全部探测并行执行：总耗时 ≈ 最慢单个探测（约 6-8s），而非串行累加（最坏可达 30s+）
	const [gpu, ollama, python, hasGit, hasDocker] = await Promise.all([
		detectGPU(),
		detectOllama(),
		detectPython(),
		detectTool('git --version 2>&1'),
		detectTool('docker --version 2>&1'),
	]);

	const suggestions: EnvInfo['suggestions'] = [];

	// Smart suggestions based on environment（图标用引导页 codicon）
	if (ollama.hasOllama && ollama.ollamaModels.length > 0) {
		suggestions.push({ icon: 'pass', text: `检测到 Ollama + ${ollama.ollamaModels.length} 个模型 — 已自动配置本地推理` });
	} else if (ollama.hasOllama) {
		suggestions.push({ icon: 'zap', text: '检测到 Ollama — 建议运行 `ollama pull codellama` 拉取编程模型' });
	} else if (gpu.hasGPU && totalMemGB >= 16) {
		suggestions.push({ icon: 'lightbulb', text: '你的 GPU 性能良好，建议安装 Ollama 享受免费本地推理' });
	}

	if (gpu.hasGPU && totalMemGB >= 16) {
		suggestions.push({ icon: 'circuit-board', text: 'GPU 可用于本地大模型推理（7B-13B 参数）' });
	} else if (totalMemGB < 8) {
		suggestions.push({ icon: 'warning', text: '内存较小（<8GB），建议使用云端 API 模型' });
	}

	if (!python.hasPython) {
		suggestions.push({ icon: 'python', text: '建议安装 Python 3.10+ 以支持更多 Agent 工具' });
	}

	if (freeDisk > 0 && freeDisk < 10) {
		suggestions.push({ icon: 'warning', text: '磁盘空间不足（<10GB），可能影响本地模型下载' });
	}

	return {
		platform: `${os.platform()} ${os.release()}`,
		arch: os.arch(),
		nodeVersion: process.version,
		cpus: os.cpus().length,
		totalMemoryGB: totalMemGB,
		freeDiskGB: freeDisk,
		hasGPU: gpu.hasGPU,
		gpuInfo: gpu.gpuInfo,
		hasOllama: ollama.hasOllama,
		ollamaModels: ollama.ollamaModels,
		hasPython: python.hasPython,
		pythonVersion: python.pythonVersion,
		hasGit,
		hasDocker,
		hasCursorConfig: detectCursorConfig(),
		hasCursorminiConfig: detectCursorminiConfig(),
		suggestions,
	};
}
