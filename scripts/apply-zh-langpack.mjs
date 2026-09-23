#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * apply-zh-langpack.mjs — Kodrix 界面默认简体中文（核心 UI）
 *
 * 背景：
 *   Kodrix 的 dev 构建（esbuild transpile）产物中，out/vs/nls.js 的
 *   localize(data, message) 在 data 为字符串 key（未启用 NLS 索引机制）时
 *   直接返回英文默认值，因此界面显示英文（虽然 code.bat 已传 --locale=zh-cn）。
 *
 * 本脚本做什么：
 *   1. 读取内置中文语言包（extensions/ms-ceintl.vscode-language-pack-zh-hans/
 *      translations/main.i18n.json，与 VS Code 1.128 内核匹配）。
 *   2. 将 contents{模块路径:{key: 中文}} 拍平为全局 {key: 中文} 查表；
 *      同一 key 出现多次且译文不同时，取出现频次最高的译文（上下文最常见用法）。
 *   3. 把查表逻辑注入 out/vs/nls.js：localize/localize2 在字符串 key 命中
 *      中文表时返回中文，未命中回退原逻辑（不影响 NLS 索引机制）。
 *   4. 统计 out/vs/** 中实际出现的 localize key 命中率并输出。
 *
 * 幂等：已注入（含标记）则跳过。注意 transpile 每次会重建 nls.js，
 *       因此每次构建后需重新执行本脚本（已挂接在 dev-fast.ps1 中）。
 * 还原：重新 transpile 即还原为英文原版（本脚本不再需要时可删除挂接）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const LANGPACK_MAIN = path.join(root, 'extensions', 'ms-ceintl.vscode-language-pack-zh-hans', 'translations', 'main.i18n.json');
const NLS_JS = path.join(root, 'out', 'vs', 'nls.js');
const OUT_VS = path.join(root, 'out', 'vs');
const MARK = '/* KODRIX_ZH_LANGPACK */';
const TABLE_DECL = 'const __KODRIX_ZH =';

function fail(msg) {
  console.error('[apply-zh-langpack] ERROR: ' + msg);
  process.exit(1);
}

// ---------- 1. 拍平翻译表 ----------
function flatten(langpack) {
  const freq = new Map(); // key -> Map(translation -> count)
  for (const mod of Object.keys(langpack.contents || {})) {
    const c = langpack.contents[mod];
    for (const key of Object.keys(c)) {
      const t = c[key];
      if (typeof t !== 'string') continue;
      if (!freq.has(key)) freq.set(key, new Map());
      const m = freq.get(key);
      m.set(t, (m.get(t) || 0) + 1);
    }
  }
  const out = {};
  for (const [key, m] of freq) {
    let best = null, bestN = -1;
    for (const [t, n] of m) if (n > bestN) { best = t; bestN = n; }
    out[key] = best;
  }
  return out;
}

// ---------- 2. 注入 nls.js ----------
// nls.js 存在两种编译产物变体：
//  A. ESM 版（node build/next/index.ts transpile）：无参数注释、双引号、2 空格缩进
//  B. CJS 版（gulp transpile-client）：参数带 /* | number when built */ 注释、单引号、4 空格缩进
const ORIG_LOCALIZE_VARIANTS = [
  `function localize(data, message, ...args) {
  if (typeof data === "number") {
    return _format(lookupMessage(data, message), args);
  }
  return _format(message, args);
}`,
  `function localize(data /* | number when built */, message /* | null when built */, ...args) {
    if (typeof data === 'number') {
        return _format(lookupMessage(data, message), args);
    }
    return _format(message, args);
}`,
];

const ZH_LOCALIZE = `function localize(data, message, ...args) {
  let __key = null;
  if (typeof data === "string") {
    __key = data;
  } else if (data && typeof data === "object" && typeof data.key === "string") {
    __key = data.key;
  }
  if (__key !== null) {
    const __zh = __KODRIX_ZH[__key];
    if (typeof __zh === "string") {
      return _format(__zh, args);
    }
  }
  if (typeof data === "number") {
    return _format(lookupMessage(data, message), args);
  }
  return _format(message, args);
}`;

const ORIG_LOCALIZE2_VARIANTS = [
  `function localize2(data, originalMessage, ...args) {
  let message;
  if (typeof data === "number") {
    message = lookupMessage(data, originalMessage);
  } else {
    message = originalMessage;
  }
  const value = _format(message, args);
  return {
    value,
    original: originalMessage === message ? value : _format(originalMessage, args)
  };
}`,
  `function localize2(data /* | number when built */, originalMessage, ...args) {
    let message;
    if (typeof data === 'number') {
        message = lookupMessage(data, originalMessage);
    }
    else {
        message = originalMessage;
    }
    const value = _format(message, args);
    return {
        value,
        original: originalMessage === message ? value : _format(originalMessage, args)
    };
}`,
];

const ZH_LOCALIZE2 = `function localize2(data, originalMessage, ...args) {
  let message;
  let __key = null;
  if (typeof data === "string") {
    __key = data;
  } else if (data && typeof data === "object" && typeof data.key === "string") {
    __key = data.key;
  }
  if (__key !== null && typeof __KODRIX_ZH[__key] === "string") {
    message = __KODRIX_ZH[__key];
  } else if (typeof data === "number") {
    message = lookupMessage(data, originalMessage);
  } else {
    message = originalMessage;
  }
  const value = _format(message, args);
  return {
    value,
    original: originalMessage === message ? value : _format(originalMessage, args)
  };
}`;

function apply() {
  if (!fs.existsSync(LANGPACK_MAIN)) fail(`语言包翻译文件缺失：${LANGPACK_MAIN}（请确认 extensions/ms-ceintl.vscode-language-pack-zh-hans 已安装）`);
  if (!fs.existsSync(NLS_JS)) fail(`未找到 out/vs/nls.js（请先执行编译，如 npm run build-fast）`);

  const table = flatten(JSON.parse(fs.readFileSync(LANGPACK_MAIN, 'utf8')));
  const tableJs = TABLE_DECL + JSON.stringify(table) + ';\n';

  let src = fs.readFileSync(NLS_JS, 'utf8');
  if (src.includes(MARK)) {
    console.log('[apply-zh-langpack] 已注入（含标记），跳过。若要重新生成请先重新 transpile。');
    return { skipped: true, tableSize: Object.keys(table).length };
  }

  // 头部注入翻译表（放在 getNLSMessages 之前）
  const anchor = 'function getNLSMessages() {';
  if (!src.includes(anchor)) fail('out/vs/nls.js 结构异常：找不到 getNLSMessages 锚点');
  src = src.replace(anchor, MARK + '\n' + tableJs + '\n' + anchor);

  // 替换 localize / localize2（兼容两种编译产物变体）
  let replacedLocalize = false;
  for (const variant of ORIG_LOCALIZE_VARIANTS) {
    if (src.includes(variant)) {
      src = src.replace(variant, ZH_LOCALIZE);
      replacedLocalize = true;
      break;
    }
  }
  if (!replacedLocalize) fail('out/vs/nls.js 结构异常：找不到原始 localize 函数体');
  for (const variant of ORIG_LOCALIZE2_VARIANTS) {
    if (src.includes(variant)) {
      src = src.replace(variant, ZH_LOCALIZE2);
      break;
    }
  }

  fs.writeFileSync(NLS_JS, src, 'utf8');
  return { skipped: false, tableSize: Object.keys(table).length };
}

// ---------- 3. 命中率校验 ----------
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.map')) out.push(p);
  }
  return out;
}

function verify(table) {
  const keyRe = /localize(?:2)?\(\s*(?:"([^"]+)"|'([^']+)'|\{\s*key\s*:\s*(?:"([^"]+)"|'([^']+)'))/g;
  const files = walk(OUT_VS).filter(f => !f.endsWith(path.sep + 'nls.js'));
  const hits = new Set();
  let total = 0;
  for (const f of files) {
    let s;
    try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
    let m;
    while ((m = keyRe.exec(s)) !== null) {
      const key = m[1] || m[2] || m[3] || m[4];
      if (!key || key.length > 200) continue;
      total++;
      if (typeof table[key] === 'string') hits.add(key);
    }
  }
  return { totalKeys: total, hitKeys: hits.size };
}

// ---------- main ----------
const res = apply();
const table = flatten(JSON.parse(fs.readFileSync(LANGPACK_MAIN, 'utf8')));
const v = verify(table);
const pct = v.totalKeys ? ((v.hitKeys / v.totalKeys) * 100).toFixed(2) : '0.00';
console.log(`[apply-zh-langpack] 翻译表条目：${res.tableSize}（冲突 key 已取高频译文）`);
console.log(`[apply-zh-langpack] out/vs 源码 localize key 命中率：${v.hitKeys}/${v.totalKeys}（${pct}%）`);
console.log(res.skipped
  ? '[apply-zh-langpack] 状态：已是最新（跳过写入）'
  : '[apply-zh-langpack] 状态：已注入 out/vs/nls.js，简体中文默认生效');
