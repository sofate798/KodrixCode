/*---------------------------------------------------------------------------------------------
 *  JSON Validation Utility
 *  Provides type-safe JSON parsing with runtime shape validation.
 *  Replaces bare `JSON.parse(...) as Type` patterns across the codebase.
 *--------------------------------------------------------------------------------------------*/

import { logger } from '../logger';

/**
 * A type-safe JSON parse that validates the parsed value against a guard function.
 * Returns undefined and logs a warning if the data is invalid or missing.
 *
 * @param raw - The raw JSON string to parse
 * @param guard - A type guard function that validates the parsed shape
 * @param context - Context label for error messages (e.g., 'LearningEngine.readLog')
 */
export function safeJsonParse<T>(
	raw: string,
	guard: (value: unknown) => value is T,
	context: string,
): T | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!guard(parsed)) {
			logger.warn(`[${context}] JSON shape validation failed — unexpected structure`);
			return undefined;
		}
		return parsed;
	} catch (err) {
		logger.warn(`[${context}] JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
}

/**
 * Parses JSON from a file with shape validation.
 * Returns undefined if the file does not exist or contains invalid data.
 */
export function safeJsonReadFile<T>(
	fs: { readFileSync: (path: string, encoding: string) => string; existsSync: (path: string) => boolean },
	filePath: string,
	guard: (value: unknown) => value is T,
	context: string,
): T | undefined {
	if (!fs.existsSync(filePath)) {
		return undefined;
	}
	const raw = fs.readFileSync(filePath, 'utf-8');
	return safeJsonParse(raw, guard, context);
}

/**
 * Type guard helpers for common patterns
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
	return typeof value === 'string';
}

export function isNumber(value: unknown): value is number {
	return typeof value === 'number';
}

export function isBoolean(value: unknown): value is boolean {
	return typeof value === 'boolean';
}

export function isArrayOf<T>(value: unknown, itemGuard: (v: unknown) => v is T): value is T[] {
	return Array.isArray(value) && value.every(itemGuard);
}

export function isStringArray(value: unknown): value is string[] {
	return isArrayOf(value, isString);
}

export function optional<T>(value: unknown, guard: (v: unknown) => v is T): value is T | undefined {
	if (value === undefined || value === null) {
		return true;
	}
	return guard(value);
}
