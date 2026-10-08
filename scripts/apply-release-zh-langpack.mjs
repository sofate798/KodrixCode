#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/*---------------------------------------------------------------------------------------------
 *  apply-release-zh-langpack.mjs — Kodrix 发布包（VSCode-win32-*）简体中文注入
 *
 *  背景：
 *    dev 链路（dev-fast.ps1 → apply-zh-langpack.mjs）只改写 out/vs/nls.js；
 *    而发布链路 vscode-win32-*-min 用 esbuild --nls 把所有 localize(key, message)
 *    替换成 localize(数字索引, null)（见 build/next/nls-plugin.ts），
 *    运行时 bootstrap-esm.ts 按索引读取 resources/app/out/nls.messages.json
 *    （src/vs/base/node/nls.ts 的 defaultMessagesFile）。
 *    因此在发布包中，正确做法是按 nls.keys.json 的顺序，用官方语言包
 *    main.i18n.json 的译文生成“中文消息数组”，覆盖 nls.messages.json /
 *    nls.messages.js——这正是 build/lib/i18n.ts processCoreBundleFormat 的思路
 *    （上游需要 sibling vscode-loc 仓库，这里改用仓库内置的 zh-hans 语言包源）。
 *
 *  用法：
 *    node scripts/apply-release-zh-langpack.mjs --app-dir <VSCode-win32-x64 目录>
 *      [--langpack <main.i18n.json 路径>]
 *    默认语言包源：extensions/ms-ceintl.vscode-language-pack-zh-hans/translations/main.i18n.json
 *
 *  退出码：0 = 注入成功；非 0 = 失败（缺文件 / 数据不匹配 / 零命中），调用方必须告警，
 *  不得静默（build-exe.ps1 捕获后输出“本次安装包不含中文语言包”）。
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');

function parseArgs(argv) {
  const args = { appDir: '', langpack: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app-dir') { args.appDir = argv[++i] ?? ''; }
    else if (argv[i] === '--langpack') { args.langpack = argv[++i] ?? ''; }
  }
  return args;
}

function fail(msg) {
  console.error(`[apply-release-zh-langpack] ERROR: ${msg}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.appDir) { fail('缺少 --app-dir <发布包目录，如 ..\\VSCode-win32-x64>'); }
const appDir = path.resolve(args.appDir);
if (!fs.existsSync(appDir)) { fail(`发布包目录不存在: ${appDir}`); }

const outDir = path.join(appDir, 'resources', 'app', 'out');
const keysFile = path.join(outDir, 'nls.keys.json');
const messagesFile = path.join(outDir, 'nls.messages.json');
const messagesJsFile = path.join(outDir, 'nls.messages.js');
const langpackFile = path.resolve(args.langpack || process.env.KODRIX_ZH_LANGPACK ||
  path.join(repoRoot, 'extensions', 'ms-ceintl.vscode-language-pack-zh-hans', 'translations', 'main.i18n.json'));

for (const [label, f] of [['nls.keys.json', keysFile], ['nls.messages.json', messagesFile]]) {
  if (!fs.existsSync(f)) { fail(`发布包中未找到 ${label}: ${f}（请确认已完成 vscode-win32-*-min 构建）`); }
}
if (!fs.existsSync(langpackFile)) { fail(`zh-cn 语言包源缺失: ${langpackFile}`); }

/** @type {[string, string[]][]} */
const nlsKeys = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
/** @type {string[]} */
const defaultMessages = JSON.parse(fs.readFileSync(messagesFile, 'utf8'));
/** @type {{ contents: Record<string, Record<string, string>> }} */
const pack = JSON.parse(fs.readFileSync(langpackFile, 'utf8'));

if (!pack || typeof pack.contents !== 'object') { fail(`语言包格式异常（无 contents）: ${langpackFile}`); }

// 与 build/next/nls-plugin.ts finalizeNLS / src/vs/base/node/nls.ts 相同的顺序重建消息数组：
// 按 nls.keys.json 的 [moduleId, [key...]] 逐项查译文，缺失回退英文原句。
let totalKeys = 0;
let hitKeys = 0;
let idx = 0;
const translated = [];
for (const [moduleId, keys] of nlsKeys) {
  const moduleTranslations = pack.contents[moduleId];
  for (const key of keys) {
    const fallback = defaultMessages[idx];
    const zh = moduleTranslations?.[key];
    if (typeof zh === 'string' && zh.length > 0) {
      translated.push(zh);
      hitKeys++;
    } else {
      translated.push(fallback ?? key);
    }
    totalKeys++;
    idx++;
  }
}

if (idx !== defaultMessages.length) {
  console.warn(`[apply-release-zh-langpack] WARN: nls.keys.json (${idx}) 与 nls.messages.json (${defaultMessages.length}) 条目数不一致，多出的消息保留原文`);
  for (; idx < defaultMessages.length; idx++) { translated.push(defaultMessages[idx]); }
}

if (totalKeys === 0) { fail('nls.keys.json 中没有任何可翻译条目，拒绝产出（可能构建异常）'); }
if (hitKeys === 0) { fail('译文命中 0 条（语言包与当前构建 key 完全不匹配），本次不注入'); }

// nls.messages.js 与 build/next/nls-plugin.ts finalizeNLS 的输出格式保持一致
const jsHeader = '/*---------------------------------------------------------\n * Copyright (C) Microsoft Corporation. All rights reserved.\n *--------------------------------------------------------*/\n';
fs.writeFileSync(messagesFile, JSON.stringify(translated), 'utf8');
if (fs.existsSync(messagesJsFile)) {
  fs.writeFileSync(messagesJsFile, `${jsHeader}globalThis._VSCODE_NLS_MESSAGES=${JSON.stringify(translated)};`, 'utf8');
}

const pct = ((hitKeys / totalKeys) * 100).toFixed(2);
console.log(`[apply-release-zh-langpack] 已注入 zh-cn 到 ${outDir}`);
console.log(`[apply-release-zh-langpack] 翻译命中 ${hitKeys}/${totalKeys}（${pct}%），其余回退英文；来源: ${path.relative(repoRoot, langpackFile) || langpackFile}`);
console.log('[apply-release-zh-langpack] 状态：成功');
