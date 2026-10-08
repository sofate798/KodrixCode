/*---------------------------------------------------------------------------------------------
 *  本地 HTTP 桩服务 — 连接测试 / 模型探测的行为验证
 *
 *  只实现被测代码会打的少数路径，行为可由 options 现场改写：
 *    - GET  /api/tags            → { models: tags }
 *    - GET  /models, /v1/models  → { data: models }（数字表示直接返回该状态码）
 *    - POST /chat/completions 等 → chatStatus（可延迟 chatDelayMs 毫秒）
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';

export interface StubServerOptions {
	/** /models 与 /v1/models 返回的模型 id；给数字表示直接返回该 HTTP 状态码 */
	models?: string[] | number;
	/** /api/tags 返回的模型名 */
	tags?: string[];
	/** chat/completions 的状态码，默认 200 */
	chatStatus?: number;
	/** chat/completions 延迟多少毫秒再响应 */
	chatDelayMs?: number;
}

export interface StubServer {
	baseUrl: string;
	/** 收到的请求，形如 "POST /v1/chat/completions" */
	hits: string[];
	/** 可直接改写，下一次请求即生效 */
	options: StubServerOptions;
	close(): Promise<void>;
}

export async function startStubServer(options: StubServerOptions = {}): Promise<StubServer> {
	const state: StubServerOptions = { chatStatus: 200, ...options };
	const hits: string[] = [];

	const server = http.createServer((req, res) => {
		const url = req.url || '';
		hits.push(`${req.method} ${url}`);
		const json = (code: number, body: unknown) => {
			res.writeHead(code, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(body));
		};

		if (url === '/api/tags') {
			return json(200, { models: (state.tags ?? ['qwen2.5-coder:7b']).map(name => ({ name })) });
		}
		if (url.endsWith('/models')) {
			const models = state.models ?? ['model-a'];
			if (typeof models === 'number') {
				return json(models, { error: 'stub' });
			}
			return json(200, { data: models.map(id => ({ id })) });
		}
		if (url.endsWith('/chat/completions')) {
			const status = state.chatStatus ?? 200;
			const send = () => json(status, status === 200 ? { choices: [] } : { error: 'stub' });
			if (state.chatDelayMs) {
				setTimeout(send, state.chatDelayMs);
				return;
			}
			return send();
		}
		json(404, { error: `unhandled ${url}` });
	});

	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		hits,
		options: state,
		close: () => new Promise<void>(resolve => { server.close(() => resolve()); }),
	};
}
