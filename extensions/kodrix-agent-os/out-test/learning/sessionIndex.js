"use strict";
/*---------------------------------------------------------------------------------------------
 *  Session Learning index — shared read/write for sessionLearning + dashboard stats
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
exports.loadSessionIndex = loadSessionIndex;
exports.saveSessionIndex = saveSessionIndex;
exports.appendSessionIndex = appendSessionIndex;
exports.getSessionLearningStats = getSessionLearningStats;
const fs = __importStar(require("fs"));
const paths_1 = require("../paths");
const jsonValidator_1 = require("../utils/jsonValidator");
const fsSafe_1 = require("../utils/fsSafe");
const logger_1 = require("../logger");
function loadSessionIndex() {
    const indexPath = (0, paths_1.getSessionIndexPath)();
    if (!indexPath || !fs.existsSync(indexPath)) {
        return { version: 1, entries: [] };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        if ((0, jsonValidator_1.isRecord)(raw) && (0, jsonValidator_1.isNumber)(raw.version) && Array.isArray(raw.entries)) {
            return raw;
        }
        logger_1.logger.warn('[SessionIndex] loadSessionIndex: invalid shape — resetting');
        return { version: 1, entries: [] };
    }
    catch {
        return { version: 1, entries: [] };
    }
}
function saveSessionIndex(index) {
    const indexPath = (0, paths_1.getSessionIndexPath)();
    if (!indexPath) {
        return;
    }
    const entries = index.entries.slice(-200);
    (0, fsSafe_1.atomicWriteFileSync)(indexPath, JSON.stringify({ version: 1, entries }, null, 2));
}
function appendSessionIndex(entry) {
    const index = loadSessionIndex();
    index.entries.push(entry);
    saveSessionIndex(index);
}
function getSessionLearningStats() {
    const index = loadSessionIndex();
    return {
        processed: index.entries.length,
        totalInsights: index.entries.reduce((n, e) => n + e.insightCount, 0),
    };
}
