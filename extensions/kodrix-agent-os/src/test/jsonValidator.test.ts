/*---------------------------------------------------------------------------------------------
 *  测试：jsonValidator — JSON shape validation utilities
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { safeJsonParse, isRecord, isString, isNumber, isBoolean, isStringArray } from '../utils/jsonValidator';

suite('jsonValidator', () => {

	suite('safeJsonParse', () => {
		test('parses valid JSON with matching guard', () => {
			const result = safeJsonParse('{"name":"test","count":3}', isRecord, 'test');
			assert.ok(result);
			assert.strictEqual(result!.name, 'test');
			assert.strictEqual(result!.count, 3);
		});

		test('returns undefined for malformed JSON', () => {
			const result = safeJsonParse('{bad json', isRecord, 'test');
			assert.strictEqual(result, undefined);
		});

		test('returns undefined when guard fails', () => {
			const result = safeJsonParse('"just a string"', isRecord, 'test');
			assert.strictEqual(result, undefined);
		});
	});

	suite('isRecord', () => {
		test('accepts plain objects', () => {
			assert.strictEqual(isRecord({}), true);
			assert.strictEqual(isRecord({ a: 1 }), true);
		});
		test('rejects arrays', () => {
			assert.strictEqual(isRecord([]), false);
		});
		test('rejects null and primitives', () => {
			assert.strictEqual(isRecord(null), false);
			assert.strictEqual(isRecord('string'), false);
			assert.strictEqual(isRecord(42), false);
		});
	});

	suite('isString / isNumber / isBoolean', () => {
		test('isString checks correctly', () => {
			assert.strictEqual(isString('hello'), true);
			assert.strictEqual(isString(''), true);
			assert.strictEqual(isString(123), false);
		});
		test('isNumber checks correctly', () => {
			assert.strictEqual(isNumber(42), true);
			assert.strictEqual(isNumber(0), true);
			assert.strictEqual(isNumber('42'), false);
		});
		test('isBoolean checks correctly', () => {
			assert.strictEqual(isBoolean(true), true);
			assert.strictEqual(isBoolean(false), true);
			assert.strictEqual(isBoolean(1), false);
		});
	});

	suite('isStringArray', () => {
		test('accepts string arrays', () => {
			assert.strictEqual(isStringArray(['a', 'b']), true);
			assert.strictEqual(isStringArray([]), true);
		});
		test('rejects mixed arrays', () => {
			assert.strictEqual(isStringArray(['a', 1]), false);
		});
	});
});
