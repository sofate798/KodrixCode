"use strict";
/*---------------------------------------------------------------------------------------------
 *  fsSafe — 原子文件写入工具
 *
 *  通过「写临时文件 + rename」保证写入的原子性，避免进程崩溃或并发写入
 *  导致 JSONL / JSON / Markdown 文件被截断或损坏。rename 在同一文件系统上是原子操作。
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
exports.isWorkspaceWriteBlocked = isWorkspaceWriteBlocked;
exports.assertWorkspaceWriteAllowed = assertWorkspaceWriteAllowed;
exports.atomicWriteFileSync = atomicWriteFileSync;
exports.atomicWriteFileAsync = atomicWriteFileAsync;
exports.atomicWriteStreamAsync = atomicWriteStreamAsync;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
/** 目标路径是否位于当前工作区内（用于区分"写用户主目录"与"写工作区"） */
function isInsideWorkspace(filePath) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const target = path.resolve(filePath);
    return folders.some(folder => {
        const root = path.resolve(folder.uri.fsPath);
        return target === root || target.startsWith(root + path.sep);
    });
}
/**
 * 不受信任工作区里禁止写**工作区内的**文件（写用户主目录下的配置/缓存仍然允许）。
 * 语义：只有 VS Code 明确告知 isTrusted === false 时才拦截；undefined（例如测试环境）按允许处理。
 */
function isWorkspaceWriteBlocked(target) {
    return vscode.workspace.isTrusted === false && isInsideWorkspace(target);
}
/** 同上的抛错版本（写操作使用；只想跳过而不想中断的调用方用 isWorkspaceWriteBlocked） */
function assertWorkspaceWriteAllowed(filePath) {
    if (isWorkspaceWriteBlocked(filePath)) {
        throw new Error(vscode_1.l10n.t('Untrusted workspace: writing to workspace file {0} was rejected (trust the workspace first)', filePath));
    }
}
/** 临时文件名：`<file>.tmp.<pid>.<rand>`（同目录，保证 rename 在同文件系统内原子） */
function tempPathFor(filePath) {
    return `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
}
/** `atomicWriteFileAsync` 的分段大小（字符数）：4MB ≈ 单次编码 10ms 量级 */
const ASYNC_WRITE_CHUNK_CHARS = 4 * 1024 * 1024;
/**
 * 原子写入文本文件：先写入 `<file>.tmp.<pid>.<rand>`，再 rename 覆盖目标。
 * 失败时清理临时文件并抛出原始错误。
 * 不受信任工作区中写工作区文件会先被 assertWorkspaceWriteAllowed 拒绝。
 */
function atomicWriteFileSync(filePath, content) {
    assertWorkspaceWriteAllowed(filePath);
    const dir = path.dirname(filePath);
    const tmp = tempPathFor(filePath);
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmp, content, 'utf-8');
        fs.renameSync(tmp, filePath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmp);
        }
        catch { /* best-effort cleanup */ }
        throw err;
    }
}
/**
 * 异步版原子写入，语义与 `atomicWriteFileSync` 完全一致。
 * 用于中等大小的内容：分段写入并在段间让出事件循环。
 * 超大内容（例如 20k 文件的索引 ≈ 50MB）请用 `atomicWriteStreamAsync`，避免先构造整段字符串。
 */
async function atomicWriteFileAsync(filePath, content) {
    assertWorkspaceWriteAllowed(filePath);
    const dir = path.dirname(filePath);
    const tmp = tempPathFor(filePath);
    try {
        await fs.promises.mkdir(dir, { recursive: true });
        const stream = fs.createWriteStream(tmp, { encoding: 'utf-8' });
        try {
            for (let offset = 0; offset < content.length; offset += ASYNC_WRITE_CHUNK_CHARS) {
                if (!stream.write(content.slice(offset, offset + ASYNC_WRITE_CHUNK_CHARS))) {
                    await new Promise(resolve => stream.once('drain', () => resolve()));
                }
                await new Promise(resolve => setImmediate(resolve));
            }
            await new Promise((resolve, reject) => {
                stream.end((err) => (err ? reject(err) : resolve()));
            });
        }
        catch (err) {
            stream.destroy();
            throw err;
        }
        await fs.promises.rename(tmp, filePath);
    }
    catch (err) {
        try {
            await fs.promises.unlink(tmp);
        }
        catch { /* best-effort cleanup */ }
        throw err;
    }
}
/**
 * 流式原子写入：由 producer 自行分段写入（可在段间让出），完成后原子 rename 覆盖目标。
 * 用于"内容大到不该先构造成一个字符串"的场景：20k 文件的索引约 50MB，
 * 一次性 `JSON.stringify` 实测单次阻塞约 175ms（数据见 `npm run measure:index-perf`）。
 * 语义与其它原子写入一致：先写 `<file>.tmp.<pid>.<rand>`，失败时清理临时文件。
 */
async function atomicWriteStreamAsync(filePath, producer, options) {
    assertWorkspaceWriteAllowed(filePath);
    const dir = path.dirname(filePath);
    const tmp = tempPathFor(filePath);
    try {
        await fs.promises.mkdir(dir, { recursive: true });
        const stream = fs.createWriteStream(tmp, { encoding: 'utf-8' });
        try {
            await producer(stream);
            await new Promise((resolve, reject) => {
                stream.end((err) => (err ? reject(err) : resolve()));
            });
        }
        catch (err) {
            stream.destroy();
            throw err;
        }
        if (options?.shouldCommit && !options.shouldCommit()) {
            throw new Error(vscode_1.l10n.t('Write canceled: the target was deleted while writing, or the build is stale'));
        }
        await fs.promises.rename(tmp, filePath);
    }
    catch (err) {
        try {
            await fs.promises.unlink(tmp);
        }
        catch { /* best-effort cleanup */ }
        throw err;
    }
}
