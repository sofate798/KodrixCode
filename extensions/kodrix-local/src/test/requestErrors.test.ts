/*---------------------------------------------------------------------------------------------
 *  测试：请求错误分类
 *
 *  目标：Chat / 连接测试里遇到的底层故障，必须变成「说清原因 + 给出下一步」的提示，
 *  而不是 `TypeError: fetch failed` 这种用户无法处理的信息。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

const requestErrors = require('../requestErrors');

/** 构造 Node fetch 失败时那种带 cause 与 code 的 TypeError（返回 unknown，贴近真实抛出物） */
function fetchFailed(code: string): unknown {
	const inner = new Error(`connect ${code} 127.0.0.1:11434`) as Error & { code?: string };
	inner.code = code;
	const outer = new TypeError('fetch failed') as TypeError & { cause?: unknown };
	outer.cause = inner;
	return outer;
}

function namedError(name: string, message: string): unknown {
	const err = new Error(message) as Error & { name: string };
	err.name = name;
	return err;
}

suite('请求错误分类 — 把底层异常翻译为可行动提示', () => {

	test('本地服务未启动（ECONNREFUSED）提示去检查服务是否启动', () => {
		const message: string = requestErrors.describeNetworkError('Ollama', 'http://127.0.0.1:11434/v1', fetchFailed('ECONNREFUSED'));

		assert.ok(message.includes('Ollama'), '要带上供应商名，多供应商时才能定位');
		assert.ok(message.includes('127.0.0.1:11434'), '要带上地址');
		assert.ok(/not running|port/.test(message), `应给出“服务未启动/端口”类指引，实际：${message}`);
	});

	test('域名解析失败提示检查地址拼写与代理', () => {
		const message: string = requestErrors.describeNetworkError('OpenAI', 'https://api.openai.com/v1', fetchFailed('ENOTFOUND'));

		assert.ok(/resolution failed/.test(message), `实际：${message}`);
		assert.ok(/proxy|VPN|spelled/.test(message), `实际：${message}`);
	});

	test('自签证书要给出信任链指引，而不是裸 SSL 错误', () => {
		const message: string = requestErrors.describeNetworkError('Local', 'https://192.168.1.9:8080/v1', fetchFailed('DEPTH_ZERO_SELF_SIGNED_CERT'));

		assert.ok(/certificate/.test(message), `实际：${message}`);
		assert.ok(/trust/.test(message), `实际：${message}`);
	});

	test('超时不算用户取消，必须给出预热/重试建议', () => {
		const timeout = namedError('TimeoutError', 'The operation was aborted due to timeout');

		const message: string = requestErrors.describeNetworkError('Ollama', 'http://127.0.0.1:11434/v1', timeout);

		assert.ok(/timed out/.test(message), `实际：${message}`);
		assert.strictEqual(requestErrors.isCancellation(timeout), false, 'TimeoutError 不能被当作取消');
	});

	test('用户主动取消原样透出，不包装成故障', () => {
		const abort = namedError('AbortError', 'This operation was aborted');

		assert.strictEqual(requestErrors.isCancellation(abort), true);
	});

	test('未知错误码退化为原始 message，不编造原因', () => {
		const err = fetchFailed('EXOTIC_CODE');

		const message: string = requestErrors.describeNetworkError('X', 'https://x.test/v1', err);

		assert.ok(message.includes('EXOTIC_CODE'), `应保留原始线索，实际：${message}`);
	});

	test('HTTP 状态码分类覆盖 401/402/404/429/5xx', () => {
		assert.ok(/API Key/.test(requestErrors.httpStatusHint(401)));
		assert.ok(/balance|quota/.test(requestErrors.httpStatusHint(402)), '额度不足要单独说明，不能混进“权限”');
		assert.ok(/model/.test(requestErrors.httpStatusHint(404)));
		assert.ok(/rate|quota|usage/.test(requestErrors.httpStatusHint(429)));
		assert.ok(/Retry later/.test(requestErrors.httpStatusHint(503)));
	});

	test('HTTP 描述保留服务商返回片段，便于自查', () => {
		const message: string = requestErrors.describeHttpError('DeepSeek', 400, 'invalid_request_error: unknown model');

		assert.ok(message.includes('HTTP 400'), `实际：${message}`);
		assert.ok(message.includes('unknown model'), `实际：${message}`);
	});

	test('已描述过的错误不被二次套壳', () => {
		const already = new Error('"DeepSeek" could not connect (https://api.deepseek.com/v1): Connection refused.');

		const message: string = requestErrors.describeRequestError('DeepSeek', 'https://api.deepseek.com/v1', already);

		assert.strictEqual(message, already.message);
	});

	test('未描述过的错误走网络分类', () => {
		const message: string = requestErrors.describeRequestError('DeepSeek', 'https://api.deepseek.com/v1', fetchFailed('ECONNREFUSED'));

		assert.ok(/could not connect/.test(message), `实际：${message}`);
	});
});
