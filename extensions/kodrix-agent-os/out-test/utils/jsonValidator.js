"use strict";
/*---------------------------------------------------------------------------------------------
 *  JSON Validation Utility
 *  Provides type-safe JSON parsing with runtime shape validation.
 *  Replaces bare `JSON.parse(...) as Type` patterns across the codebase.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeJsonParse = safeJsonParse;
exports.safeJsonReadFile = safeJsonReadFile;
exports.isRecord = isRecord;
exports.isString = isString;
exports.isNumber = isNumber;
exports.isBoolean = isBoolean;
exports.isArrayOf = isArrayOf;
exports.isStringArray = isStringArray;
exports.optional = optional;
const logger_1 = require("../logger");
/**
 * A type-safe JSON parse that validates the parsed value against a guard function.
 * Returns undefined and logs a warning if the data is invalid or missing.
 *
 * @param raw - The raw JSON string to parse
 * @param guard - A type guard function that validates the parsed shape
 * @param context - Context label for error messages (e.g., 'LearningEngine.readLog')
 */
function safeJsonParse(raw, guard, context) {
    try {
        const parsed = JSON.parse(raw);
        if (!guard(parsed)) {
            logger_1.logger.warn(`[${context}] JSON shape validation failed — unexpected structure`);
            return undefined;
        }
        return parsed;
    }
    catch (err) {
        logger_1.logger.warn(`[${context}] JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}
/**
 * Parses JSON from a file with shape validation.
 * Returns undefined if the file does not exist or contains invalid data.
 */
function safeJsonReadFile(fs, filePath, guard, context) {
    if (!fs.existsSync(filePath)) {
        return undefined;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    return safeJsonParse(raw, guard, context);
}
/**
 * Type guard helpers for common patterns
 */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isString(value) {
    return typeof value === 'string';
}
function isNumber(value) {
    return typeof value === 'number';
}
function isBoolean(value) {
    return typeof value === 'boolean';
}
function isArrayOf(value, itemGuard) {
    return Array.isArray(value) && value.every(itemGuard);
}
function isStringArray(value) {
    return isArrayOf(value, isString);
}
function optional(value, guard) {
    if (value === undefined || value === null) {
        return true;
    }
    return guard(value);
}
