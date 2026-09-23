// 战略项验证：全局用户偏好画像 + Tab 补全通道 + Background Agent + 可视化 DAG
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 隔离用户目录：patch os.homedir → 临时目录（避免污染真实 ~/.kodrix）
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-str-'));
const wsRoot = path.join(tmpRoot, 'ws');
fs.mkdirSync(wsRoot, { recursive: true });
fs.mkdirSync(path.join(wsRoot, '.kodrix'), { recursive: true });
const origHomedir = os.homedir;
os.homedir = () => tmpRoot;

const config = { 'kodrix.tabCompletion.enabled': false, 'kodrix.modelRouter.enabled': true };

const mockPath = path.join(__dirname, 'mock-vscode-str.js');
fs.writeFileSync(mockPath, `'use strict';
const __pool = [
	{ id: 'gpt-4o-mini', name: 'GPT-4o mini', family: 'gpt-4o-mini',
		async sendRequest() {
			return { stream: (async function* () {
				yield new (require('vscode').LanguageModelTextPart)('后台任务成果已完成调研');
			})() };
		} },
];
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(wsRoot)} } }],
		getConfiguration: (section) => ({
			get: (key, def) => {
				const o = global.__kodrixStrConfig || {};
				return o[section + '.' + key] ?? def;
			},
		}),
		openTextDocument: async () => ({ uri: {} }),
	},
	window: {
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		showTextDocument: async () => ({}),
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
	},
	commands: { registerCommand: (_id, fn) => ({ dispose() {} }), executeCommand: async () => undefined },
	lm: {
		selectChatModels: async ({ family } = {}) => {
			if (!family) return __pool;
			return __pool.filter(m => m.family === family);
		},
	},
	languages: { registerInlineCompletionItemProvider: () => ({ dispose() {} }) },
	LanguageModelChatMessage: { User: (text) => ({ role: 'user', text }) },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
	ThemeIcon: class {},
};
`);

// config 通过 global 暴露给 mock（mock 顶层不引用它）
global.__kodrixStrConfig = config;

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockPath;
	return origResolve.call(this, request, ...args);
};

const up = require(path.join(__dirname, '..', 'out', 'profile', 'userProfile.js'));
const tc = require(path.join(__dirname, '..', 'out', 'completion', 'tabCompletion.js'));
const bg = require(path.join(__dirname, '..', 'out', 'background', 'backgroundAgent.js'));
const cv = require(path.join(__dirname, '..', 'out', 'crew', 'crewVisualizer.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
	console.log('\n[A] 全局用户偏好画像');
	check('画像路径在临时目录', up.getUserProfilePath().startsWith(tmpRoot), up.getUserProfilePath());
	const profile = { language: 'English', tone: 'technical', techStack: ['React', 'TypeScript'], codingStyle: '2-space, semicolons', keyConstraints: ['不用 jQuery', '注释用英文'] };
	up.saveUserProfile(profile);
	check('保存后文件存在', fs.existsSync(up.getUserProfilePath()));
	const loaded = up.loadUserProfile();
	check('读回语言', loaded.language === 'English', loaded.language);
	check('读回技术栈', loaded.techStack?.length === 2, JSON.stringify(loaded.techStack));
	const inj = up.getProfileInjection();
	check('注入含语言', inj.includes('English'));
	check('注入含技术栈', inj.includes('React, TypeScript'));
	check('注入含约束', inj.includes('不用 jQuery'));
	check('注入含生效声明', inj.includes('必须遵循'));
	// 默认值
	fs.rmSync(up.getUserProfilePath(), { force: true });
	const def = up.loadUserProfile();
	check('缺失 → 默认语言', def.language === '简体中文', def.language);
	fs.writeFileSync(up.getUserProfilePath(), '{bad json', 'utf-8');
	check('损坏 → 默认（不抛）', up.loadUserProfile().tone === '简洁专业');
	// 注册
	const ctxA = { subscriptions: [] };
	up.registerUserProfile(ctxA);
	check('注册 2 命令（view/reset）', ctxA.subscriptions.length === 2, String(ctxA.subscriptions.length));

	console.log('\n[B] Tab 补全模型通道');
	const prompt = tc.buildCompletionPrompt({ prefix: 'function add(a, b) {\n  return ', suffix: '}', language: 'typescript' });
	check('prompt 含 CURSOR', prompt.includes('<CURSOR>'));
	check('prompt 含语言', prompt.includes('typescript'));
	check('prompt 含上下文行', prompt.includes('function add'));
	check('extractCompletion 剥离围栏', tc.extractCompletion('```ts\nconst x = 1;\n```') === 'const x = 1;');
	check('extractCompletion 无围栏原文', tc.extractCompletion('hello world') === 'hello world');
	check('extractCompletion 去首尾空行', tc.extractCompletion('\n\nalpha\n  ') === 'alpha');
	check('extractCompletion 空串', tc.extractCompletion('') === '');
	// 默认关闭 → undefined
	config['kodrix.tabCompletion.enabled'] = false;
	const off = await tc.provideTabCompletion({ prefix: 'x', suffix: '', language: 'ts' });
	check('默认关闭返回 undefined', off === undefined, String(off));
	// 开启 → 走 fast 模型生成
	config['kodrix.tabCompletion.enabled'] = true;
	const on = await tc.provideTabCompletion({ prefix: 'function f() {\n  return 1;\n}\n\nf(', suffix: '', language: 'ts' });
	check('开启后返回补全文本', typeof on === 'string' && on.length > 0, JSON.stringify(on));
	// 注册 provider
	const ctxB = { subscriptions: [] };
	tc.registerTabCompletion(ctxB);
	check('注册 InlineCompletion provider', ctxB.subscriptions.length === 3, String(ctxB.subscriptions.length));

	console.log('\n[C] Background Agent');
	const task1 = { id: 'bg-test-1', title: '调研现状并输出方案', status: 'running', createdAt: new Date().toISOString() };
	await bg.runBackgroundTask(task1);
	check('执行完成状态', task1.status === 'completed', task1.status + ' / ' + task1.error);
	check('结果已写入', Boolean(task1.result?.includes('后台任务成果')), String(task1.result).slice(0, 60));
	check('完成时间已记录', Boolean(task1.finishedAt));
	check('任务文件已落盘', fs.existsSync(path.join(wsRoot, '.kodrix', 'background', 'bg-test-1.json')));
	const created = await bg.createBackgroundTask(' 生成测试报告 ');
	check('createBackgroundTask 返回任务', Boolean(created?.id) && created.status === 'running');
	check('title 已 trim', created.title === '生成测试报告', created.title);
	check('create 后文件存在', Boolean(created) && fs.existsSync(path.join(wsRoot, '.kodrix', 'background', created.id + '.json')));
	const list = bg.listBackgroundTasks();
	check('列表含 2 个任务', list.length === 2, String(list.length));
	check('列表新→旧', list[0].createdAt >= list[1].createdAt);
	const ctxC = { subscriptions: [] };
	bg.registerBackgroundAgent(ctxC);
	check('注册 3 命令（dispatch/list/panel）', ctxC.subscriptions.length === 3, String(ctxC.subscriptions.length));

	console.log('\n[D] 可视化 DAG 编排');
	const crew = {
		name: '测试Crew',
		tasks: [
			{ id: 'a', title: '需求分析', assignedRole: 'architect', status: 'completed', dependencies: [] },
			{ id: 'b', title: '架构设计', assignedRole: 'architect', status: 'completed', dependencies: ['a'] },
			{ id: 'c', title: '编码实现', assignedRole: 'coder', status: 'running', dependencies: ['b'] },
			{ id: 'd', title: '代码评审', assignedRole: 'reviewer', status: 'pending', dependencies: ['c'] },
			{ id: 'e', title: '运维部署', assignedRole: 'devops', status: 'failed', dependencies: ['d'] },
		],
	};
	const layers = cv.computeLayers(crew.tasks);
	check('a 层 0', layers.get('a') === 0);
	check('b 层 1', layers.get('b') === 1);
	check('c 层 2', layers.get('c') === 2);
	check('e 层 4（最长链）', layers.get('e') === 4, String(layers.get('e')));
	const pos = cv.layoutNodes(crew.tasks, layers);
	check('坐标含全部任务', crew.tasks.every(t => pos.has(t.id)));
	check('跨层 x 错开', pos.get('a').x !== pos.get('b').x);
	const html = cv.renderCrewDagHtml(crew);
	check('HTML 含 svg', html.includes('<svg'));
	check('HTML 含 5 节点', (html.match(/<g>/g) || []).length === 5, String((html.match(/<g>/g) || []).length));
	check('HTML 含箭头边', html.includes('marker-end'));
	check('HTML 含 4 条依赖边', (html.match(/marker-end/g) || []).length === 4, String((html.match(/marker-end/g) || []).length));
	check('HTML 状态色 completed 绿', html.includes('#4caf50'));
	check('HTML 状态色 failed 红', html.includes('#f44336'));
	check('HTML 含任务标题', html.includes('编码实现'));
	check('HTML 含图例', html.includes('legend'));
	const ctxD = { subscriptions: [] };
	cv.registerCrewVisualizer(ctxD);
	check('注册 1 命令', ctxD.subscriptions.length === 1, String(ctxD.subscriptions.length));

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	os.homedir = origHomedir;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('验证脚本异常:', err); os.homedir = origHomedir; process.exit(2); });
