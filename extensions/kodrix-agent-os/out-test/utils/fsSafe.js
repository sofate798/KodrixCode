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
exports.atomicWriteFileSync = atomicWriteFileSync;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * 原子写入文本文件：先写入 `<file>.tmp.<pid>.<rand>`，再 rename 覆盖目标。
 * 失败时清理临时文件并抛出原始错误。
 */
function atomicWriteFileSync(filePath, content) {
    const dir = path.dirname(filePath);
    const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
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
