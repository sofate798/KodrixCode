/**
 * 通用 LRU 缓存，支持 TTL 过期和最大条目数限制。
 */
export class QueryCache<V> {
	private _cache = new Map<string, { value: V; expiry: number }>();
	private _maxEntries: number;
	private _ttlMs: number;

	constructor(opts: { maxEntries?: number; ttlMs?: number } = {}) {
		this._maxEntries = opts.maxEntries ?? 200;
		this._ttlMs = opts.ttlMs ?? 60_000; // 默认 60 秒
	}

	get(key: string): V | undefined {
		const entry = this._cache.get(key);
		if (!entry) return undefined;
		if (Date.now() > entry.expiry) {
			this._cache.delete(key);
			return undefined;
		}
		// LRU: 删除再重新插入以移到末尾
		this._cache.delete(key);
		this._cache.set(key, entry);
		return entry.value;
	}

	set(key: string, value: V): void {
		// 如果已满，删除最旧的（Map 第一个）
		if (this._cache.size >= this._maxEntries) {
			const firstKey = this._cache.keys().next().value;
			if (firstKey !== undefined) this._cache.delete(firstKey);
		}
		this._cache.set(key, { value, expiry: Date.now() + this._ttlMs });
	}

	clear(): void { this._cache.clear(); }
	get size(): number { return this._cache.size; }
}
