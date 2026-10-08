/*---------------------------------------------------------------------------------------------
 *  Kodrix — 请求错误分类：把底层异常翻译成用户能照着做下一步的提示
 *
 *  背景：Chat 走 Kodrix 直连时，非 HTTP 层的失败（域名解析不了、服务没启动、证书不受信、
 *  连接超时）会以 `TypeError: fetch failed` 的形式抛出，原始信息里没有原因也没有行动建议。
 *  这里集中做分类，providerWorkbench（连接测试）与 languageModelProvider（真实请求）共用，
 *  避免同一个故障在两个入口给出不同口径的解释。
 *--------------------------------------------------------------------------------------------*/

import { l10n } from 'vscode';

/** 底层 cause 里的错误码/证书错误 → 人话 */
function classifyCause(code: string): string | undefined {
	if (/ENOTFOUND|EAI_AGAIN/.test(code)) {
		return l10n.t('DNS resolution failed. Check that base_url is spelled correctly and whether a proxy or VPN is needed.');
	}
	if (/ECONNREFUSED/.test(code)) {
		return l10n.t('Connection refused. A local service (e.g. Ollama / llama.cpp) may not be running, or the port is wrong.');
	}
	if (/ECONNRESET|EPPIPE/.test(code)) {
		return l10n.t('Connection dropped by the peer. Possibly a gateway timeout, an oversized request body, or a server error.');
	}
	if (/ETIMEDOUT|ESOCKETTIMEDOUT/.test(code)) {
		return l10n.t('Connection timed out. The service may be overloaded, or the URL points to the wrong network (e.g. a container-internal address).');
	}
	if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNKNOWN_CA|DEPTH_ZERO/.test(code)) {
		return l10n.t('Untrusted certificate. Self-signed certificates require adding the root CA to the system trust chain, or use a trusted domain.');
	}
	if (/EPROTO|SSL|TLS/.test(code)) {
		return l10n.t('TLS handshake failed. Confirm the address really serves https and that the server TLS version is supported.');
	}
	if (/EACCES|EPERM|ENETUNREACH|HOSTUNREACH/.test(code)) {
		return l10n.t('Network unreachable or blocked. Check firewall, proxy, and system network permissions.');
	}
	return undefined;
}

/** 把 cause 链上的 code/message 串成一行，供未知错误兜底展示（否则只剩 "fetch failed"，无法定位） */
function causeSummary(err: unknown): string {
	const parts: string[] = [];
	let current: unknown = err;
	for (let depth = 0; depth < 4 && current; depth++) {
		const e = current as { name?: string; message?: string; code?: string; cause?: unknown };
		const segment = [e.name, e.code, e.message].filter(Boolean).join(' ');
		if (segment) {
			parts.push(segment);
		}
		current = e.cause;
	}
	return parts.join(' ← ') || String(err);
}
function causeCode(err: unknown): string {
	const chain: unknown[] = [];
	let current: unknown = err;
	for (let depth = 0; depth < 4 && current; depth++) {
		chain.push(current);
		current = (current as { cause?: unknown }).cause;
	}
	return chain
		.map(item => {
			const e = item as { code?: string; errno?: number; name?: string; message?: string };
			return [e.code, e.name, e.message].filter(Boolean).join(' ');
		})
		.join(' ');
}

/**
 * 是否为用户主动取消（AbortError）。
 * 注意 `AbortSignal.timeout()` 抛的是 TimeoutError，属于故障而非取消，必须走描述分支。
 */
export function isCancellation(err: unknown): boolean {
	return (err as { name?: string })?.name === 'AbortError';
}

function isTimeout(err: unknown): boolean {
	const e = err as { name?: string; message?: string; cause?: { name?: string; message?: string } };
	const name = e?.name || e?.cause?.name || '';
	const message = `${e?.message || ''} ${e?.cause?.message || ''}`;
	return name === 'TimeoutError' || /timeout|timed out/i.test(message);
}

/**
 * 网络层失败（没拿到 HTTP 响应）的可行动描述。
 * 调用方应在 fetch 的 try/catch 里用本函数包装后重新抛出，Chat 里才会显示原因而不是 raw 堆栈。
 */
export function describeNetworkError(providerName: string, baseUrl: string, err: unknown): string {
	if (isTimeout(err)) {
		return l10n.t(
			'"{0}" request timed out ({1}). Local models may be slow on first load — send a manual request to warm up; for cloud models, retry later or check for gateway rate limiting.',
			providerName, baseUrl,
		);
	}
	const code = causeCode(err);
	const hint = classifyCause(code);
	return hint
		? l10n.t('"{0}" could not connect ({1}). {2}', providerName, baseUrl, hint)
		: l10n.t('"{0}" could not connect ({1}): {2}', providerName, baseUrl, causeSummary(err));
}

/**
 * 兜底包装：已经是我们自己描述过的错误（形如「供应商名」…）原样透出，
 * 其余按网络层失败分类。避免把「已给出行动建议」的信息二次套壳成含糊文案。
 */
export function describeRequestError(providerName: string, baseUrl: string, err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	// 已描述错误的特征：以「供应商名」（旧中文形态）或 "Provider name"（英文源形态）开头
	if (message.startsWith('「') || message.includes(`「${providerName}」`)
		|| message.startsWith(`"${providerName}"`) || message.includes(`"${providerName}" `)) {
		return message;
	}
	return describeNetworkError(providerName, baseUrl, err);
}

export function httpStatusHint(status: number): string {
	switch (status) {
		case 400: return l10n.t('Request rejected — usually the model ID or message format is not supported.');
		case 401: return l10n.t('The API Key is invalid or rejected by the provider. Re-enter the API Key in AI Provider Management.');
		case 402: return l10n.t('Insufficient balance or quota. Top up in the provider console and retry.');
		case 403: return l10n.t('The account has no access to this model. Make sure the key is entitled to it.');
		case 404: return l10n.t('Endpoint or model name not found. Check whether base_url needs a /v1 suffix and verify the model ID.');
		case 408: return l10n.t('Server-side processing timed out. Retry later or reduce the context size.');
		case 413: return l10n.t('Request too large for the server limit. Shorten the context or reduce attachments.');
		case 422: return l10n.t('Request content not accepted; the tool definitions or message structure may be unsupported by this model.');
		case 429: return l10n.t('Rate or usage limit hit. Retry later; if it persists, check the provider\'s quota and billing tier.');
		default:
			return status >= 500
				? l10n.t('Provider temporarily unavailable (5xx). Retry later or switch to another model.')
				: l10n.t('Check the provider configuration (base_url, model ID, API Key).');
	}
}

/** HTTP 层失败（拿到了响应但状态码非 2xx）的可行动描述 */
export function describeHttpError(providerName: string, status: number, detail: string): string {
	const suffix = detail ? l10n.t(' Provider response: {0}', detail) : '';
	return l10n.t('"{0}" request failed (HTTP {1}). {2}{3}', providerName, String(status), httpStatusHint(status), suffix);
}
