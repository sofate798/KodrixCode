"use strict";
/*---------------------------------------------------------------------------------------------
 *  测试：applyManager — diffLines / renderUnifiedDiff / validateChange
 *
 *  回归覆盖：
 *    - LCS diff 正确性（空文本 / 相同 / 全删 / 全增 / 混合）
 *    - 大文件降级（DIFF_DP_CELL_LIMIT）
 *    - 统一 diff hunk 头格式（@@ -1,N +1,M @@）
 *    - validateChange 路径穿越 / edit 唯一匹配 / 幂等判据
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
// vscode mock 在 runTests.ts 中已注册，此处 require 源模块安全
const applyManager = require('../apply/applyManager');
suite('applyManager', () => {
    // ── diffLines ──────────────────────────────────────────────────
    suite('diffLines', () => {
        test('空文本 → 空文本 返回空数组', () => {
            const result = applyManager.diffLines('', '');
            assert.strictEqual(result.length, 0);
        });
        test('空 → 非空 全新增', () => {
            const result = applyManager.diffLines('', 'line1\nline2');
            assert.ok(result.every(d => d.type === 'add'));
            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].text, 'line1');
            assert.strictEqual(result[1].text, 'line2');
        });
        test('非空 → 空 全删除', () => {
            const result = applyManager.diffLines('line1\nline2', '');
            assert.ok(result.every(d => d.type === 'del'));
            assert.strictEqual(result.length, 2);
        });
        test('完全相同 全 same', () => {
            const result = applyManager.diffLines('a\nb\nc', 'a\nb\nc');
            assert.ok(result.every(d => d.type === 'same'));
            assert.strictEqual(result.length, 3);
        });
        test('中间插入行', () => {
            const result = applyManager.diffLines('a\nc', 'a\nb\nc');
            const types = result.map(d => d.type);
            assert.deepStrictEqual(types, ['same', 'add', 'same']);
        });
        test('中间删除行', () => {
            const result = applyManager.diffLines('a\nb\nc', 'a\nc');
            const types = result.map(d => d.type);
            assert.deepStrictEqual(types, ['same', 'del', 'same']);
        });
        test('替换行 = 删除 + 新增', () => {
            const result = applyManager.diffLines('a\nold\nc', 'a\nnew\nc');
            const adds = result.filter(d => d.type === 'add');
            const dels = result.filter(d => d.type === 'del');
            assert.strictEqual(adds.length, 1);
            assert.strictEqual(dels.length, 1);
            assert.strictEqual(adds[0].text, 'new');
            assert.strictEqual(dels[0].text, 'old');
        });
        test('大文件降级：超过 DIFF_DP_CELL_LIMIT 时全删+全增', () => {
            // DIFF_DP_CELL_LIMIT = 2_000_000
            // n * m > 2M → 降级。取 n=2000, m=2000 → 4M > 2M
            const oldLines = Array.from({ length: 2000 }, (_, i) => `old-${i}`).join('\n');
            const newLines = Array.from({ length: 2000 }, (_, i) => `new-${i}`).join('\n');
            const result = applyManager.diffLines(oldLines, newLines);
            // 降级时：所有旧行 del + 所有新行 add
            const dels = result.filter(d => d.type === 'del');
            const adds = result.filter(d => d.type === 'add');
            assert.strictEqual(dels.length, 2000);
            assert.strictEqual(adds.length, 2000);
            // 不应有 same
            const same = result.filter(d => d.type === 'same');
            assert.strictEqual(same.length, 0);
        });
    });
    // ── renderUnifiedDiff ──────────────────────────────────────────
    suite('renderUnifiedDiff', () => {
        test('hunk 头格式：标准 @@ -1,N +1,M @@', () => {
            const diff = applyManager.renderUnifiedDiff('test.ts', 'a\nb', 'a\nc\nb');
            const lines = diff.split('\n');
            assert.strictEqual(lines[0], '--- a/test.ts');
            assert.strictEqual(lines[1], '+++ b/test.ts');
            // 旧 2 行，新 3 行
            assert.strictEqual(lines[2], '@@ -1,2 +1,3 @@');
        });
        test('diff 体包含 +/- 前缀', () => {
            const diff = applyManager.renderUnifiedDiff('f.ts', 'old', 'new');
            assert.ok(diff.includes('-old'));
            assert.ok(diff.includes('+new'));
        });
        test('相同内容 diff 仅有空格前缀行', () => {
            const diff = applyManager.renderUnifiedDiff('f.ts', 'a\nb', 'a\nb');
            const bodyLines = diff.split('\n').slice(3); // 跳过 --- +++ @@
            assert.ok(bodyLines.every((l) => l.startsWith(' ')));
        });
    });
    // ── validateChange ─────────────────────────────────────────────
    suite('validateChange', () => {
        let tmpDir;
        suiteSetup(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-test-apply-'));
        });
        suiteTeardown(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });
        test('路径穿越被拒绝', () => {
            const change = { filePath: '../../etc/passwd', type: 'write', newContent: 'x' };
            const result = applyManager.validateChange(change, tmpDir);
            assert.strictEqual(result.ok, false);
            assert.ok(result.error?.includes('越界'));
        });
        test('write 新文件 通过', () => {
            const change = { filePath: 'new-file.ts', type: 'write', newContent: 'hello' };
            const result = applyManager.validateChange(change, tmpDir);
            assert.strictEqual(result.ok, true);
        });
        test('edit 缺少 oldContent 报错', () => {
            const fp = path.join(tmpDir, 'edit-test.ts');
            fs.writeFileSync(fp, 'content', 'utf-8');
            const change = { filePath: 'edit-test.ts', type: 'edit', newContent: 'new' };
            const result = applyManager.validateChange(change, tmpDir);
            assert.strictEqual(result.ok, false);
            assert.ok(result.error?.includes('oldContent'));
        });
        test('edit oldContent 唯一匹配 通过', () => {
            const fp = path.join(tmpDir, 'edit-unique.ts');
            fs.writeFileSync(fp, 'hello world', 'utf-8');
            const change = { filePath: 'edit-unique.ts', type: 'edit', oldContent: 'hello', newContent: 'hi' };
            const result = applyManager.validateChange(change, tmpDir);
            assert.strictEqual(result.ok, true);
        });
        test('edit oldContent 多处匹配 报错', () => {
            const fp = path.join(tmpDir, 'edit-multi.ts');
            fs.writeFileSync(fp, 'aaa\nbbb\naaa', 'utf-8');
            const change = { filePath: 'edit-multi.ts', type: 'edit', oldContent: 'aaa', newContent: 'ccc' };
            const result = applyManager.validateChange(change, tmpDir);
            assert.strictEqual(result.ok, false);
            assert.ok(result.error?.includes('匹配'));
        });
        test('delete 不存在的文件 报错', () => {
            const change = { filePath: 'no-such-file.ts', type: 'delete', newContent: '' };
            const result = applyManager.validateChange(change, tmpDir);
            assert.strictEqual(result.ok, false);
            assert.ok(result.error?.includes('不存在'));
        });
    });
    // ── applyProposal（幂等判据）──────────────────────────────────
    suite('applyProposal — 幂等', () => {
        let tmpDir;
        suiteSetup(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-test-apply-idem-'));
        });
        suiteTeardown(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });
        test('edit 已应用过（新内容已存在）→ 跳过而非失败', async () => {
            const fp = path.join(tmpDir, 'idempotent.ts');
            // 文件已包含新内容（模拟已应用）
            fs.writeFileSync(fp, 'const x = 42;', 'utf-8');
            const proposal = {
                name: 'test-idem',
                createdAt: new Date().toISOString(),
                changes: [{
                        filePath: 'idempotent.ts',
                        type: 'edit',
                        oldContent: 'const x = 1;', // 旧内容已不在
                        newContent: 'const x = 42;', // 新内容已存在
                    }],
            };
            const result = await applyManager.applyProposal(proposal, tmpDir, { checkpoint: false, backup: false });
            // 应被识别为已应用（跳过），而非校验失败
            assert.strictEqual(result.applied.length, 0);
            assert.ok(result.skipped.length > 0);
            assert.ok(result.skipped[0].reason.includes('已应用'));
        });
    });
    // ── staged 文件清理 ────────────────────────────────────────────
    suite('applyProposal — staged 清理', () => {
        let tmpDir;
        suiteSetup(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodrix-test-apply-stage-'));
        });
        suiteTeardown(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });
        test('应用后 staged 临时目录被清理', async () => {
            // 先创建一个提案并 stage
            const proposal = {
                name: 'cleanup-test',
                createdAt: new Date().toISOString(),
                changes: [{
                        filePath: 'staged-file.ts',
                        type: 'write',
                        newContent: 'content',
                    }],
            };
            // 手动创建 staged 目录模拟残留
            const applyDir = path.join(tmpDir, '.kodrix', 'apply', 'cleanup-test', 'staged');
            fs.mkdirSync(applyDir, { recursive: true });
            fs.writeFileSync(path.join(applyDir, 'leftover.txt'), 'stale', 'utf-8');
            await applyManager.applyProposal(proposal, tmpDir, { checkpoint: false, backup: false });
            // staged 目录应被清理
            assert.strictEqual(fs.existsSync(applyDir), false);
        });
    });
});
