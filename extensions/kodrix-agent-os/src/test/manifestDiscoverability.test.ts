/*---------------------------------------------------------------------------------------------
 *  测试：可发现性贡献点（活动栏容器 / Launcher 视图 / viewsWelcome / walkthrough）
 *
 *  这些贡献点有一个共同特点：**写错了不会报错，只是静默不生效**（视图不出现、按钮点了没反应），
 *  编译、lint、运行日志都发现不了。所以只能断言清单本身：
 *    - 活动栏容器图标文件真实存在
 *    - Launcher 视图 id 在源码里确有注册（否则真实构建里贡献点静默失效）
 *    - viewsWelcome 的 markdown `command:` 链接指向**已声明**的命令
 *    - walkthrough 步骤结构完整，completionEvents 指向已声明命令
 *    - 这些贡献点引用的所有 `%nls 键%` 在 en / zh-cn 两份文件里都存在
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..');
const EXTENSIONS_ROOT = path.resolve(EXT_ROOT, '..');
const pkg = require(path.join(EXT_ROOT, 'package.json'));
const contributes = pkg.contributes ?? {};

/**
 * 已声明命令 = **三个 Kodrix 扩展的并集**。
 * 命令在 VS Code 里是全局的，agent-os 的 welcome 完全可以链接 kodrix-local 的命令
 * （如 kodrix.openProviderWorkbench）；只查本扩展会把这类合法引用误判为"未声明"，
 * 反之漏查则会放过"链接到一个谁都没声明的命令"（点击静默无反应）。
 */
const declaredCommands: string[] = ['kodrix-local', 'kodrix-agent-os', 'kodrix-skills']
	.flatMap(ext => {
		try {
			const manifest = require(path.join(EXTENSIONS_ROOT, ext, 'package.json'));
			return (manifest.contributes?.commands ?? []).map((c: { command: string }) => c.command) as string[];
		} catch {
			return [];
		}
	});
assert.ok(declaredCommands.length > 50, `应收集到三扩展的命令声明，实际 ${declaredCommands.length}`);

const en = require(path.join(EXT_ROOT, 'package.nls.json'));
const zh = require(path.join(EXT_ROOT, 'package.nls.zh-cn.json'));

/** 递归收集源码文件内容（只用 .ts，排除测试目录） */
function shippedSources(): string {
	const roots = [path.join(EXT_ROOT, 'src')];
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== 'test') {walk(full);}
			} else if (entry.name.endsWith('.ts')) {
				out.push(fs.readFileSync(full, 'utf-8'));
			}
		}
	};
	for (const r of roots) {walk(r);}
	return out.join('\n');
}

/** 从 markdown 文本里抽出 `command:xxx` 链接目标 */
function commandLinks(markdown: string): string[] {
	const links: string[] = [];
	for (const m of markdown.matchAll(/\]\(command:([^)\s?]+)/g)) {
		links.push(m[1]);
	}
	return links;
}

suite('manifestDiscoverability — 可发现性贡献点', () => {

	test('活动栏容器声明完整且图标文件存在', () => {
		const containers = contributes.viewsContainers?.activitybar ?? [];
		const kodrix = containers.find((c: { id: string }) => c.id === 'kodrix');
		assert.ok(kodrix, '应声明 id 为 kodrix 的活动栏容器');
		assert.ok(fs.existsSync(path.join(EXT_ROOT, kodrix.icon)), `容器图标不存在：${kodrix.icon}`);

		const icon = fs.readFileSync(path.join(EXT_ROOT, kodrix.icon), 'utf-8');
		assert.ok(icon.includes('currentColor'), '活动栏图标必须用 currentColor 以跟随主题');
	});

	test('Launcher 视图已声明、在源码中注册，并有 welcome 内容', () => {
		const views = contributes.views?.kodrix ?? [];
		assert.ok(views.some((v: { id: string }) => v.id === 'kodrix.launcher'), '应在 kodrix 容器下声明 launcher 视图');

		// 与仓库的贡献点检查脚本同源的要求：视图 id 必须出现在源码里，否则真实构建里静默失效
		const sources = shippedSources();
		assert.ok(sources.includes('kodrix.launcher'), '视图 id 必须出现在源码（registerTreeDataProvider）中');

		const welcome = (contributes.viewsWelcome ?? []).find((w: { view: string }) => w.view === 'kodrix.launcher');
		assert.ok(welcome, 'launcher 视图应提供 viewsWelcome 内容（面板的全部内容来源）');
	});

	test('viewsWelcome 的 command 链接都指向已声明的命令', () => {
		const welcome = contributes.viewsWelcome ?? [];
		assert.ok(welcome.length > 0);

		let linkCount = 0;
		for (const w of welcome as { view: string; contents: string }[]) {
			const text = resolveNls(w.contents);
			for (const target of commandLinks(text)) {
				linkCount++;
				// workbench.action.* 是内核命令，不要求在本扩展声明
				if (target.startsWith('workbench.')) {continue;}
				assert.ok(
					declaredCommands.includes(target),
					`${w.view} 的 welcome 链接指向未声明命令：${target}（点击将静默无反应）`,
				);
			}
		}
		assert.ok(linkCount >= 10, `welcome 应提供足够的入口，实际链接数 ${linkCount}`);
	});

	test('walkthrough 步骤结构完整且事件指向已声明命令', () => {
		const wts = (contributes.walkthroughs ?? []) as { id: string; title: string; description: string; steps: { id: string; title: string; description: string; media?: { markdown?: string }; completionEvents?: string[] }[] }[];
		assert.strictEqual(wts.length >= 1, true, '应至少有一个 walkthrough');

		for (const wt of wts) {
			assert.ok(wt.id && wt.title && wt.description, 'walkthrough 需 id/title/description');
			assert.ok(wt.steps.length >= 3, 'walkthrough 至少 3 步才有引导价值');

			const ids = new Set<string>();
			for (const step of wt.steps) {
				assert.ok(step.id && step.title && step.description, `步骤字段缺失：${step.id}`);
				assert.ok(!ids.has(step.id), `步骤 id 重复：${step.id}`);
				ids.add(step.id);
				assert.ok(step.media?.markdown, `步骤缺少 media.markdown：${step.id}（没有内容会显示空步骤）`);

				for (const ev of step.completionEvents ?? []) {
					const cmd = ev.replace(/^onCommand:/, '');
					assert.ok(
						declaredCommands.includes(cmd) || cmd.startsWith('workbench.'),
						`步骤 ${step.id} 的 completionEvent 指向未声明命令：${cmd}`,
					);
				}
			}
		}
	});

	test('新贡献点引用的 nls 键在 en / zh-cn 中都存在', () => {
		const raw = fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf-8');
		const used = new Set<string>();
		for (const m of raw.matchAll(/%([A-Za-z0-9_.\-]+)%/g)) {
			used.add(m[1]);
		}
		assert.ok(used.size > 100, `应解析到大量 nls 键，实际 ${used.size}`);

		const missingEn = [...used].filter(k => !Object.hasOwn(en, k));
		const missingZh = [...used].filter(k => !Object.hasOwn(zh, k));
		assert.deepStrictEqual(missingEn, [], `package.nls.json 缺失键：${missingEn.join(', ')}`);
		assert.deepStrictEqual(missingZh, [], `package.nls.zh-cn.json 缺失键：${missingZh.join(', ')}`);
	});

	test('viewsWelcome / walkthrough 文案不得为空或与键名相同', () => {
		for (const w of (contributes.viewsWelcome ?? []) as { view: string; contents: string }[]) {
			const text = resolveNls(w.contents);
			assert.ok(text !== w.contents, `${w.view}: nls 键未解析（文案会原样显示键名）`);
			assert.ok(text.trim().length > 20, `${w.view}: welcome 文案过短`);
		}
	});
});

/** `%key%` → 实际文案；非 `%…%` 形态原样返回 */
function resolveNls(value: string): string {
	const m = /^%([A-Za-z0-9_.\-]+)%$/.exec(value.trim());
	if (!m) {return value;}
	return en[m[1]] ?? value;
}
