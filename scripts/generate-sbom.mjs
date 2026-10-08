#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/*---------------------------------------------------------------------------------------------
 *  generate-sbom.mjs — 离线生成 CycloneDX 1.5 SBOM（无网络依赖）
 *
 *  替换 release job 中原先不存在的 `sbom-tools` CLI 调用。数据源为仓库
 *  package-lock.json（lockfileVersion 3），输出 components 列表。
 *  用法: node scripts/generate-sbom.mjs <output.json>
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const outPath = process.argv[2] || path.join(repoRoot, 'sbom', 'kodrix.sbom.json');

function fail(msg) {
  console.error(`[generate-sbom] ERROR: ${msg}`);
  process.exit(1);
}

const lockPath = path.join(repoRoot, 'package-lock.json');
if (!fs.existsSync(lockPath)) { fail(`未找到 ${lockPath}`); }
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
if (lock.lockfileVersion !== 3 && lock.lockfileVersion !== 2) { fail(`不支持的 lockfileVersion: ${lock.lockfileVersion}`); }

let product = {};
try { product = JSON.parse(fs.readFileSync(path.join(repoRoot, 'product.json'), 'utf8')); } catch { /* optional */ }

const components = [];
for (const [key, entry] of Object.entries(lock.packages || {})) {
  if (!key.startsWith('node_modules/')) { continue; } // 仓库自身与 workspace 条目跳过
  if (entry.dev) { continue; }                       // 仅生产依赖
  const name = entry.name || key.split('/').pop();
  if (!entry.version) { continue; }
  components.push({
    'bom-ref': `${name}@${entry.version}`,
    type: 'library',
    name,
    version: entry.version,
    purl: `pkg:npm/${encodeURIComponent(name).replace(/%40/g, '@')}@${entry.version}`,
    ...(entry.license ? { licenses: [{ license: { id: String(entry.license) } }] } : {})
  });
}

const metadata = {
  timestamp: new Date().toISOString(),
  tools: [{ vendor: 'Kodrix', name: 'generate-sbom.mjs', version: '1.0.0' }],
  components: [{
    'bom-ref': 'kodrix',
    type: 'application',
    name: product.nameLong || 'Kodrix',
    version: lock.packages?.['']?.version || product.version || 'unknown'
  }]
};

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${cryptoRandomUuid()}`,
  version: 1,
  metadata,
  components
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(bom, null, 2), 'utf8');
console.log(`[generate-sbom] ${components.length} 个生产依赖组件已写入 ${outPath}`);

function cryptoRandomUuid() {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) { bytes[i] = Math.floor(Math.random() * 256); }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
