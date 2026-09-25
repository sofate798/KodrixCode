"use strict";
/*---------------------------------------------------------------------------------------------
 *  测试：jsonValidator — JSON shape validation utilities
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
const assert = __importStar(require("assert"));
const jsonValidator_1 = require("../utils/jsonValidator");
suite('jsonValidator', () => {
    suite('safeJsonParse', () => {
        test('parses valid JSON with matching guard', () => {
            const result = (0, jsonValidator_1.safeJsonParse)('{"name":"test","count":3}', jsonValidator_1.isRecord, 'test');
            assert.ok(result);
            assert.strictEqual(result.name, 'test');
            assert.strictEqual(result.count, 3);
        });
        test('returns undefined for malformed JSON', () => {
            const result = (0, jsonValidator_1.safeJsonParse)('{bad json', jsonValidator_1.isRecord, 'test');
            assert.strictEqual(result, undefined);
        });
        test('returns undefined when guard fails', () => {
            const result = (0, jsonValidator_1.safeJsonParse)('"just a string"', jsonValidator_1.isRecord, 'test');
            assert.strictEqual(result, undefined);
        });
    });
    suite('isRecord', () => {
        test('accepts plain objects', () => {
            assert.strictEqual((0, jsonValidator_1.isRecord)({}), true);
            assert.strictEqual((0, jsonValidator_1.isRecord)({ a: 1 }), true);
        });
        test('rejects arrays', () => {
            assert.strictEqual((0, jsonValidator_1.isRecord)([]), false);
        });
        test('rejects null and primitives', () => {
            assert.strictEqual((0, jsonValidator_1.isRecord)(null), false);
            assert.strictEqual((0, jsonValidator_1.isRecord)('string'), false);
            assert.strictEqual((0, jsonValidator_1.isRecord)(42), false);
        });
    });
    suite('isString / isNumber / isBoolean', () => {
        test('isString checks correctly', () => {
            assert.strictEqual((0, jsonValidator_1.isString)('hello'), true);
            assert.strictEqual((0, jsonValidator_1.isString)(''), true);
            assert.strictEqual((0, jsonValidator_1.isString)(123), false);
        });
        test('isNumber checks correctly', () => {
            assert.strictEqual((0, jsonValidator_1.isNumber)(42), true);
            assert.strictEqual((0, jsonValidator_1.isNumber)(0), true);
            assert.strictEqual((0, jsonValidator_1.isNumber)('42'), false);
        });
        test('isBoolean checks correctly', () => {
            assert.strictEqual((0, jsonValidator_1.isBoolean)(true), true);
            assert.strictEqual((0, jsonValidator_1.isBoolean)(false), true);
            assert.strictEqual((0, jsonValidator_1.isBoolean)(1), false);
        });
    });
    suite('isStringArray', () => {
        test('accepts string arrays', () => {
            assert.strictEqual((0, jsonValidator_1.isStringArray)(['a', 'b']), true);
            assert.strictEqual((0, jsonValidator_1.isStringArray)([]), true);
        });
        test('rejects mixed arrays', () => {
            assert.strictEqual((0, jsonValidator_1.isStringArray)(['a', 1]), false);
        });
    });
});
