"use strict";
/*---------------------------------------------------------------------------------------------
 *  测试：checkpointManager — 操作日志滚动 / 检查点列表 / 回滚路径穿越防护
 *
 *  回归覆盖：
 *    - operations.jsonl 2000 行滚动上限
 *    - listCheckpoints 过滤 auto/ 和 operations.jsonl
 *    - restoreCheckpoint 路径穿越防护（.. 段 / 绝对路径）
 *    - 检查点创建与文件写入
 *--------------------------------------------------------------------------------------------*/
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
// vscode mock 已在 runTests.ts 中注册
const vscodeMock = require('./vscode-mock');
const checkpointManager = require('../checkpoint/checkpointManager');
suite('checkpointManager', () => {
    let tmpDir;
    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-test-cp-'));
        // 设置 mock workspaceFolders 指向临时目录
        vscodeMock.workspace.workspaceFolders = [{
                uri: { fsPath: tmpDir, scheme: 'file', path: tmpDir, toString: () => tmpDir },
                name: 'test',
                index: 0,
            }];
    });
    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vscodeMock.workspace.workspaceFolders = undefined;
    });
    // ── 操作日志 ──────────────────────────────────────────────────
    suite('recordOperation / listOperations', () => {
        test('记录并读取操作日志', () => {
            const op = { type: 'test', detail: 'hello', timestamp: new Date().toISOString() };
            checkpointManager.recordOperation(op);
            const ops = checkpointManager.listOperations(10);
            assert.ok(Array.isArray(ops));
            assert.strictEqual(ops.length, 1);
            assert.strictEqual(ops[0].type, 'test');
            assert.strictEqual(ops[0].detail, 'hello');
        });
        test('多条记录按顺序读取', () => {
            for (let i = 0; i < 5; i++) {
                checkpointManager.recordOperation({ type: `op-${i}`, detail: '', timestamp: new Date().toISOString() });
            }
            const ops = checkpointManager.listOperations(100);
            assert.strictEqual(ops.length, 5);
            assert.strictEqual(ops[0].type, 'op-0');
            assert.strictEqual(ops[4].type, 'op-4');
        });
        test('滚动上限：超过 2000 行后截断到 2000', () => {
            // 写入 2100 条记录
            const largeContent = Array.from({ length: 2100 }, (_, i) => JSON.stringify({ type: `op-${i}`, detail: 'x'.repeat(200), timestamp: new Date().toISOString() })).join('\n') + '\n';
            // 直接写入 operations.jsonl
            const cpRoot = path.join(tmpDir, '.kodrix', 'checkpoints');
            fs.mkdirSync(cpRoot, { recursive: true });
            fs.writeFileSync(path.join(cpRoot, 'operations.jsonl'), largeContent, 'utf-8');
            // 再追加一条触发滚动清理
            checkpointManager.recordOperation({ type: 'trigger-roll', detail: '', timestamp: new Date().toISOString() });
            const ops = checkpointManager.listOperations(5000);
            // 滚动后应 ≤ 2000 行（加上新追加的 1 条 = 最多 2001）
            assert.ok(ops.length <= 2001, `Expected ≤ 2001 ops, got ${ops.length}`);
            // 最新一条应在列表中
            const last = ops[ops.length - 1];
            assert.strictEqual(last.type, 'trigger-roll');
        });
    });
    // ── listCheckpoints ────────────────────────────────────────────
    suite('listCheckpoints', () => {
        test('空目录返回空数组', () => {
            const list = checkpointManager.listCheckpoints();
            assert.ok(Array.isArray(list));
            assert.strictEqual(list.length, 0);
        });
        test('过滤 auto/ 和 operations.jsonl', () => {
            const cpRoot = path.join(tmpDir, '.kodrix', 'checkpoints');
            fs.mkdirSync(cpRoot, { recursive: true });
            // 创建有效检查点
            const cpDir = path.join(cpRoot, '2025-01-01T00-00-00-000Z');
            fs.mkdirSync(cpDir, { recursive: true });
            fs.writeFileSync(path.join(cpDir, 'manifest.json'), JSON.stringify({
                id: '2025-01-01T00-00-00-000Z',
                label: 'test',
                createdAt: '2025-01-01T00:00:00.000Z',
                files: [{ relPath: 'test.ts', content: 'hello' }],
            }));
            // 创建 auto/ 目录（应被过滤）
            fs.mkdirSync(path.join(cpRoot, 'auto'), { recursive: true });
            // 创建 operations.jsonl（应被过滤）
            fs.writeFileSync(path.join(cpRoot, 'operations.jsonl'), '{}\n', 'utf-8');
            const list = checkpointManager.listCheckpoints();
            assert.strictEqual(list.length, 1);
            assert.strictEqual(list[0].id, '2025-01-01T00-00-00-000Z');
            assert.strictEqual(list[0].label, 'test');
            assert.strictEqual(list[0].fileCount, 1);
        });
    });
    // ── restoreCheckpoint — 路径穿越防护 ────────────────────────────
    suite('restoreCheckpoint — 路径穿越防护', () => {
        test('拒绝 .. 穿越路径', async () => {
            const cpRoot = path.join(tmpDir, '.kodrix', 'checkpoints');
            const cpDir = path.join(cpRoot, 'evil-checkpoint');
            fs.mkdirSync(cpDir, { recursive: true });
            fs.writeFileSync(path.join(cpDir, 'manifest.json'), JSON.stringify({
                id: 'evil-checkpoint',
                label: 'evil',
                createdAt: new Date().toISOString(),
                files: [
                    { relPath: '../../etc/passwd', content: 'hacked' },
                    { relPath: 'safe-file.ts', content: 'safe' },
                ],
            }));
            const result = await checkpointManager.restoreCheckpoint('evil-checkpoint');
            // .. 路径应被跳过
            assert.strictEqual(result.skipped, 1);
            assert.strictEqual(result.restored, 1);
            // 确认穿越文件未被写入
            assert.strictEqual(fs.existsSync(path.join(tmpDir, '..', '..', 'etc', 'passwd')), false);
            // 安全文件应被写入
            assert.strictEqual(fs.existsSync(path.join(tmpDir, 'safe-file.ts')), true);
        });
        test('拒绝绝对路径', async () => {
            const cpRoot = path.join(tmpDir, '.kodrix', 'checkpoints');
            const cpDir = path.join(cpRoot, 'abs-checkpoint');
            fs.mkdirSync(cpDir, { recursive: true });
            const absPath = process.platform === 'win32' ? 'C:\\Windows\\System32\\config' : '/etc/shadow';
            fs.writeFileSync(path.join(cpDir, 'manifest.json'), JSON.stringify({
                id: 'abs-checkpoint',
                label: 'abs',
                createdAt: new Date().toISOString(),
                files: [{ relPath: absPath, content: 'hacked' }],
            }));
            const result = await checkpointManager.restoreCheckpoint('abs-checkpoint');
            assert.strictEqual(result.skipped, 1);
            assert.strictEqual(result.restored, 0);
        });
        test('不存在的检查点抛出错误', async () => {
            try {
                await checkpointManager.restoreCheckpoint('nonexistent');
                assert.fail('Should have thrown');
            }
            catch (err) {
                assert.ok(err instanceof Error);
                assert.ok(err.message.includes('不存在'));
            }
        });
    });
    // ── createCheckpoint ───────────────────────────────────────────
    suite('createCheckpoint', () => {
        test('创建检查点并写入 manifest.json', async () => {
            // 模拟一个打开的文本文档
            const testFile = path.join(tmpDir, 'open-doc.ts');
            fs.writeFileSync(testFile, 'console.log("hello");', 'utf-8');
            vscodeMock.workspace.textDocuments = [{
                    uri: { fsPath: testFile, scheme: 'file', path: testFile, toString: () => testFile },
                    fileName: testFile,
                    isDirty: false,
                    getText: () => 'console.log("hello");',
                }];
            const id = await checkpointManager.createCheckpoint('test-label');
            assert.ok(typeof id === 'string');
            assert.ok(id.length > 0);
            // 验证 manifest 已写入
            const manifestPath = path.join(tmpDir, '.kodrix', 'checkpoints', id, 'manifest.json');
            assert.ok(fs.existsSync(manifestPath));
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            assert.strictEqual(manifest.label, 'test-label');
            assert.ok(Array.isArray(manifest.files));
            assert.strictEqual(manifest.files.length, 1);
            assert.strictEqual(manifest.files[0].relPath, 'open-doc.ts');
            // 清理
            vscodeMock.workspace.textDocuments = [];
        });
    });
});
