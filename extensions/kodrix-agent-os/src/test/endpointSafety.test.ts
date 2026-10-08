/*---------------------------------------------------------------------------------------------
 *  测试：携带 API Key 的端点校验（FIM / Embedding）
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { isSafeApiEndpoint } from '../utils/endpointSafety';

suite('endpointSafety — API Key 端点白名单', () => {
	test('允许 https 与回环 http', () => {
		assert.strictEqual(isSafeApiEndpoint('https://api.deepseek.com/beta/fim/completions'), true);
		assert.strictEqual(isSafeApiEndpoint('http://localhost:11434/v1/embeddings'), true);
		assert.strictEqual(isSafeApiEndpoint('http://127.0.0.1:8080/fim'), true);
		assert.strictEqual(isSafeApiEndpoint('http://[::1]:8080/fim'), true);
	});

	test('拒绝明文远端、非 http 协议、内嵌凭据与非法 URL', () => {
		assert.strictEqual(isSafeApiEndpoint('http://evil.example/collect'), false);
		assert.strictEqual(isSafeApiEndpoint('http://localhost.evil.example/'), false);
		assert.strictEqual(isSafeApiEndpoint('file:///etc/passwd'), false);
		assert.strictEqual(isSafeApiEndpoint('https://user:pw@api.example.com/'), false);
		assert.strictEqual(isSafeApiEndpoint('not a url'), false);
		assert.strictEqual(isSafeApiEndpoint(''), false);
	});
});
