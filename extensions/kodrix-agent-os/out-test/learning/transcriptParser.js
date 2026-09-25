"use strict";
/*---------------------------------------------------------------------------------------------
 *  Transcript 解析 — Copilot Agent JSONL + Claude CLI 格式
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTranscriptJsonl = parseTranscriptJsonl;
exports.formatTranscriptForLearning = formatTranscriptForLearning;
exports.isSubstantiveSession = isSubstantiveSession;
function extractTextFromContent(content) {
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
                const p = part;
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
        return extractTextFromContent(content.content);
    }
    return '';
}
function stripSystemReminders(text) {
    return text
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
        .replace(/^\s+|\s+$/g, '');
}
function pushTurn(turns, role, text) {
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
function parseTranscriptJsonl(raw) {
    const turns = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        const type = entry.type;
        if (type === 'user.message') {
            const data = entry.data;
            pushTurn(turns, 'user', extractTextFromContent(data?.content));
            continue;
        }
        if (type === 'assistant.message') {
            const data = entry.data;
            const content = data?.content ?? data?.message?.content;
            pushTurn(turns, 'assistant', extractTextFromContent(content));
            continue;
        }
        if (type === 'user' && entry.message) {
            const msg = entry.message;
            if (msg.role === 'user') {
                pushTurn(turns, 'user', extractTextFromContent(msg.content));
            }
            continue;
        }
        if (type === 'assistant' && entry.message) {
            const msg = entry.message;
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
function formatTranscriptForLearning(parsed, maxChars = 12_000) {
    const lines = parsed.turns.map(t => `[${t.role.toUpperCase()}]\n${t.text}`);
    const combined = lines.join('\n\n---\n\n');
    return combined.length > maxChars ? combined.slice(-maxChars) : combined;
}
function isSubstantiveSession(parsed, minUserMessages = 1) {
    if (parsed.userMessageCount < minUserMessages) {
        return false;
    }
    const totalChars = parsed.turns.reduce((n, t) => n + t.text.length, 0);
    return totalChars >= 120;
}
