/*---------------------------------------------------------------------------------------------
 *  测试：发布版本检查
 *
 *  这些函数决定「要不要打扰用户」，因此必须可证伪：
 *    - 误报可升级 → 用户被反复弹框，最终关掉整个功能
 *    - 漏报 → 更新提示形同虚设
 *    - 解析宽松 → 预发布或草稿版本被当成正式版推送
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

require('./vscode-mock');
const updateCheck = require('../updateCheck');

suite('发布版本检查 — 版本比较与载荷解析', () => {

	test('normalizeVersion 去掉 v 前缀与预发布/构建后缀', () => {
		assert.strictEqual(updateCheck.normalizeVersion('v1.128.0'), '1.128.0');
		assert.strictEqual(updateCheck.normalizeVersion('V1.128.0'), '1.128.0');
		assert.strictEqual(updateCheck.normalizeVersion('1.128.0-beta.3'), '1.128.0');
		assert.strictEqual(updateCheck.normalizeVersion(' 1.128.0+build9 '), '1.128.0');
	});

	test('compareVersions 正确处理主/次/补丁位进位', () => {
		assert.strictEqual(updateCheck.compareVersions('1.128.0', '1.129.0'), -1);
		assert.strictEqual(updateCheck.compareVersions('1.129.0', '1.128.9'), 1);
		assert.strictEqual(updateCheck.compareVersions('2.0.0', '1.99.99'), 1);
		assert.strictEqual(updateCheck.compareVersions('1.128.0', '1.128.0'), 0);
	});

	test('位数不等时缺段按 0，不做字符串比较', () => {
		assert.strictEqual(updateCheck.compareVersions('1.128', '1.128.0'), 0);
		// 字符串比较会得出 '9' > '10'，这里必须证明走的是数字比较
		assert.strictEqual(updateCheck.compareVersions('1.9', '1.10'), -1);
	});

	test('非数字段退化为 0，宁可不提醒也不误报可升级', () => {
		// 非法/无法解析的一端按 0 处理：当前版本会被判为“更新”，从而不会弹“可升级”
		assert.strictEqual(updateCheck.compareVersions('1.128.0', 'latest'), 1);
		assert.ok(updateCheck.compareVersions('garbage', '1.0.0') <= 0);
	});

	test('parseRelease 拒绝缺少 tag 与草稿版本', () => {
		assert.strictEqual(updateCheck.parseRelease({}), undefined);
		assert.strictEqual(updateCheck.parseRelease({ tag_name: '  ' }), undefined);
		assert.strictEqual(updateCheck.parseRelease({ tag_name: 'v1.2.0', draft: true }), undefined);
	});

	test('parseRelease 归一化正常载荷', () => {
		const release = updateCheck.parseRelease({
			tag_name: 'v1.129.0',
			html_url: 'https://github.com/x/y/releases/tag/v1.129.0',
			published_at: '2026-10-01T00:00:00Z',
			prerelease: false,
			assets: [],
		});

		assert.strictEqual(release.tag, 'v1.129.0');
		assert.strictEqual(release.version, '1.129.0');
		assert.strictEqual(release.draft, false);
	});

	test('parseRelease 标记预发布，由调用方决定是否提示', () => {
		const release = updateCheck.parseRelease({ tag_name: 'v2.0.0-rc1', prerelease: true });

		assert.strictEqual(release.prerelease, true);
		assert.strictEqual(release.version, '2.0.0', '预发布号不应混进版本比较');
	});

	test('shouldCheckNow 首次立即检查，之后按间隔', () => {
		const now = Date.now();

		assert.strictEqual(updateCheck.shouldCheckNow(undefined, 24, now), true);
		assert.strictEqual(updateCheck.shouldCheckNow(now - 60_000, 24, now), false);
		assert.strictEqual(updateCheck.shouldCheckNow(now - 25 * 3_600_000, 24, now), true);
	});

	test('shouldCheckNow 对异常存量值退化为“可以检查”，不卡死', () => {
		assert.strictEqual(updateCheck.shouldCheckNow(Number.NaN, 24, Date.now()), true);
		assert.strictEqual(updateCheck.shouldCheckNow('not-a-number' as unknown, 24, Date.now()), true);
	});
});
