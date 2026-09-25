"use strict";
/*---------------------------------------------------------------------------------------------
 *  独立 Mocha 测试运行器 — 不依赖 @vscode/test-electron
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
const mocha_1 = __importDefault(require("mocha"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
/** 递归查找目录下所有 .test.js 文件 */
function findTestFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) {
        return results;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findTestFiles(full));
        }
        else if (entry.name.endsWith('.test.js')) {
            results.push(full);
        }
    }
    return results;
}
function run() {
    // 注册 vscode mock（必须在加载任何测试文件之前）
    require('./vscode-mock');
    const mocha = new mocha_1.default({
        ui: 'tdd',
        color: true,
        timeout: 10000,
    });
    const testsRoot = path.resolve(__dirname, '.');
    const files = findTestFiles(testsRoot);
    files.forEach(f => mocha.addFile(f));
    return new Promise((resolve, reject) => {
        try {
            mocha.run((failures) => {
                if (failures > 0) {
                    reject(new Error(`${failures} test(s) failed`));
                }
                else {
                    resolve();
                }
            });
        }
        catch (err) {
            reject(err);
        }
    });
}
// 直接运行时执行
if (require.main === module) {
    run().then(() => { process.exit(0); }, (err) => { console.error(err); process.exit(1); });
}
