/*---------------------------------------------------------------------------------------------
 *  测试夹具：按需构造 ZIP 归档（合法与恶意两种），供 zipValidation / extractZip 用例使用
 *--------------------------------------------------------------------------------------------*/

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buffer: Buffer): number {
	let c = 0xFFFFFFFF;
	for (const byte of buffer) {
		c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
	}
	return (c ^ 0xFFFFFFFF) >>> 0;
}

export interface ZipFixtureEntry {
	name: string;
	data?: string;
	/** 覆盖中央目录里的解压后大小（用于构造 bomb / ZIP64 场景） */
	sizeOverride?: number;
	/** 中央目录 external attributes（高 16 位为 unix mode，0xA000 表示符号链接） */
	externalAttrs?: number;
	/** 通用标志位（bit0 = 加密） */
	flags?: number;
}

/** 构造一个结构合法的 ZIP（store、无压缩），支持注入恶意条目属性 */
export function buildZip(entries: ZipFixtureEntry[]): Buffer {
	const parts: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, 'utf8');
		const data = Buffer.from(entry.data ?? '', 'utf8');
		const crc = crc32(data);
		const uncompressedSize = entry.sizeOverride ?? data.length;

		const local = Buffer.alloc(30 + nameBuf.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(entry.flags ?? 0, 6);
		local.writeUInt16LE(0, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(uncompressedSize, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		nameBuf.copy(local, 30);

		const central = Buffer.alloc(46 + nameBuf.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE((3 << 8) | 20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(entry.flags ?? 0, 8);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(uncompressedSize, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt32LE(entry.externalAttrs ?? 0, 38);
		central.writeUInt32LE(offset, 42);
		nameBuf.copy(central, 46);

		parts.push(local, data);
		centrals.push(central);
		offset += local.length + data.length;
	}

	const centralBuf = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralBuf.length, 12);
	eocd.writeUInt32LE(offset, 16);

	return Buffer.concat([...parts, centralBuf, eocd]);
}
