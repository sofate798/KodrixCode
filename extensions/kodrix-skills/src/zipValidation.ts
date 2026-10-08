/*---------------------------------------------------------------------------------------------
 *  Kodrix Skills — 压缩包预校验
 *
 *  在解压**之前**解析 ZIP 中央目录，用于拦截：
 *    - 条目数 / 解压后总大小超限（zip bomb）
 *    - 路径穿越（../）、绝对路径（/foo、C:\foo）、UNC 路径
 *    - 符号链接条目、加密条目、重名条目（覆盖游戏）
 *  不依赖 Expand-Archive / unzip 自身的防护，因此在 Windows 与 POSIX 上行为一致、可单测。
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { l10n } from 'vscode';

export const MAX_ARCHIVE_ENTRIES = 2000;
/** 解压后允许的总字节数（压缩包文件本身另有 50MB 下载上限） */
export const MAX_ARCHIVE_TOTAL_BYTES = 200 * 1024 * 1024;
export const MAX_ARCHIVE_PATH_DEPTH = 20;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP64_MARKER = 0xFFFFFFFF;
const UNIX_FILE_TYPE_MASK = 0xF000;
const UNIX_SYMLINK_TYPE = 0xA000;

export interface ZipArchiveSummary {
	entries: number;
	totalUncompressedBytes: number;
}

/** 定位中央目录结束记录（EOCD 尾部可能带最多 65535 字节注释） */
function findEndOfCentralDirectory(buffer: Buffer): number {
	const minOffset = Math.max(0, buffer.length - 0xFFFF - 22);
	for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
		if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
			return offset;
		}
	}
	throw new Error(l10n.t('Not a valid ZIP file (end of central directory record not found)'));
}

function validateEntryPath(entryName: string): void {
	if (!entryName) {
		throw new Error(l10n.t('Archive contains an empty entry name'));
	}
	if (entryName.startsWith('/') || /^[a-zA-Z]:/.test(entryName)) {
		throw new Error(l10n.t('Archive contains an absolute path entry: {0}', entryName));
	}
	const segments = entryName.split('/').filter(segment => segment.length > 0 && segment !== '.');
	for (const segment of segments) {
		if (segment === '..') {
			throw new Error(l10n.t('Archive contains a path traversal entry: {0}', entryName));
		}
		if (segment.includes(':')) {
			throw new Error(l10n.t('Archive entry name contains an illegal character: {0}', entryName));
		}
	}
	if (segments.length > MAX_ARCHIVE_PATH_DEPTH) {
		throw new Error(l10n.t('Archive entry is nested too deeply (>{0}): {1}', String(MAX_ARCHIVE_PATH_DEPTH), entryName));
	}
}

/**
 * 校验 ZIP 归档；不合法直接抛错，调用方应在**解压前**调用。
 */
export function validateZipArchive(zipPath: string): ZipArchiveSummary {
	const buffer = fs.readFileSync(zipPath);
	const eocd = findEndOfCentralDirectory(buffer);
	const entryCount = buffer.readUInt16LE(eocd + 10);
	const centralSize = buffer.readUInt32LE(eocd + 12);
	const centralOffset = buffer.readUInt32LE(eocd + 16);

	if (entryCount === 0xFFFF || centralOffset === ZIP64_MARKER || centralSize === ZIP64_MARKER) {
		throw new Error(l10n.t('ZIP64 archives are not supported (use a regular zip)'));
	}
	if (entryCount > MAX_ARCHIVE_ENTRIES) {
		throw new Error(l10n.t('Archive has too many entries ({0} > {1})', String(entryCount), String(MAX_ARCHIVE_ENTRIES)));
	}
	if (centralOffset + centralSize > buffer.length) {
		throw new Error(l10n.t('ZIP central directory is out of bounds; the file may be corrupted'));
	}

	let offset = centralOffset;
	let totalUncompressedBytes = 0;
	const seenNames = new Set<string>();

	for (let i = 0; i < entryCount; i++) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) {
			throw new Error(l10n.t('ZIP central directory structure is corrupted'));
		}
		const flags = buffer.readUInt16LE(offset + 8);
		const uncompressedSize = buffer.readUInt32LE(offset + 24);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const externalAttributes = buffer.readUInt32LE(offset + 38);
		const rawName = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

		if (flags & 0x1) {
			throw new Error(l10n.t('Archive contains an encrypted entry: {0}', rawName));
		}
		if (uncompressedSize === ZIP64_MARKER) {
			throw new Error(l10n.t('ZIP64 entry size is not supported: {0}', rawName));
		}
		if (((externalAttributes >>> 16) & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK_TYPE) {
			throw new Error(l10n.t('Archive contains a symbolic link entry: {0}', rawName));
		}

		// 反斜杠在 zip 中可能被用作分隔符，统一后再判断穿越
		validateEntryPath(rawName.replace(/\\/g, '/'));

		const key = rawName.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
		if (key) {
			if (seenNames.has(key)) {
				throw new Error(l10n.t('Archive contains duplicate entry names: {0}', rawName));
			}
			seenNames.add(key);
		}

		totalUncompressedBytes += uncompressedSize;
		if (totalUncompressedBytes > MAX_ARCHIVE_TOTAL_BYTES) {
			throw new Error(l10n.t('Archive total uncompressed size exceeds the limit (>{0}MB)', String(Math.round(MAX_ARCHIVE_TOTAL_BYTES / (1024 * 1024)))));
		}

		offset += 46 + nameLength + extraLength + commentLength;
	}

	return { entries: entryCount, totalUncompressedBytes };
}
