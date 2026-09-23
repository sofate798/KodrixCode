// AI 升级验证脚本（node + vscode stub）
// 覆盖：多语言索引 / 语义检索 / @codebase 集成 / Rules .mdc 同步
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── 临时工作区 ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-ai-upgrade-'));
const wsRoot = path.join(tmpRoot, 'ws');
fs.mkdirSync(wsRoot, { recursive: true });

// 多语言样本
fs.writeFileSync(path.join(wsRoot, 'sample.py'), `# 用户认证模块
class UserAuth:
    """用户认证服务，负责 token 校验与用户管理"""
    def verify_token(self, token):
        return True

def create_user(name):
    """创建用户"""
    return {"name": name}

from .utils import hash_password
import os
`);
fs.writeFileSync(path.join(wsRoot, 'sample.go'), `package auth

type User struct {
	Name string
}

func (u *User) GetName() string {
	return u.Name
}

func CreateUser(name string) *User {
	return &User{Name: name}
}
`);
fs.writeFileSync(path.join(wsRoot, 'sample.rs'), `// 认证服务
pub struct Token {
    pub value: String,
}

pub fn verify_token(token: &str) -> bool {
    !token.is_empty()
}

use std::collections::HashMap;
mod utils;
`);
fs.writeFileSync(path.join(wsRoot, 'sample.ts'), `export interface User { id: string }
export function login(username: string, password: string): User {
    return { id: username };
}
`);

// ── vscode stub ──
const mockVscodePath = path.join(__dirname, 'mock-vscode-ai.js');
fs.writeFileSync(mockVscodePath, `'use strict';
module.exports = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(wsRoot)} } }],
		createFileSystemWatcher: () => ({ onDidCreate: () => ({ dispose(){} }), onDidChange: () => ({ dispose(){} }), onDidDelete: () => ({ dispose(){} }), dispose(){} }),
		getConfiguration: () => ({ get: () => true, update: async () => {} }),
		openTextDocument: async () => ({}),
	},
	window: {
		createOutputChannel: () => ({ appendLine(){}, show(){}, dispose(){} }),
		showWarningMessage: async () => undefined,
		showInformationMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showTextDocument: async () => ({}),
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
		withProgress: async (_opts, fn) => fn(),
	},
	commands: { executeCommand: async () => {} },
	lm: { selectChatModels: async () => [] },
	LanguageModelChatMessage: { User: () => ({}) },
	RelativePattern: class {},
	CancellationTokenSource: class { constructor(){ this.token = {}; } dispose(){} },
};
`);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return mockVscodePath;
	return origResolve.call(this, request, ...args);
};

const idxMod = require(path.join(__dirname, '..', 'out', 'codebase', 'projectIndexer.js'));
const semMod = require(path.join(__dirname, '..', 'out', 'codebase', 'semanticIndex.js'));
const queryMod = require(path.join(__dirname, '..', 'out', 'codebase', 'codebaseQuery.js'));
const rulesMod = require(path.join(__dirname, '..', 'out', 'context', 'rulesManager.js'));

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log(`  ✔ ${name}`);
	else { failures++; console.error(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
	console.log('\n[1] 多语言索引（TS / Python / Go / Rust）');
	const index = await idxMod.ensureProjectIndex(true);
	const names = new Set(Object.values(index.symbols).map(s => s.name));
	check('Python class UserAuth 已索引', names.has('UserAuth'));
	check('Python method verify_token 已索引', names.has('verify_token'));
	check('Python function create_user 已索引', names.has('create_user'));
	check('Go type User 已索引', names.has('User'));
	check('Go method GetName 已索引', names.has('GetName'));
	check('Go function CreateUser 已索引', names.has('CreateUser'));
	check('Rust struct Token 已索引', names.has('Token'));
	check('Rust fn verify_token 已索引（同名跨语言去重为集合存在）', names.has('verify_token'));
	check('TS function login 已索引', names.has('login'));
	const dist = index.stats.languageDistribution;
	check('语言分布含 .py/.go/.rs/.ts',
		dist['.py'] >= 1 && dist['.go'] >= 1 && dist['.rs'] >= 1 && dist['.ts'] >= 1, JSON.stringify(dist));
	const goSym = Object.values(index.symbols).find(s => s.name === 'GetName');
	check('Go 方法正确归属父类 User', goSym?.parentId?.endsWith('#User'), goSym?.parentId);
	const pySym = Object.values(index.symbols).find(s => s.name === 'create_user');
	check('Python 函数有 docComment', Boolean(pySym?.docComment), pySym?.docComment);

	console.log('\n[2] 语义检索（TF-IDF 余弦，符号级 + 文件级）');
	const symHits = semMod.searchSymbols(index, 'verify token', 5);
	check('「verify token」语义命中 verify_token', symHits.some(h => h.symbol.name === 'verify_token'),
		symHits.map(h => `${h.symbol.name}:${h.score.toFixed(2)}`).join(','));
	const zhHits = semMod.searchSymbols(index, '用户认证', 5);
	check('「用户认证」语义命中 UserAuth', zhHits.some(h => h.symbol.name === 'UserAuth'),
		zhHits.map(h => `${h.symbol.name}:${h.score.toFixed(2)}`).join(','));
	const fileHits = semMod.searchFiles(index, '认证服务', 5);
	check('文件语义「认证服务」命中 sample.rs 或 sample.py', fileHits.some(f => /sample\.(rs|py)/.test(f.filePath)),
		fileHits.map(f => `${path.basename(f.filePath)}:${f.score.toFixed(2)}`).join(','));
	const stats = semMod.getSemanticStats(index);
	check(`语义索引规模（${stats.symbols} 符号 / ${stats.files} 文件）`, stats.symbols >= 8 && stats.files >= 4, JSON.stringify(stats));

	console.log('\n[3] @codebase 集成（queryCodebase 全链路）');
	const out1 = await queryMod.queryCodebase('用户认证的 token 校验在哪里');
	check('自然语言查询输出含 verify_token', out1.includes('verify_token'), out1.slice(0, 120));
	const out2 = await queryMod.queryCodebase('login 在哪定义');
	check('定义查询输出含 login', out2.includes('login'), out2.slice(0, 120));
	const out3 = await queryMod.queryCodebase('这个项目有哪些模块');
	check('结构查询输出非空且含目录', out3.length > 50, out3.slice(0, 80));

	console.log('\n[4] Rules .mdc 体系（解析 / 转换 / 同步全链路）');
	const mdc = `---
description: React 组件规范
globs: 'src/**/*.tsx,src/**/*.ts'
---

## Rules

- 必须使用函数组件
`;
	const parsed = rulesMod.parseRuleFile(mdc);
	check('frontmatter 解析 description', parsed.meta.description === 'React 组件规范', parsed.meta.description);
	check('frontmatter 解析 globs', parsed.meta.globs === 'src/**/*.tsx,src/**/*.ts', parsed.meta.globs);
	const inst = rulesMod.ruleToInstructions(parsed.meta, parsed.body);
	check('转换 applyTo 保留 globs', inst.includes("applyTo: 'src/**/*.tsx,src/**/*.ts'"), inst.split('\n')[1]);
	check('转换 description 保留', inst.includes('description: React 组件规范'));
	const always = rulesMod.ruleToInstructions({ description: '全局规则', alwaysApply: true }, 'body');
	check('alwaysApply → applyTo **', always.includes("applyTo: '**'"));
	check('slugify 处理中文与符号', rulesMod.slugify('React 组件规范!') === 'react-组件规范', rulesMod.slugify('React 组件规范!'));

	// 同步全链路
	const rulesDir = path.join(wsRoot, '.kodrix', 'rules');
	fs.mkdirSync(rulesDir, { recursive: true });
	fs.writeFileSync(path.join(rulesDir, 'react-conventions.mdc'), mdc);
	const count = rulesMod.syncRulesToInstructions();
	check('同步返回 1 个文件', count === 1, `count=${count}`);
	const outPath = path.join(wsRoot, '.kodrix', 'instructions', 'rules', 'react-conventions.instructions.md');
	check('产物 .instructions.md 已生成', fs.existsSync(outPath));
	if (fs.existsSync(outPath)) {
		const outContent = fs.readFileSync(outPath, 'utf-8');
		check('产物含 applyTo + 正文', outContent.includes('applyTo') && outContent.includes('必须使用函数组件'));
	}
	const active = rulesMod.listActiveRules();
	check('listActiveRules 返回规则清单', active.some(r => r.name === 'react-conventions'), JSON.stringify(active));

	// 清理已删除源文件 → 产物删除
	fs.unlinkSync(path.join(rulesDir, 'react-conventions.mdc'));
	rulesMod.syncRulesToInstructions();
	check('源删除后产物自动清理', !fs.existsSync(outPath));

	console.log(failures === 0 ? '\n✅ 全部断言通过' : `\n❌ ${failures} 个断言失败`);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
	console.error('验证脚本异常:', err);
	process.exit(2);
});
