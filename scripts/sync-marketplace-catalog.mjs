#!/usr/bin/env node
/**
 * Sync extensions/minicode-skills/resources → marketplace/
 * Run after editing catalog.json or bundled Skill packages.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcCatalog = path.join(root, 'extensions/minicode-skills/resources/catalog.json');
const dstCatalog = path.join(root, 'marketplace/catalog.json');
const srcPackages = path.join(root, 'extensions/minicode-skills/resources/packages');
const dstPackages = path.join(root, 'marketplace/packages');

function copyDir(src, dst) {
	fs.mkdirSync(dst, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const from = path.join(src, entry.name);
		const to = path.join(dst, entry.name);
		if (entry.isDirectory()) {
			copyDir(from, to);
		} else {
			fs.copyFileSync(from, to);
		}
	}
}

if (!fs.existsSync(srcCatalog)) {
	console.error('Source catalog not found:', srcCatalog);
	process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(srcCatalog, 'utf-8'));
catalog.description = '内置 Skill 包目录（与 extensions/minicode-skills/resources/catalog.json 同步）';
fs.writeFileSync(dstCatalog, `${JSON.stringify(catalog, null, 2)}\n`, 'utf-8');

if (fs.existsSync(srcPackages)) {
	copyDir(srcPackages, dstPackages);
}

console.log('Synced marketplace catalog and packages from minicode-skills/resources.');
