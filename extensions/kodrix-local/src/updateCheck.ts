/*---------------------------------------------------------------------------------------------
 *  Kodrix — 发布版本检查
 *
 *  背景：Kodrix 是自托管分支，product.json 没有 updateUrl，核心的自动更新服务因此处于
 *  Disabled(MissingConfiguration) 状态——用户点「检查更新」不会有任何结果。
 *  在不自建更新服务器的前提下，这里用 GitHub Releases 作为发布事实来源：
 *    - 只读地请求 releases/latest，不发送任何设备或账号信息
 *    - 频率受 kodrix.updateCheck.intervalHours 约束，且可整体关闭
 *    - 提供「查看发行说明 / 暂不 / 不再提示此版本」三种行动，而不是只弹一句“有新版本”
 *
 *  注意：本模块不试图替代核心更新通道（不静默下载安装）。签名与安装包来源校验由发布方负责。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { logWarn } from './logger';

const CONFIG_SECTION = 'kodrix.updateCheck';
const LAST_CHECK_KEY = 'kodrix.updateCheck.lastCheckAt';
const DISMISSED_TAG_KEY = 'kodrix.updateCheck.dismissedTag';
const DEFAULT_FEED_URL = 'https://api.github.com/repos/sofate798/KodrixCode/releases/latest';
const REQUEST_TIMEOUT_MS = 8_000;

export interface ReleaseInfo {
	/** 归一化后的版本号（去掉前导 v） */
	version: string;
	tag: string;
	htmlUrl: string;
	publishedAt?: string;
	draft: boolean;
	prerelease: boolean;
	/** 安装包直链（按平台挑选，取不到则 undefined） */
	assetUrl?: string;
}

/** 版本号归一化：去掉 v 前缀与构建后缀，只保留数字段 */
export function normalizeVersion(raw: string): string {
	return raw.trim().replace(/^v/i, '').split('-')[0].split('+')[0];
}

/** 逐段数字比较；缺段按 0 处理，非数字段退化为 0（保守：宁可不提醒，也不误报可升级） */
export function compareVersions(left: string, right: string): -1 | 0 | 1 {
	const a = normalizeVersion(left).split('.').map(part => Number.parseInt(part, 10) || 0);
	const b = normalizeVersion(right).split('.').map(part => Number.parseInt(part, 10) || 0);
	const length = Math.max(a.length, b.length);
	for (let index = 0; index < length; index++) {
		const x = a[index] ?? 0;
		const y = b[index] ?? 0;
		if (x > y) { return 1; }
		if (x < y) { return -1; }
	}
	return 0;
}

/** 从 releases/latest 的 JSON 里挑出当前平台可用的安装包 */
function pickAssetUrl(assets: unknown): string | undefined {
	if (!Array.isArray(assets)) {
		return undefined;
	}
	const platform = process.platform;
	const wanted = platform === 'win32' ? /\.exe$/i
		: platform === 'darwin' ? /darwin|osx|mac/i
			: /linux|\.deb$|\.rpm$|\.tar\.gz$/i;
	for (const asset of assets) {
		const name = (asset as { name?: string })?.name;
		const url = (asset as { browser_download_url?: string })?.browser_download_url;
		if (name && url && wanted.test(name)) {
			return url;
		}
	}
	return undefined;
}

/** 解析 GitHub Release 载荷；结构不符时返回 undefined（不抛，交给调用方静默处理） */
export function parseRelease(raw: unknown): ReleaseInfo | undefined {
	const item = raw as {
		tag_name?: unknown; html_url?: unknown; published_at?: unknown;
		draft?: unknown; prerelease?: unknown; assets?: unknown;
	};
	if (typeof item?.tag_name !== 'string' || !item.tag_name.trim()) {
		return undefined;
	}
	if (item.draft === true) {
		return undefined;
	}
	return {
		tag: item.tag_name.trim(),
		version: normalizeVersion(item.tag_name),
		htmlUrl: typeof item.html_url === 'string' ? item.html_url : '',
		publishedAt: typeof item.published_at === 'string' ? item.published_at : undefined,
		draft: item.draft === true,
		prerelease: item.prerelease === true,
		assetUrl: pickAssetUrl(item.assets),
	};
}

function readConfig() {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return {
		enabled: config.get<boolean>('enabled', true),
		feedUrl: config.get<string>('feedUrl', DEFAULT_FEED_URL).trim() || DEFAULT_FEED_URL,
		intervalHours: Math.max(1, config.get<number>('intervalHours', 24)),
		includePrerelease: config.get<boolean>('includePrerelease', false),
	};
}

/** 是否到了该检查的时候（首次立即，之后按间隔） */
export function shouldCheckNow(lastCheckAt: number | undefined, intervalHours: number, now = Date.now()): boolean {
	if (typeof lastCheckAt !== 'number' || !Number.isFinite(lastCheckAt)) {
		return true;
	}
	return now - lastCheckAt >= intervalHours * 3_600_000;
}

async function fetchRelease(feedUrl: string): Promise<ReleaseInfo | undefined> {
	try {
		const response = await fetch(feedUrl, {
			headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Kodrix-UpdateCheck' },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			logWarn(`版本检查未成功（HTTP ${response.status}），将在下一个间隔重试`);
			return undefined;
		}
		return parseRelease(await response.json());
	} catch (err) {
		logWarn('版本检查请求失败（网络或限流），已静默跳过', err);
		return undefined;
	}
}

/**
 * 执行一次检查。
 * @returns 是否提示了新版本（供测试与手动命令判断结果）
 */
export async function checkForReleaseUpdate(
	context: vscode.ExtensionContext,
	options?: { silent?: boolean },
): Promise<boolean> {
	const config = readConfig();
	const current = vscode.version;

	const release = await fetchRelease(config.feedUrl);
	if (!release) {
		if (!options?.silent) {
			void vscode.window.showInformationMessage(l10n.t('Kodrix: could not fetch release info. Check the network, or verify that the repository matches kodrix.updateCheck.feedUrl.'));
		}
		return false;
	}

	await context.globalState.update(LAST_CHECK_KEY, Date.now());

	const notNewer = compareVersions(release.version, current) <= 0;
	const preReleased = release.prerelease && !config.includePrerelease;
	const dismissed = context.globalState.get<string>(DISMISSED_TAG_KEY) === release.tag;
	if (notNewer || preReleased || dismissed) {
		if (!options?.silent) {
			void vscode.window.showInformationMessage(
				l10n.t('Kodrix: you are on the latest public release ({0}; latest {1}).', current, release.version),
			);
		}
		return false;
	}

	const openRelease = l10n.t('View Release Notes');
	const openAsset = release.assetUrl ? l10n.t('Download Installer') : undefined;
	const dismissVersion = l10n.t('Don\'t remind me for this version');
	const later = l10n.t('Later');

	// showInformationMessage 的按钮参数要求 string[]：没有安装包链接时不能把 undefined 传进去
	const actions = openAsset
		? [openRelease, openAsset, dismissVersion, later]
		: [openRelease, dismissVersion, later];

	const choice = await vscode.window.showInformationMessage(
		l10n.t('Kodrix {0} is available (current {1}). This product has no auto-update channel; download and install manually.',
			release.version, current),
		{ detail: release.htmlUrl, modal: false },
		...actions,
	);

	if (choice === dismissVersion) {
		await context.globalState.update(DISMISSED_TAG_KEY, release.tag);
	} else if (choice === openAsset && release.assetUrl) {
		await vscode.env.openExternal(vscode.Uri.parse(release.assetUrl));
	} else if (choice === openRelease && release.htmlUrl) {
		await vscode.env.openExternal(vscode.Uri.parse(release.htmlUrl));
	}
	return true;
}

export function registerUpdateCheck(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('kodrix.checkForUpdates', async () => {
			await checkForReleaseUpdate(context, { silent: false });
		}),
	);

	const config = readConfig();
	if (!config.enabled) {
		return;
	}
	// 启动后延迟检查：不抢首启向导的焦点，也避免离线启动时立刻报错
	const timer = setTimeout(async () => {
		if (!shouldCheckNow(context.globalState.get<number>(LAST_CHECK_KEY), config.intervalHours)) {
			return;
		}
		await checkForReleaseUpdate(context, { silent: true });
	}, 20_000);
	context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}
