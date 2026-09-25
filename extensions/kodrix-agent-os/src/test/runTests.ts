/*---------------------------------------------------------------------------------------------
 *  独立 Mocha 测试运行器 — 不依赖 @vscode/test-electron
 *--------------------------------------------------------------------------------------------*/

import Mocha from 'mocha';
import * as path from 'path';
import * as fs from 'fs';

/** 递归查找目录下所有 .test.js 文件 */
function findTestFiles(dir: string): string[] {
	const results: string[] = [];
	if (!fs.existsSync(dir)) { return results; }
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...findTestFiles(full));
		} else if (entry.name.endsWith('.test.js')) {
			results.push(full);
		}
	}
	return results;
}

export function run(): Promise<void> {
	// 注册 vscode mock（必须在加载任何测试文件之前）
	require('./vscode-mock');

	const mocha = new Mocha({
		ui: 'tdd',
		color: true,
		timeout: 10000,
	});

	const testsRoot = path.resolve(__dirname, '.');
	const files = findTestFiles(testsRoot);
	files.forEach(f => mocha.addFile(f));

	return new Promise<void>((resolve, reject) => {
		try {
			mocha.run((failures: number) => {
				if (failures > 0) {
					reject(new Error(`${failures} test(s) failed`));
				} else {
					resolve();
				}
			});
		} catch (err) {
			reject(err);
		}
	});
}

// 直接运行时执行
if (require.main === module) {
	run().then(
		() => { process.exit(0); },
		(err) => { console.error(err); process.exit(1); },
	);
}
