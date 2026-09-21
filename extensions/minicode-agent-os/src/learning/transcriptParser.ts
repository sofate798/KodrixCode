/*---------------------------------------------------------------------------------------------
 *  Transcript 解析 — Copilot Agent JSONL + Claude CLI 格式
 *--------------------------------------------------------------------------------------------*/

export interface ParsedTurn {
	role: 'user' | 'assistant' | 'system';
	text: string;
}

export interface ParsedTranscript {
	turns: ParsedTurn[];
	userMessageCount: number;
	assistantMessageCount: number;
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map(part => {
				if (typeof part === 'string') {
					return part;
				}
				if (part && typeof part === 'object') {
					const p = part as { type?: string; text?: string };
					if (p.type === 'text' && p.text) {
						return p.text;
					}
				}
				return '';
			})
			.filter(Boolean)
			.join('\n');
	}
	if (content && typeof content === 'object' && 'content' in content) {
		return extractTextFromContent((content as { content: unknown }).content);
	}
	return '';
}

function stripSystemReminders(text: string): string {
	return text
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
		.replace(/^\s+|\s+$/g, '');
}

function pushTurn(turns: ParsedTurn[], role: ParsedTurn['role'], text: string): void {
	const cleaned = stripSystemReminders(text).trim();
	// 仅过滤空白/极短噪声；保留「修复 bug」这类短但有意义的指令
	if (!cleaned || cleaned.length < 3) {
		return;
	}
	const last = turns.at(-1);
	if (last && last.role === role && last.text === cleaned) {
		return;
	}
	turns.push({ role, text: cleaned.slice(0, 4000) });
}

export function parseTranscriptJsonl(raw: string): ParsedTranscript {
	const turns: ParsedTurn[] = [];
	for (const line of raw.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}

		const type = entry.type as string | undefined;

		if (type === 'user.message') {
			const data = entry.data as { content?: unknown } | undefined;
			pushTurn(turns, 'user', extractTextFromContent(data?.content));
			continue;
		}
		if (type === 'assistant.message') {
			const data = entry.data as { content?: unknown; message?: { content?: unknown } } | undefined;
			const content = data?.content ?? data?.message?.content;
			pushTurn(turns, 'assistant', extractTextFromContent(content));
			continue;
		}
		if (type === 'user' && entry.message) {
			const msg = entry.message as { role?: string; content?: unknown };
			if (msg.role === 'user') {
				pushTurn(turns, 'user', extractTextFromContent(msg.content));
			}
			continue;
		}
		if (type === 'assistant' && entry.message) {
			const msg = entry.message as { role?: string; content?: unknown };
			if (msg.role === 'assistant') {
				pushTurn(turns, 'assistant', extractTextFromContent(msg.content));
			}
		}
	}

	// 仅保留最近 24 轮用于蒸馏；计数必须基于同一份 keptTurns，
	// 否则 userMessageCount 与实际返回的 turns 不一致（isSubstantiveSession 会误判）。
	const keptTurns = turns.slice(-24);
	return {
		turns: keptTurns,
		userMessageCount: keptTurns.filter(t => t.role === 'user').length,
		assistantMessageCount: keptTurns.filter(t => t.role === 'assistant').length,
	};
}

export function formatTranscriptForLearning(parsed: ParsedTranscript, maxChars = 12_000): string {
	const lines = parsed.turns.map(t => `[${t.role.toUpperCase()}]\n${t.text}`);
	const combined = lines.join('\n\n---\n\n');
	return combined.length > maxChars ? combined.slice(-maxChars) : combined;
}

export function isSubstantiveSession(parsed: ParsedTranscript, minUserMessages = 1): boolean {
	if (parsed.userMessageCount < minUserMessages) {
		return false;
	}
	const totalChars = parsed.turns.reduce((n, t) => n + t.text.length, 0);
	return totalChars >= 120;
}
