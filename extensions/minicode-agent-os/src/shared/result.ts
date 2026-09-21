/*---------------------------------------------------------------------------------------------
 *  Result<T, E> — 类型安全的错误处理
 *
 *  大厂工程化标准：用 Result 替代 try/catch 包裹 + null 返回的模式。
 *  对标 Rust 的 Result、Swift 的 Result、Kotlin 的 sealed class。
 *
 *  好处：
 *   1. 调用方必须在编译期处理错误（不可忽略）
 *   2. 无需 try/catch 到处散落
 *   3. 类型安全，避免忘记检查 null
 *   4. 函数签名即文档（一看就知道可能失败）
 *
 *  示例：
 *   function divide(a: number, b: number): Result<number, string> {
 *     if (b === 0) return err('division by zero');
 *     return ok(a / b);
 *   }
 *
 *   const result = divide(10, 2);
 *   if (result.ok) { console.log(result.value); }
 *   else { console.error(result.error); }
 *--------------------------------------------------------------------------------------------*/

// ── 核心类型 ────────────────────────────────────────────────────

/** 成功结果 */
interface Success<T> {
	readonly ok: true;
	readonly value: T;
}

/** 失败结果 */
interface Failure<E> {
	readonly ok: false;
	readonly error: E;
}

/** Result 类型：成功时包含 T 类型值，失败时包含 E 类型错误 */
export type Result<T, E = Error> = Success<T> | Failure<E>;

// ── 构造器 ──────────────────────────────────────────────────────

/** 创建成功 Result */
export function ok(): Success<void>;
export function ok<T>(value: T): Success<T>;
export function ok<T>(value?: T): Success<T | void> {
	return { ok: true, value: value as T };
}

/** 创建失败 Result */
export function err<E>(error: E): Failure<E> {
	return { ok: false, error };
}

// ── 辅助函数 ────────────────────────────────────────────────────

/** 对同步函数包装 try/catch，返回 Result */
export function tryCatch<T>(fn: () => T): Result<T, Error> {
	try {
		return ok(fn());
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
}

/** 对异步函数包装 try/catch，返回 Result */
export async function tryCatchAsync<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
	try {
		return ok(await fn());
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
}

/** 解包 Result，失败时返回默认值 */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
	return result.ok ? result.value : defaultValue;
}

/** 如果 Result 成功，执行 map 函数 */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
	if (result.ok) return ok(fn(result.value));
	return result;
}

/** 如果 Result 成功，执行 async map 函数（错误类型固定为 Error） */
export async function mapAsync<T, U>(
	result: Result<T, Error>,
	fn: (value: T) => Promise<U>,
): Promise<Result<U, Error>> {
	if (result.ok) {
		try {
			return ok(await fn(result.value));
		} catch (e) {
			return err(e instanceof Error ? e : new Error(String(e)));
		}
	}
	return result;
}

/** 类型守卫：检查是否为成功 Result */
export function isSuccess<T, E>(result: Result<T, E>): result is Success<T> {
	return result.ok;
}

/** 类型守卫：检查是否为失败 Result */
export function isFailure<T, E>(result: Result<T, E>): result is Failure<E> {
	return !result.ok;
}

// ── 运行时断言（用于模块级单例等场景） ──────────────────────────────

/**
 * 断言 value 非 null/undefined，否则抛出带上下文的错误。
 *
 * 注意：优先使用 requireCurrentState() 等专用守卫；
 * 此函数仅用于无法使用 Result 模式的场景（如模块级状态访问）。
 */
export function assertNonNull<T>(
	value: T | null | undefined,
	context: string,
): asserts value is T {
	if (value === null || value === undefined) {
		throw new Error(`Assertion failed: ${context} is null or undefined`);
	}
}
