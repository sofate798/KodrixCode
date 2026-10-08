/*---------------------------------------------------------------------------------------------
 *  Shared helper: load webview HTML with CSP + Codicons stylesheet.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';

/**
 * 生成一次性 nonce（每次渲染一个新的）。
 * 此前 `settingsPage` / `indexManager` 用的是**硬编码 nonce**（如 `kodrixSettingsPageN1`），
 * 等于没有防护：nonce 一旦可预测/可复用，注入的脚本带上同样的 nonce 即可执行。
 */
export function createNonce(): string {
	return crypto.randomBytes(16).toString('base64');
}

/**
 * 统一 webview CSP。
 * - 脚本：**只允许带 nonce 的内联脚本**（不再放行脚本维度的 `'unsafe-inline'`）
 * - 样式：保留 `'unsafe-inline'`（页面大量内联 style 属性/样式块，收紧会直接坏样式）
 */
export function webviewCsp(webview: vscode.Webview, nonce: string): string {
	return [
		`default-src 'none'`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
		`font-src ${webview.cspSource}`,
		`img-src ${webview.cspSource} data:`,
	].join('; ') + ';';
}

/**
 * Load an HTML file from `resources/`, inject CSP source, nonce and Codicons CSS URI.
 * `resources/**.html` 用 `{{nonce}}` 占位（CSP 与内联 <script nonce> 都要填）。
 * Callers must include `resources` (or `resources/codicons`) in `localResourceRoots`.
 *
 * 可选 `l10nDict`：webview 脚本侧的动态文案字典（宿主侧先用**字面量** l10n.t() 翻译好），
 * 经 HTML 里的 `{{l10nDict}}` 占位注入为 `const L10N = {...}`；同时 `{{htmlLang}}` 注入
 * `vscode.env.language`。脚本侧配合 `const fmt = (t, ...a) => …` 做 {0} 占位替换。
 */
export function loadWebviewHtml(
	webview: vscode.Webview,
	extensionPath: string,
	htmlFileName: string,
	nonce: string = createNonce(),
	l10nDict?: Record<string, string>,
): string {
	const resourcesDir = path.join(extensionPath, 'resources');
	const htmlPath = path.join(resourcesDir, htmlFileName);
	const codiconsCssUri = webview.asWebviewUri(
		vscode.Uri.file(path.join(resourcesDir, 'codicons', 'codicon.css')),
	);
	const html = fs.readFileSync(htmlPath, 'utf-8');
	return html
		.replace(/\{\{cspSource\}\}/g, webview.cspSource)
		.replace(/\{\{nonce\}\}/g, nonce)
		.replace(/\{\{codiconsCssUri\}\}/g, codiconsCssUri.toString())
		.replace(/\{\{htmlLang\}\}/g, vscode.env.language)
		.replace(/\{\{l10nDict\}\}/g, l10nDict ? JSON.stringify(l10nDict).replace(/</g, '\\u003c') : '{}')
		.replace(L10N_PLACEHOLDER_RE, (_m, source: string) => localizeWebviewText(source));
}

/**
 * 便捷封装：构造 webview 脚本侧文案字典。传入的Record值应全部由**字面量** l10n.t('…')
 * 调用产生（这样才能进 bundle，被 l10n:extract 收录并校验）。
 */
export function webviewL10nDict(dict: Record<string, string>): Record<string, string> {
	return dict;
}

/**
 * `{{l10n:源文案}}` 占位。文案里允许出现 `{0}`~`{9}` 形式的**运行时占位符**：
 * 页面脚本用 `fmt(文案, 值…)` 自行替换（宿主侧无参调用 `l10n.t()` 会原样保留 `{n}`），
 * 于是「带变量的动态文案」也能进 bundle。除 `{数字}` 外不允许出现花括号（避免与占位符收尾冲突）。
 */
export const L10N_PLACEHOLDER_RE = /\{\{l10n:((?:[^{}]|\{\d+\})*)\}\}/g;

/**
 * webview 资源文件里的文案本地化：`{{l10n:源文案}}` → 语言包文案。
 * 占位符里**直接写源文案**（中文），因此不需要额外维护一份键表：`l10n.t(源文案)` 的键
 * 就是源文案本身，会随 `npm run l10n:extract` 一起进 bundle。
 * 注意：源文案内不要出现 `}}` 或未转义的 `"`（属性值里请用 &quot;）。
 */
export function localizeWebviewText(source: string): string {
	const text = source.trim();
	if (!text) {return '';}
	try {
		return l10n.t(text);
	} catch {
		return text;
	}
}

/**
 * 把宿主侧的值（已本地化的文案 / 数据表）安全嵌进 webview 的 `<script>`。
 *
 * 为什么需要：宿主侧的 `l10n.t()` **不能**写在 `<script>` 里——那是一段在 webview 里执行的
 * 代码，`l10n` 只存在于扩展宿主。正确做法是宿主侧先本地化，再用本函数注入。
 * `JSON.stringify` 负责引号/换行转义，额外的 `<` → `\u003c` 防止译文里的 `</script>` 提前闭合脚本块。
 */
export function jsJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

	/** 同上，用于 HTML 属性值（防译文里的 `"` 逃出属性） */
	export function htmlAttr(text: string): string {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	/** HTML 文本/属性通用转义（含 `'`，可供 data-* / title 等属性上下文） */
	export function escapeHtml(text: string): string {
		return String(text ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

/** Resources that must be allow-listed for Codicons + page assets. */
export function webviewResourceRoots(extensionPath: string): vscode.Uri[] {
	return [vscode.Uri.file(path.join(extensionPath, 'resources'))];
}
