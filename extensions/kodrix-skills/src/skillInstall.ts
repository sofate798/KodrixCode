/*---------------------------------------------------------------------------------------------
 *  Skill 安装 — 写入 ~/.agents/skills/<name>/SKILL.md
 *  安全加固：spawn 参数数组替代 execSync 模板拼接、重定向上限、大小上限
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import * as vscode from 'vscode';

const _diag = vscode.window.createOutputChannel('Kodrix Skills', { log: true });

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_FETCH_BYTES = 2 * 1024 * 1024; // 2MB cap for SKILL.md text
const HTTP_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

/** Allow only safe directory names for skill installation */
const SAFE_NAME_RE = /^[a-zA-Z0-9_\-+.]+$/;

function sanitizeSkillName(name: string): string {
	const trimmed = name.replace(/[/\\]/g, '-').replace(/\.\./g, '-');
	if (!SAFE_NAME_RE.test(trimmed) || trimmed.length === 0 || trimmed.length > 64) {
		throw new Error(`非法的 Skill 名称：${name}`);
	}
	return trimmed;
}

/**
 * 校验解压后的文件路径，防止 Zip Slip 路径穿越攻击。
 */
function validateNoPathTraversal(extractDir: string): void {
	const resolvedBase = path.resolve(extractDir);
	function walk(dir: string): void {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			const resolved = path.resolve(full);
			if (!resolved.startsWith(resolvedBase)) {
				fs.rmSync(extractDir, { recursive: true, force: true });
				throw new Error(`Zip Slip 攻击已阻断：${resolved}`);
			}
			if (entry.isDirectory()) {
				walk(full);
			}
		}
	}
	walk(extractDir);
}

/**
 * Extract a zip file using platform-native tools with spawn + argument arrays.
 * No shell string interpolation — prevents command injection even with unusual paths.
 */
function extractZip(zipPath: string, destDir: string): void {
	if (process.platform === 'win32') {
		const result = spawnSync('powershell', [
			'-NoProfile',
			'-Command',
			`Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
		], { stdio: 'pipe', timeout: 60000 });
		if (result.status !== 0) {
			const stderr = result.stderr?.toString() || '';
			throw new Error(`PowerShell Expand-Archive 失败 (code ${result.status}): ${stderr.trim().slice(0, 200)}`);
		}
	} else {
		const result = spawnSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { stdio: 'pipe', timeout: 60000 });
		if (result.status !== 0) {
			const stderr = result.stderr?.toString() || '';
			throw new Error(`unzip 失败 (code ${result.status}): ${stderr.trim().slice(0, 200)}`);
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
}

export function resolveSkillsDir(): string {
	const configured = vscode.workspace.getConfiguration('kodrix.skills').get<string>('installDir', '~/.agents/skills');
	const expanded = configured.startsWith('~')
		? path.join(os.homedir(), configured.slice(1).replace(/^[/\\]/, ''))
		: configured;
	return expanded;
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

export async function installSkillFromDir(sourceDir: string, installName: string): Promise<string> {
	const safeName = sanitizeSkillName(installName);
	const skillMd = path.join(sourceDir, 'SKILL.md');
	if (!fs.existsSync(skillMd)) {
		throw new Error(`目录中未找到 SKILL.md：${sourceDir}`);
	}
	const destRoot = resolveSkillsDir();
	const dest = path.join(destRoot, safeName);
	fs.mkdirSync(destRoot, { recursive: true });
	if (fs.existsSync(dest)) {
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
): Promise<string> {
	const rawName = item.installName || item.id.split('.').pop() || 'skill';
	const name = sanitizeSkillName(rawName);

	if (item.bundle) {
		const bundlePath = resolveBuiltinBundle(extensionPath, item.bundle);
		if (!bundlePath) {
			throw new Error(`找不到内置包：${item.bundle}`);
		}
		return installSkillFromDir(bundlePath, name);
	}

	if (item.downloadUrl) {
		const tmpZip = path.join(os.tmpdir(), `kodrix-skill-${Date.now()}.zip`);
		await downloadFile(item.downloadUrl, tmpZip);
		const extractDir = path.join(os.tmpdir(), `kodrix-skill-extract-${Date.now()}`);
		fs.mkdirSync(extractDir, { recursive: true });
		try {
			extractZip(tmpZip, extractDir);
			validateNoPathTraversal(extractDir);
			const root = findSkillRoot(extractDir);
			return installSkillFromDir(root, name);
		} finally {
			fs.rmSync(tmpZip, { force: true });
			fs.rmSync(extractDir, { recursive: true, force: true });
		}
	}

	throw new Error('该市场项没有可用的安装源');
}

/** 查找 SKILL.md 的最大递归深度，防止深层嵌套 zip 炸弹导致栈溢出 */
const MAX_SKILL_ROOT_DEPTH = 10;

function findSkillRoot(dir: string, depth: number = 0): string {
	if (depth > MAX_SKILL_ROOT_DEPTH) {
		throw new Error(`压缩包目录嵌套层级超过上限 (${MAX_SKILL_ROOT_DEPTH})，未找到 SKILL.md`);
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
	throw new Error('压缩包中未找到 SKILL.md');
}

export async function installFromUrl(url: string): Promise<string> {
	const trimmed = url.trim();

	if (trimmed.endsWith('SKILL.md') || trimmed.includes('/SKILL.md')) {
		const content = await fetchText(trimmed);
		const rawName = path.basename(path.dirname(new URL(trimmed).pathname)) || 'imported-skill';
		const name = sanitizeSkillName(rawName);
		const dest = path.join(resolveSkillsDir(), name);
		fs.mkdirSync(dest, { recursive: true });
		fs.writeFileSync(path.join(dest, 'SKILL.md'), content, 'utf-8');
		return name;
	}

	if (/github\.com/i.test(trimmed)) {
		const repo = parseGithubRepo(trimmed);
		if (!repo) {
			throw new Error('无法解析 GitHub 仓库地址');
		}
		const zipUrl = `https://github.com/${repo}/archive/refs/heads/main.zip`;
		const tmpZip = path.join(os.tmpdir(), `kodrix-gh-${Date.now()}.zip`);
		try {
			await downloadFile(zipUrl, tmpZip);
		} catch {
			_diag.warn(`GitHub main.zip 下载失败，回退到 master.zip: ${zipUrl}`);
			await downloadFile(`https://github.com/${repo}/archive/refs/heads/master.zip`, tmpZip);
		}
		const extractDir = path.join(os.tmpdir(), `kodrix-gh-extract-${Date.now()}`);
		fs.mkdirSync(extractDir, { recursive: true });
		try {
			extractZip(tmpZip, extractDir);
		} finally {
			fs.rmSync(tmpZip, { force: true });
		}
		validateNoPathTraversal(extractDir);
		const root = findSkillRoot(extractDir);
		const installName = repo.split('/').pop() || 'github-skill';
		const result = await installSkillFromDir(root, sanitizeSkillName(installName));
		fs.rmSync(extractDir, { recursive: true, force: true });
		return result;
	}

	throw new Error('暂不支持该 URL 格式，请使用 GitHub 仓库或 raw SKILL.md 链接');
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
		if (fs.existsSync(path.join(src, 'SKILL.md'))) {
			await installSkillFromDir(src, e.name);
			count++;
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

/**
 * Fetch text content from URL with redirect limit (MAX_REDIRECTS) and size cap (MAX_TEXT_FETCH_BYTES).
 * Blocks redirects to untrusted domains.
 */
function fetchText(url: string, _depth = 0): Promise<string> {
	if (_depth > MAX_REDIRECTS) {
		return Promise.reject(new Error(`Too many redirects (>${MAX_REDIRECTS}): ${url}`));
	}
	return new Promise((resolve, reject) => {
		const lib = url.startsWith('https') ? https : http;
		const req = lib.get(url, {
			headers: { 'User-Agent': 'Kodrix-Skills/1.0' },
		}, res => {
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				const redirectUrl = new URL(res.headers.location, url);
				if (!/^(https?:\/\/)?(raw\.githubusercontent\.com|github\.com|api\.github\.com)/i.test(redirectUrl.href)) {
					reject(new Error(`Redirect to untrusted domain blocked: ${redirectUrl.hostname}`));
					return;
				}
				res.resume(); // drain response body
				fetchText(redirectUrl.href, _depth + 1).then(resolve, reject);
				return;
			}
			if (res.statusCode && res.statusCode >= 400) {
				res.resume();
				reject(new Error(`HTTP ${res.statusCode}: ${url}`));
				return;
			}
			const chunks: Buffer[] = [];
			let totalSize = 0;
			res.on('data', (c: Buffer) => {
				totalSize += c.length;
				if (totalSize > MAX_TEXT_FETCH_BYTES) {
					res.destroy();
					reject(new Error(`SKILL.md content exceeds ${MAX_TEXT_FETCH_BYTES / (1024 * 1024)}MB limit`));
					return;
				}
				chunks.push(c);
			});
			res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
			res.on('error', reject);
		});
		req.on('error', reject);
		req.setTimeout(HTTP_TIMEOUT_MS, () => {
			req.destroy();
			reject(new Error(`请求超时：${url}`));
		});
	});
}

async function downloadFile(url: string, dest: string, _depth = 0): Promise<void> {
	if (_depth > MAX_REDIRECTS) {
		throw new Error(`Too many redirects (>${MAX_REDIRECTS}): ${url}`);
	}
	return new Promise((resolve, reject) => {
		const lib = url.startsWith('https') ? https : http;
		const file = createWriteStream(dest);
		let size = 0;
		const req = lib.get(url, {
			headers: { 'User-Agent': 'Kodrix-Skills/1.0' },
		}, res => {
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				const redirectUrl = new URL(res.headers.location, url);
				if (!/^(https?:\/\/)?(raw\.githubusercontent\.com|github\.com|api\.github\.com)/i.test(redirectUrl.href)) {
					file.close();
					fs.rmSync(dest, { force: true });
					reject(new Error(`Redirect to untrusted domain blocked: ${redirectUrl.hostname}`));
					return;
				}
				file.close();
				fs.rmSync(dest, { force: true });
				downloadFile(redirectUrl.href, dest, _depth + 1).then(resolve, reject);
				return;
			}
			if (res.statusCode && res.statusCode >= 400) {
				file.close();
				fs.rmSync(dest, { force: true });
				reject(new Error(`HTTP ${res.statusCode}: ${url}`));
				return;
			}
			res.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_DOWNLOAD_BYTES) {
					res.destroy();
					file.close();
					fs.rmSync(dest, { force: true });
					reject(new Error('下载文件过大'));
				}
			});
			void pipeline(res, file).then(resolve, (err: Error) => {
				file.close();
				fs.rmSync(dest, { force: true });
				reject(err);
			});
		});
		req.on('error', (err: Error) => {
			file.close();
			fs.rmSync(dest, { force: true });
			reject(err);
		});
		req.setTimeout(HTTP_TIMEOUT_MS, () => {
			req.destroy();
			file.close();
			fs.rmSync(dest, { force: true });
			reject(new Error(`下载超时：${url}`));
		});
	});
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
				if (parsed && typeof parsed === 'object' && 'items' in parsed && Array.isArray((parsed as Record<string, unknown>).items)) {
					return parsed as { items: CatalogItem[] };
				}
			} catch (e) {
				_diag.error(`Skill 目录文件解析失败: ${catalogPath} — ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}
	return { items: [] };
}
