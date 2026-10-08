/*---------------------------------------------------------------------------------------------
 *  Kodrix Agent OS — 用户可编辑文本文件的容错读取
 *
 *  背景：memory.md / wiki/*.md / 各类 instructions 文件都由用户直接编辑，实践中会出现：
 *    - 编辑器保存为「UTF-8 with BOM」→ 文件首部多出 U+FEFF，被当成正文注入 Agent 上下文
 *    - 保存为 UTF-16（记事本"Unicode"默认）→ 按 UTF-8 解出满屏 \u0000 乱码
 *    - 中文传统编码（GBK）→ 中文变 U+FFFD 替换字符
 *    - 文件被占用/权限不足 → readFileSync 抛错，把整条上下文组装链路带崩
 *  这里统一处理：**要么返回干净文本，要么返回 undefined**，绝不抛错。
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { logger } from '../logger';

/**
 * 读取文本文件（同步），容错 BOM / UTF-16 / GBK，且读失败返回 undefined 而不抛错。
 * @param filePath 绝对路径
 */
export function readUserTextFileSync(filePath: string): string | undefined {
	try {
		const buf = fs.readFileSync(filePath);
		return decodeTextBuffer(buf, filePath);
	} catch (err) {
		logger.warn(`[TextFile] 读取失败（已降级跳过）：${filePath} — ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
}

/** 异步版本（供索引等大批量读取路径复用） */
export async function readUserTextFile(filePath: string): Promise<string | undefined> {
	try {
		const buf = await fs.promises.readFile(filePath);
		return decodeTextBuffer(buf, filePath);
	} catch (err) {
		logger.warn(`[TextFile] 读取失败（已降级跳过）：${filePath} — ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
}

/**
 * 把字节解码为文本：BOM 判定编码 → 去 BOM → 非法 UTF-8 时回退 GBK。
 * 导出的目的是让"必须拿到字符串"的调用方（如索引解析）复用同一套判定，避免各处各写一遍。
 */
export function decodeTextBuffer(buf: Buffer, filePath = ''): string {
	// 1) UTF-16 BOM
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
		const text = buf.subarray(2).toString('utf16le');
		logger.info(`[TextFile] 按 UTF-16LE 解码：${filePath || '(buffer)'}`);
		return stripBom(text);
	}
	if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
		// UTF-16BE：Node 无内置解码，先按 16 位交换后复用 utf16le
		const swapped = Buffer.from(buf.subarray(2));
		swapped.swap16();
		logger.info(`[TextFile] 按 UTF-16BE 解码：${filePath || '(buffer)'}`);
		return stripBom(swapped.toString('utf16le'));
	}

	const utf8 = buf.toString('utf-8');
	// 2) 非法 UTF-8（替换字符）→ 尝试 GBK（中文传统编码源码/文档）
	if (utf8.includes('\uFFFD')) {
		try {
			// Node 自带完整 ICU 时可用
			const gbk = new TextDecoder('gbk', { fatal: false }).decode(buf);
			if (!gbk.includes('\uFFFD')) {
				logger.info(`[TextFile] 非 UTF-8，已按 GBK 解码：${filePath || '(buffer)'}`);
				return stripBom(gbk);
			}
		} catch {
			/* 环境不支持 gbk：保持 UTF-8 结果 */
		}
	}
	// 3) UTF-8（含可能的 BOM）
	return stripBom(utf8);
}

/** 去掉首部 BOM（U+FEFF）：否则它会被当作正文注入上下文，也会污染首行匹配 */
export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
