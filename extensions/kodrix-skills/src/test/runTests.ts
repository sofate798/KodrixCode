/*---------------------------------------------------------------------------------------------
 *  独立 Mocha 测试运行器 — 不依赖 @vscode/test-electron
 *--------------------------------------------------------------------------------------------*/

import Mocha from 'mocha';
import * as path from 'path';
import * as fs from 'fs';

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

if (require.main === module) {
	run().then(
		() => { process.exit(0); },
		(err) => { console.error(err); process.exit(1); },
	);
}
