/*---------------------------------------------------------------------------------------------
 *  endpointSafety — 携带用户 API Key 的请求端点校验
 *
 *  端点设置已声明为 application 作用域（工作区 .vscode/settings.json 无法覆盖），
 *  这里是运行时的第二道防线：只允许 https，或回环地址上的 http（本地模型服务）。
 *--------------------------------------------------------------------------------------------*/

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 端点是否允许携带 Authorization 头发出请求 */
export function isSafeApiEndpoint(raw: string): boolean {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return false;
	}
	if (url.username || url.password) {
		return false;
	}
	if (url.protocol === 'https:') {
		return true;
	}
	return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}
