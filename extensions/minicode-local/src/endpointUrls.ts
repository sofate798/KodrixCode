/*---------------------------------------------------------------------------------------------
 *  把供应商 base_url 收成可请求的 Chat 地址
 *
 *  OpenAI 兼容：DeepSeek 是 https://api.deepseek.com/chat/completions
 *  Anthropic 兼容：DeepSeek 是 https://api.deepseek.com/anthropic/v1/messages
 *--------------------------------------------------------------------------------------------*/

function trimSlash(url: string): string {
	return url.trim().replace(/\/+$/, '');
}

export function openaiChatCompletionsUrl(baseUrl: string, apiType: string): string {
	const base = trimSlash(baseUrl);
	if (base.endsWith('/chat/completions')) {
		return base;
	}
	if (apiType === 'ollama') {
		return `${base}/v1/chat/completions`;
	}
	if (/\/v\d+$/i.test(base)) {
		return `${base}/chat/completions`;
	}
	try {
		const host = new URL(base).host;
		if (host === 'api.openai.com' || host === 'openrouter.ai') {
			return base.includes('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
		}
	} catch {
		// 非法 URL 仍按 DeepSeek 风格拼接，让调用方拿到明确的网络错误
	}
	return `${base}/chat/completions`;
}

export function anthropicMessagesUrl(baseUrl: string): string {
	const base = trimSlash(baseUrl || 'https://api.anthropic.com');
	if (base.endsWith('/messages')) {
		return base;
	}
	if (base.endsWith('/v1')) {
		return `${base}/messages`;
	}
	return `${base}/v1/messages`;
}

/** 模型名输入：逗号、中文逗号或换行分隔，去重并保持顺序。 */
export function parseModelNames(raw: string): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const part of raw.split(/[\n,，]/)) {
		const name = part.trim();
		if (!name || seen.has(name)) {
			continue;
		}
		seen.add(name);
		names.push(name);
	}
	return names;
}
