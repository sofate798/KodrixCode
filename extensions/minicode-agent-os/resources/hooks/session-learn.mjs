#!/usr/bin/env node
/**
 * Minicode Agent OS — Stop Hook 脚本
 * 读取 Agent 会话 transcript，写入 .minicode/sessions/pending/ 供扩展蒸馏学习
 */
import fs from 'fs';
import path from 'path';

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk);
	}
	const raw = Buffer.concat(chunks).toString('utf8').trim();
	return raw ? JSON.parse(raw) : {};
}

function resolveWorkspaceRoot(input) {
	if (input.cwd && fs.existsSync(input.cwd)) {
		return input.cwd;
	}
	return process.cwd();
}

async function main() {
	try {
		const input = await readStdin();
		if (input.stop_hook_active === true) {
			process.exit(0);
		}

		const root = resolveWorkspaceRoot(input);
		const pendingDir = path.join(root, '.minicode', 'sessions', 'pending');
		fs.mkdirSync(pendingDir, { recursive: true });

		let transcriptExcerpt = '';
		if (input.transcript_path && fs.existsSync(input.transcript_path)) {
			transcriptExcerpt = fs.readFileSync(input.transcript_path, 'utf8');
		}

		const sessionId = (input.session_id || `session-${Date.now()}`).replace(/[^\w.-]/g, '_');
		const payload = {
			sessionId,
			timestamp: input.timestamp || new Date().toISOString(),
			hookEvent: input.hook_event_name || 'Stop',
			transcriptPath: input.transcript_path,
			transcriptExcerpt: transcriptExcerpt.slice(0, 150_000),
			cwd: root,
		};

		fs.writeFileSync(path.join(pendingDir, `${sessionId}.json`), JSON.stringify(payload, null, 2), 'utf8');
		process.exit(0);
	} catch {
		process.exit(0);
	}
}

main();
