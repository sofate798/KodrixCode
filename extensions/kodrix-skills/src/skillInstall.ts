/*---------------------------------------------------------------------------------------------
 *  Skill 安装 — 写入 ~/.agents/skills/<name>/SKILL.md
 *  安全加固：名称严格白名单、仅 https 且主机精确匹配的重定向、解压前 ZIP 预校验、大小上限
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import { validateZipArchive, MAX_ARCHIVE_PATH_DEPTH } from './zipValidation';

const _diag = vscode.window.createOutputChannel('Kodrix Skills', { log: true });

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_FETCH_BYTES = 2 * 1024 * 1024; // 2MB cap for SKILL.md text
const HTTP_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

/**
 * Skill 目录名白名单：字母数字与 _ - +，点号只能作为**非空段之间**的分隔符。
 * 因此 `.`、`..`、`a..b`、结尾点号、含分隔符/盘符/UNC/通配符的名字都会被拒绝。
 */
const SAFE_NAME_RE = /^[a-zA-Z0-9_\-+]+(\.[a-zA-Z0-9_\-+]+)*$/;

/** Windows 保留设备名（首段大小写无关） */
const WINDOWS_RESERVED_NAMES = new Set<string>([
	'con', 'prn', 'aux', 'nul',
	...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
	...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

function sanitizeSkillName(name: string): string {
	const trimmed = (name ?? '').trim();
	if (!trimmed || trimmed.length > 64) {
		throw new Error(vscode.l10n.t('Invalid skill name: {0}', name));
	}
	if (!SAFE_NAME_RE.test(trimmed)) {
		// 覆盖 ../、绝对路径、盘符、UNC、空格、通配符、单个或连续点号
		throw new Error(vscode.l10n.t('Invalid skill name: {0}', name));
	}
	if (WINDOWS_RESERVED_NAMES.has(trimmed.split('.')[0].toLowerCase())) {
		throw new Error(vscode.l10n.t('Invalid skill name (Windows reserved name): {0}', name));
	}
	return trimmed;
}

/**
 * 解压**之后**复核目录树：必须在目标目录内且不含符号链接。
 * 这是对解压工具自身行为的兜底（解压前的条目校验见 zipValidation.validateZipArchive）。
 */
function verifyExtractedTree(extractDir: string): void {
	const base = fs.realpathSync(extractDir);
	const walk = (dir: string, depth: number): void => {
		if (depth > MAX_ARCHIVE_PATH_DEPTH) {
			throw new Error(vscode.l10n.t('Extraction directory depth exceeds the limit ({0})', String(MAX_ARCHIVE_PATH_DEPTH)));
		}
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				throw new Error(vscode.l10n.t('Archive contains a symbolic link, rejected: {0}', entry.name));
			}
			const real = fs.realpathSync(full);
			if (real !== base && !real.startsWith(base + path.sep)) {
				throw new Error(vscode.l10n.t('Extraction escaped the target directory: {0}', real));
			}
			if (entry.isDirectory()) {
				walk(full, depth + 1);
			}
		}
	};
	walk(base, 0);
}

/**
 * Extract a zip file using platform-native tools.
 * Security: the archive is validated (entry count / total size / traversal / symlink / encryption)
 * before anything is written to disk, and arguments are passed as an argv array.
 * 导出以便单元测试直接覆盖解压路径（Windows 走 -File 传参）。
 */
export function extractZip(zipPath: string, destDir: string): void {
	// 解压前先校验归档，避免 zip bomb / zip slip 落盘
	validateZipArchive(zipPath);

	if (process.platform === 'win32') {
		// 注意：`powershell -Command '<脚本>' 参数…` 不会把尾随参数绑定到 $args
		// （它们会被拼进脚本文本，导致 Expand-Archive 拿到空路径），因此写入一个
		// 带 param() 的临时脚本并用 -File 调用，参数才会按名绑定。
		const scriptPath = path.join(os.tmpdir(), `kodrix-extract-${process.pid}-${Date.now()}.ps1`);
		fs.writeFileSync(scriptPath, [
			'param([string]$ZipPath, [string]$DestDir)',
			'$ErrorActionPreference = "Stop"',
			'Expand-Archive -LiteralPath $ZipPath -DestinationPath $DestDir -Force',
			'',
		].join('\n'), 'utf-8');
		try {
			const result = spawnSync('powershell', [
				'-NoProfile',
				'-NonInteractive',
				'-ExecutionPolicy', 'Bypass',
				'-File', scriptPath,
				'-ZipPath', zipPath,
				'-DestDir', destDir,
			], { stdio: 'pipe', timeout: 60000 });
			if (result.status !== 0) {
				const stderr = result.stderr?.toString() || '';
				throw new Error(vscode.l10n.t('PowerShell Expand-Archive failed (code {0}): {1}', String(result.status), stderr.trim().slice(0, 200)));
			}
		} finally {
			fs.rmSync(scriptPath, { force: true });
		}
	} else {
		const result = spawnSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { stdio: 'pipe', timeout: 60000 });
		if (result.status !== 0) {
			const stderr = result.stderr?.toString() || '';
			throw new Error(vscode.l10n.t('unzip failed (code {0}): {1}', String(result.status), stderr.trim().slice(0, 200)));
		}
	}
}

export interface CatalogItem {
	id: string;
	kind?: string;
	displayName: string;
	description?: string;
	version?: string;
	publisher?: string;
	bundle?: string;
	installName?: string;
	icon?: string;
	downloadUrl?: string;
	/** 可选：下载内容的 SHA-256（hex）。声明后安装前会强制校验，不匹配即拒绝安装。 */
	sha256?: string;
	categories?: string[];
	tags?: string[];
}

export interface GithubSkillRepo {
	full_name: string;
	html_url: string;
	description?: string;
	stargazers_count?: number;
	language?: string;
	owner?: string;
}

/** 计算文件 SHA-256（hex，小写），用于校验 catalog 声明的 sha256 */
export function computeFileSha256(filePath: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** 计算字符串 SHA-256（hex，小写），用于校验远端 SKILL.md 内容 */
export function computeTextSha256(text: string): string {
	return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** 从 URL fragment 解析可选的 `#sha256=<64位hex>` 内容固定声明 */
export function parseSha256Fragment(rawUrl: string): string | undefined {
	try {
		const fragment = new URL(rawUrl).hash.replace(/^#/, '');
		const match = fragment.match(/^sha256=([0-9a-f]{64})$/i);
		return match ? match[1].toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}

export function resolveSkillsDir(): string {
	const configured = vscode.workspace.getConfiguration('kodrix.skills').get<string>('installDir', '~/.agents/skills');
	const expanded = configured.startsWith('~')
		? path.join(os.homedir(), configured.slice(1).replace(/^[/\\]/, ''))
		: configured;
	// 取值校验：必须是绝对路径，且不能落在文件系统根目录或用户主目录本身
	const resolved = path.resolve(expanded);
	const root = path.parse(resolved).root;
	if (!path.isAbsolute(resolved) || resolved === root || resolved === os.homedir()) {
		throw new Error(vscode.l10n.t('Invalid skill install directory (must not be the filesystem root or home directory): {0}', configured));
	}
	return resolved;
}

export function listInstalledSkills(): string[] {
	const dir = resolveSkillsDir();
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter(d => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md')))
		.map(d => d.name);
}

export function uninstallSkill(installName: string): void {
	const name = sanitizeSkillName(installName);
	const dest = path.join(resolveSkillsDir(), name);
	if (!fs.existsSync(dest)) {
		throw new Error(vscode.l10n.t('Not installed: {0}', name));
	}
	// 只删真正的 Skill 目录：防止误传到非 Skill 路径时递归删除用户数据
	if (!fs.statSync(dest).isDirectory() || !fs.existsSync(path.join(dest, 'SKILL.md'))) {
		throw new Error(vscode.l10n.t('Target is not a skill folder, deletion refused: {0}', name));
	}
	fs.rmSync(dest, { recursive: true, force: true });
}

/** Search public GitHub repos likely containing agent skills. */
export async function searchGithubSkillRepos(query: string): Promise<GithubSkillRepo[]> {
	const q = (query || 'SKILL.md cursor skill').trim();
	const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=20`;
	const raw = await fetchText(url, 0, {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
	});
	let parsed: {
		message?: string;
		items?: Array<{
			full_name: string;
			html_url: string;
			description?: string | null;
			stargazers_count?: number;
			language?: string | null;
			owner?: { login?: string };
		}>;
	};
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(vscode.l10n.t('GitHub returned an unparsable response'));
	}
	if (parsed.message && !parsed.items) {
		throw new Error(vscode.l10n.t('GitHub API: {0}', parsed.message));
	}
	return (parsed.items || []).map(it => ({
		full_name: it.full_name,
		html_url: it.html_url,
		description: it.description || undefined,
		stargazers_count: it.stargazers_count,
		language: it.language || undefined,
		owner: it.owner?.login,
	}));
}

/**
 * 目标已存在时抛出（未确认覆盖）。调用方通过 instanceof 识别并弹确认框，
 * 不依赖消息文本前缀匹配（消息文本随显示语言变化）。
 */
export class SkillExistsError extends Error {
	constructor(skillName: string) {
		super(vscode.l10n.t('{0}: {1} (not overwritten; confirm to replace)', vscode.l10n.t('A skill with this name already exists'), skillName));
		this.name = 'SkillExistsError';
	}
}

export async function installSkillFromDir(
	sourceDir: string,
	installName: string,
	options?: { overwrite?: boolean },
): Promise<string> {
	const safeName = sanitizeSkillName(installName);
	const skillMd = path.join(sourceDir, 'SKILL.md');
	if (!fs.existsSync(skillMd)) {
		throw new Error(vscode.l10n.t('SKILL.md not found in directory: {0}', sourceDir));
	}
	const destRoot = resolveSkillsDir();
	const dest = path.join(destRoot, safeName);
	fs.mkdirSync(destRoot, { recursive: true });
	if (fs.existsSync(dest)) {
		// 覆盖会删除目标目录下已有的全部内容，必须由调用方显式确认
		if (!options?.overwrite) {
			throw new SkillExistsError(safeName);
		}
		fs.rmSync(dest, { recursive: true, force: true });
	}
	fs.cpSync(sourceDir, dest, { recursive: true });
	return safeName;
}

export function resolveBuiltinBundle(extensionPath: string, bundle: string): string | undefined {
	const bundleName = sanitizeSkillName(bundle.replace(/^packages[/\\]/, ''));
	const candidates = [
		path.join(extensionPath, 'resources', 'packages', bundleName),
		path.join(extensionPath, '..', '..', '..', 'marketplace', 'packages', bundleName),
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) {
			return c;
		}
	}
	return undefined;
}

export async function installFromCatalogItem(
	extensionPath: string,
	item: CatalogItem,
	options?: { overwrite?: boolean },
): Promise<string> {
	const rawName = item.installName || item.id.split('.').pop() || 'skill';
	const name = sanitizeSkillName(rawName);

	if (item.bundle) {
		const bundlePath = resolveBuiltinBundle(extensionPath, item.bundle);
		if (!bundlePath) {
			throw new Error(vscode.l10n.t('Built-in package not found: {0}', item.bundle));
		}
		return installSkillFromDir(bundlePath, name, options);
	}

	if (item.downloadUrl) {
		// 用 mkdtemp 生成唯一临时工作目录，避免可预测路径被抢占/残留内容被复用
		const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-skill-'));
		const tmpZip = path.join(workDir, 'archive.zip');
		const extractDir = path.join(workDir, 'extract');
		try {
			await downloadFile(item.downloadUrl, tmpZip);
			// 完整性校验：catalog 声明了 sha256 就必须匹配，否则拒绝安装
			const actualSha256 = computeFileSha256(tmpZip);
			if (item.sha256) {
				if (actualSha256 !== item.sha256.trim().toLowerCase()) {
					throw new Error(vscode.l10n.t('Content hash mismatch: expected sha256 {0}, got {1}', item.sha256.trim().toLowerCase(), actualSha256));
				}
			} else {
				_diag.warn(`市场项 ${item.id} 未声明 sha256，已跳过完整性校验（实际 sha256=${actualSha256}）`);
			}
			fs.mkdirSync(extractDir, { recursive: true });
			extractZip(tmpZip, extractDir);
			verifyExtractedTree(extractDir);
			const root = findSkillRoot(extractDir);
			return installSkillFromDir(root, name, options);
		} finally {
			fs.rmSync(workDir, { recursive: true, force: true });
		}
	}

	throw new Error(vscode.l10n.t('This marketplace item has no installable source'));
}

/** 查找 SKILL.md 的最大递归深度，防止深层嵌套 zip 炸弹导致栈溢出 */
const MAX_SKILL_ROOT_DEPTH = 10;

function findSkillRoot(dir: string, depth: number = 0): string {
	if (depth > MAX_SKILL_ROOT_DEPTH) {
		throw new Error(vscode.l10n.t('Archive nesting exceeds the limit ({0}); SKILL.md not found', String(MAX_SKILL_ROOT_DEPTH)));
	}
	if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
		return dir;
	}
	const children = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory());
	if (children.length === 1) {
		return findSkillRoot(path.join(dir, children[0].name), depth + 1);
	}
	for (const c of children) {
		const sub = path.join(dir, c.name);
		if (fs.existsSync(path.join(sub, 'SKILL.md'))) {
			return sub;
		}
	}
	throw new Error(vscode.l10n.t('SKILL.md not found in the archive'));
}

/** 把 GitHub 的 blob 页面地址转成 raw 地址；非 blob 形式原样返回 */
export function toRawSkillUrl(rawUrl: string): string {
	const m = rawUrl.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/blob\/(.+)$/i);
	if (!m) {
		return rawUrl;
	}
	return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
}

export async function installFromUrl(url: string, options?: { overwrite?: boolean }): Promise<string> {
	const trimmed = toRawSkillUrl(url.trim());

	if (trimmed.endsWith('SKILL.md') || trimmed.includes('/SKILL.md')) {
		const expectedSha256 = parseSha256Fragment(trimmed);
		const content = await fetchText(trimmed);
		// 完整性：URL 带 #sha256=<hex> 时强制校验；否则至少把摘要写进日志，便于人工核对
		const actualSha256 = computeTextSha256(content);
		if (expectedSha256) {
			if (actualSha256 !== expectedSha256) {
				throw new Error(vscode.l10n.t('Content hash mismatch: expected sha256 {0}, got {1}', expectedSha256, actualSha256));
			}
		} else {
			_diag.info(`已下载 SKILL.md（sha256=${actualSha256}，未固定哈希）`);
		}
		const rawName = path.basename(path.dirname(new URL(trimmed).pathname)) || 'imported-skill';
		const name = sanitizeSkillName(rawName);
		const dest = path.join(resolveSkillsDir(), name);
		if (fs.existsSync(dest)) {
			if (!options?.overwrite) {
				throw new SkillExistsError(name);
			}
			fs.rmSync(dest, { recursive: true, force: true });
		}
		fs.mkdirSync(dest, { recursive: true });
		fs.writeFileSync(path.join(dest, 'SKILL.md'), content, 'utf-8');
		return name;
	}

	if (/github\.com/i.test(trimmed)) {
		const repo = parseGithubRepo(trimmed);
		if (!repo) {
			throw new Error(vscode.l10n.t('Unable to parse the GitHub repository URL'));
		}
		// 唯一临时工作目录；无论成功失败都在 finally 里整目录清理，避免残留
		const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-gh-'));
		const tmpZip = path.join(workDir, 'archive.zip');
		const extractDir = path.join(workDir, 'extract');
		try {
			try {
				await downloadFile(`https://github.com/${repo}/archive/refs/heads/main.zip`, tmpZip);
			} catch {
				_diag.warn(`GitHub ${repo} main.zip 下载失败，回退到 master.zip`);
				await downloadFile(`https://github.com/${repo}/archive/refs/heads/master.zip`, tmpZip);
			}
			fs.mkdirSync(extractDir, { recursive: true });
			// 仓库归档无法预先固定哈希（每次提交都会变），因此只记录实际摘要供人工核对
			_diag.info(`GitHub 归档 sha256=${computeFileSha256(tmpZip)}（${repo}，未固定哈希）`);
			extractZip(tmpZip, extractDir);
			verifyExtractedTree(extractDir);
			const root = findSkillRoot(extractDir);
			const installName = repo.split('/').pop() || 'github-skill';
			return await installSkillFromDir(root, sanitizeSkillName(installName), options);
		} finally {
			fs.rmSync(workDir, { recursive: true, force: true });
		}
	}

	throw new Error(vscode.l10n.t('Unsupported URL format. Use a GitHub repository or a raw SKILL.md link'));
}

export async function importCursorSkills(): Promise<number> {
	const cursorDir = path.join(os.homedir(), '.cursor', 'skills');
	if (!fs.existsSync(cursorDir)) {
		return 0;
	}
	let count = 0;
	const entries = fs.readdirSync(cursorDir, { withFileTypes: true });
	for (const e of entries) {
		if (!e.isDirectory()) {
			continue;
		}
		const src = path.join(cursorDir, e.name);
		if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
			continue;
		}
		try {
			// 显式批量导入：允许覆盖，但记录被替换的条目
			const existed = fs.existsSync(path.join(resolveSkillsDir(), e.name));
			await installSkillFromDir(src, e.name, { overwrite: existed });
			if (existed) {
				_diag.warn(`导入时覆盖了已存在的 Skill：${e.name}`);
			}
			count++;
		} catch (err) {
			// 单个名称非法或安装失败不应中断整批导入，记录后继续
			_diag.warn(`跳过 Skill「${e.name}」：${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return count;
}

function parseGithubRepo(ref: string): string | undefined {
	const m = ref.match(/github\.com\/([^/\s?#]+)\/([^/\s?#]+)/i);
	if (!m) {
		return undefined;
	}
	return `${m[1]}/${m[2].replace(/\.git$/, '')}`;
}

/** 允许的重定向目标主机（GitHub 的归档下载会跳到 codeload / objects） */
const TRUSTED_REDIRECT_HOSTS = new Set<string>([
	'github.com',
	'api.github.com',
	'raw.githubusercontent.com',
	'codeload.github.com',
	'objects.githubusercontent.com',
]);

/**
 * 仅接受 https 且主机名精确匹配白名单的 URL。
 * 用解析后的 hostname 比较，避免 `github.com.evil.tld`、`github.com@evil.tld`
 * 这类前缀/userinfo 绕过，也禁止明文 http 降级。
 */
export function isTrustedHttpsUrl(rawUrl: string, allowedHosts: ReadonlySet<string> = TRUSTED_REDIRECT_HOSTS): boolean {
	try {
		const parsed = new URL(rawUrl);
		return parsed.protocol === 'https:' && allowedHosts.has(parsed.hostname.toLowerCase());
	} catch {
		return false;
	}
}

/** 下载/抓取入口只允许 https（本地文件路径与明文 http 一律拒绝） */
function assertHttps(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(vscode.l10n.t('Invalid URL: {0}', url));
	}
	if (parsed.protocol !== 'https:') {
		throw new Error(vscode.l10n.t('Only https links are supported: {0}', url));
	}
}

/**
 * Fetch text content from URL with redirect limit (MAX_REDIRECTS) and size cap (MAX_TEXT_FETCH_BYTES).
 * Blocks redirects to untrusted domains.
 */
async function fetchText(url: string, _depth = 0, extraHeaders?: Record<string, string>): Promise<string> {
	if (_depth > MAX_REDIRECTS) {
		throw new Error(vscode.l10n.t('Too many redirects (>{0}): {1}', String(MAX_REDIRECTS), url));
	}
	assertHttps(url);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			headers: { 'User-Agent': 'Kodrix-Skills/1.0', ...extraHeaders },
			signal: controller.signal,
			redirect: 'manual',
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			if (!location) {
				throw new Error(vscode.l10n.t('Redirect without location header: {0}', url));
			}
			const redirectUrl = new URL(location, url);
			if (!isTrustedHttpsUrl(redirectUrl.href)) {
				throw new Error(vscode.l10n.t('Redirect to untrusted domain blocked: {0}', redirectUrl.hostname));
			}
			return fetchText(redirectUrl.href, _depth + 1, extraHeaders);
		}
		if (response.status >= 400) {
			throw new Error(vscode.l10n.t('HTTP {0}: {1}', String(response.status), url));
		}
		if (!response.body) {
			throw new Error(vscode.l10n.t('Response body is null'));
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) {break;}
			size += value.length;
			if (size > MAX_TEXT_FETCH_BYTES) {
				await reader.cancel();
				throw new Error(vscode.l10n.t('SKILL.md content exceeds {0}MB limit', String(MAX_TEXT_FETCH_BYTES / (1024 * 1024))));
			}
			chunks.push(value);
		}
		const decoder = new TextDecoder();
		return chunks.map(c => decoder.decode(c, { stream: true })).join('') + decoder.decode();
	} finally {
		clearTimeout(timer);
	}
}

async function downloadFile(url: string, dest: string, _depth = 0): Promise<void> {
	if (_depth > MAX_REDIRECTS) {
		throw new Error(vscode.l10n.t('Too many redirects (>{0}): {1}', String(MAX_REDIRECTS), url));
	}
	assertHttps(url);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			headers: { 'User-Agent': 'Kodrix-Skills/1.0' },
			signal: controller.signal,
			redirect: 'manual',
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			if (!location) {
				throw new Error(vscode.l10n.t('Redirect without location header: {0}', url));
			}
			const redirectUrl = new URL(location, url);
			if (!isTrustedHttpsUrl(redirectUrl.href)) {
				throw new Error(vscode.l10n.t('Redirect to untrusted domain blocked: {0}', redirectUrl.hostname));
			}
			return downloadFile(redirectUrl.href, dest, _depth + 1);
		}
		if (response.status >= 400) {
			throw new Error(vscode.l10n.t('HTTP {0}: {1}', String(response.status), url));
		}
		// content-length 可能缺失或非法：只有能解析成有限数值时才用它做预检，真正的上限靠流式累计
		const contentLengthHeader = response.headers.get('content-length');
		const contentLength = contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader);
		if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
			throw new Error(vscode.l10n.t('Downloaded file is too large'));
		}
		if (!response.body) {
			throw new Error(vscode.l10n.t('Response body is null'));
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			size += value.length;
			if (size > MAX_DOWNLOAD_BYTES) {
				await reader.cancel();
				try { fs.unlinkSync(dest); } catch { /* ignore ENOENT */ }
				throw new Error(vscode.l10n.t('Downloaded file is too large'));
			}
			chunks.push(value);
		}
		fs.writeFileSync(dest, Buffer.concat(chunks));
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 校验 catalog 条目形状（catalog 属本地数据，但仍按不可信输入处理）。
 * 返回 undefined 表示条目非法、应被丢弃。
 */
export function validateCatalogItem(raw: unknown): CatalogItem | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

	const id = str(record.id);
	const displayName = str(record.displayName) ?? id;
	if (!id || !displayName) {
		return undefined;
	}
	const item: CatalogItem = { id, displayName };
	for (const key of ['kind', 'description', 'version', 'publisher', 'bundle', 'installName', 'icon'] as const) {
		const value = str(record[key]);
		if (value) {
			item[key] = value;
		}
	}
	if (Array.isArray(record.categories)) {
		item.categories = record.categories.filter((c): c is string => typeof c === 'string');
	}
	if (Array.isArray(record.tags)) {
		item.tags = record.tags.filter((c): c is string => typeof c === 'string');
	}
	const downloadUrl = str(record.downloadUrl);
	if (downloadUrl) {
		try {
			if (new URL(downloadUrl).protocol !== 'https:') {
				return undefined;
			}
		} catch {
			return undefined;
		}
		item.downloadUrl = downloadUrl;
	}
	const sha256 = str(record.sha256);
	if (sha256) {
		// 声明了校验值就必须是合法 sha256，否则整条丢弃（宁可拒绝，不可静默忽略）
		if (!/^[0-9a-f]{64}$/i.test(sha256)) {
			return undefined;
		}
		item.sha256 = sha256.toLowerCase();
	}
	return item;
}

export function loadCatalog(extensionPath: string): { items: CatalogItem[] } {
	const candidates = [
		path.join(extensionPath, 'resources', 'catalog.json'),
		path.join(extensionPath, '..', '..', '..', 'marketplace', 'catalog.json'),
	];
	for (const catalogPath of candidates) {
		if (fs.existsSync(catalogPath)) {
			try {
				const raw = fs.readFileSync(catalogPath, 'utf-8');
				const parsed: unknown = JSON.parse(raw);
				if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'items') && Array.isArray((parsed as Record<string, unknown>).items)) {
					const items: CatalogItem[] = [];
					for (const rawItem of (parsed as { items: unknown[] }).items) {
						const item = validateCatalogItem(rawItem);
						if (item) {
							items.push(item);
						} else {
							_diag.warn(`已忽略非法的 catalog 条目：${JSON.stringify(rawItem).slice(0, 120)}`);
						}
					}
					return { items };
				}
			} catch (e) {
				_diag.error(`Skill 目录文件解析失败: ${catalogPath} — ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}
	return { items: [] };
}
