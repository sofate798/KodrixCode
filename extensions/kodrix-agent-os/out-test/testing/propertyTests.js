"use strict";
/*---------------------------------------------------------------------------------------------
 *  属性测试生成 — Kiro fast-check 风格
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
exports.generatePropertyTests = generatePropertyTests;
exports.registerPropertyTests = registerPropertyTests;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const paths_1 = require("../paths");
const constants_1 = require("../shared/constants");
const featureFlags_1 = require("../utils/featureFlags");
function propertyTestTemplate(moduleName, properties) {
    return `/**
 * 属性测试 — ${moduleName}
 * 由 Kodrix Agent OS 生成（Kiro / fast-check 风格）
 *
 * 运行: npm test 或 npx vitest run
 */
import { describe, it, expect } from 'vitest';
// import fc from 'fast-check';

describe('${moduleName} properties', () => {
${properties.map(p => `\tit('${p}', () => {
\t\t// 占位断言：本生成器只产出骨架，不引入 fast-check 依赖（避免新增第三方依赖）。
\t\t// 如需真实属性验证，请先接入 fast-check，再替换下面的断言：
\t\t// fc.assert(fc.property(fc.string(), (input) => { ... }));
\t\texpect(true).toBe(true);
\t});`).join('\n\n')}
});
`;
}
async function generatePropertyTests() {
    const specsDir = (0, paths_1.getSpecsDir)();
    let requirements = '';
    if (specsDir && fs.existsSync(specsDir)) {
        const specs = fs.readdirSync(specsDir, { withFileTypes: true }).filter(d => d.isDirectory());
        if (specs.length) {
            const picked = await vscode.window.showQuickPick(specs.map(s => ({ label: s.name })), { placeHolder: vscode_1.l10n.t('Generate property-based tests from Spec (optional)') });
            if (picked) {
                const reqPath = path.join(specsDir, picked.label, 'requirements.md');
                if (fs.existsSync(reqPath)) {
                    requirements = fs.readFileSync(reqPath, 'utf-8');
                }
            }
        }
    }
    const moduleName = await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('Module name'),
        value: 'authService',
    }) || 'module';
    const properties = requirements
        .split('\n')
        .filter(l => l.includes('**当**') || l.includes('**如果**') || l.includes('**在**'))
        .map(l => l.replace(/^-\s*/, '').trim())
        .slice(0, 5);
    if (!properties.length) {
        properties.push(vscode_1.l10n.t('For any valid input, the output should satisfy the type constraints'), vscode_1.l10n.t('For any invalid input, an error should be thrown or an error code returned'), vscode_1.l10n.t('Calling multiple times with the same input should produce the same result (idempotent)'));
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showWarningMessage(vscode_1.l10n.t('Please open a workspace first'));
        return;
    }
    const testDir = path.join(folder.uri.fsPath, 'tests', 'property');
    (0, paths_1.ensureDir)(testDir);
    const outPath = path.join(testDir, `${moduleName}.property.test.ts`);
    fs.writeFileSync(outPath, propertyTestTemplate(moduleName, properties), 'utf-8');
    const doc = await vscode.workspace.openTextDocument(outPath);
    await vscode.window.showTextDocument(doc);
    const refineWithAgent = vscode_1.l10n.t('Refine tests with Agent');
    vscode.window.showInformationMessage(vscode_1.l10n.t('Property tests generated: {0}', outPath), refineWithAgent).then(c => {
        if (c === refineWithAgent) {
            void vscode.commands.executeCommand('workbench.action.chat.open', {
                mode: 'agent',
                query: `请完善 ${outPath} 中的 fast-check 属性测试，基于 Spec 验收标准实现真实断言。`,
                isPartialQuery: false,
            });
        }
    });
}
function registerPropertyTests(context) {
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.testing.generatePropertyTests', async () => {
        // 功能开关 kodrix.features.propertyTests（默认开）
        if (!(0, featureFlags_1.isKodrixFeatureEnabled)(constants_1.FEATURE_FLAGS.propertyTests)) {
            void vscode.window.showWarningMessage((0, featureFlags_1.featureDisabledNotice)(constants_1.FEATURE_FLAGS.propertyTests));
            return;
        }
        await generatePropertyTests();
    }));
}
