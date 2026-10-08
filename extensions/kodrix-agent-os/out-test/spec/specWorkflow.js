"use strict";
/*---------------------------------------------------------------------------------------------
 *  Spec 工作流 — Kiro Spec 驱动 + Qoder Spec-driven
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
exports.createSpec = createSpec;
exports.openSpec = openSpec;
exports.implementSpec = implementSpec;
exports.registerSpec = registerSpec;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const learningEngine_1 = require("../learning/learningEngine");
const specHelpers_1 = require("./specHelpers");
async function createSpec(openWorkbench = false) {
    const feature = await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('Feature name (a Spec trio will be created)'),
        placeHolder: 'user-authentication',
    });
    if (!feature) {
        return undefined;
    }
    const description = await vscode.window.showInputBox({
        prompt: vscode_1.l10n.t('Briefly describe your requirement'),
        placeHolder: vscode_1.l10n.t('Implement user login, registration, and session management'),
    }) || '（待补充）';
    const specDir = await (0, specHelpers_1.createSpecFiles)(feature, description);
    if (!specDir) {
        return undefined;
    }
    const slug = (0, specHelpers_1.slugify)(feature);
    (0, learningEngine_1.recordLearning)(`新建 Spec：${feature}（${slug}）`, { source: 'spec', category: 'architecture' });
    if (openWorkbench) {
        await vscode.commands.executeCommand('kodrix.spec.openWorkbench', slug);
    }
    else {
        const reqDoc = await vscode.workspace.openTextDocument(path.join(specDir, 'requirements.md'));
        await vscode.window.showTextDocument(reqDoc);
        void vscode.window.showInformationMessage(vscode_1.l10n.t('Spec created: .kodrix/specs/{0}/', slug), vscode_1.l10n.t('Open the three-pane workbench'), vscode_1.l10n.t('Implement task')).then(choice => {
            if (choice === vscode_1.l10n.t('Open the three-pane workbench')) {
                void vscode.commands.executeCommand('kodrix.spec.openWorkbench', slug);
            }
            else if (choice === vscode_1.l10n.t('Implement task')) {
                void implementSpec(specDir);
            }
        }, () => { });
    }
    return specDir;
}
async function openSpec() {
    const slug = await (0, specHelpers_1.pickSpecSlug)();
    if (!slug) {
        return;
    }
    await vscode.commands.executeCommand('kodrix.spec.openWorkbench', slug);
}
async function implementSpec(specDir) {
    let dir = specDir;
    if (!dir) {
        const slug = await (0, specHelpers_1.pickSpecSlug)(vscode_1.l10n.t('Select a Spec to implement'));
        if (!slug) {
            return;
        }
        dir = (0, specHelpers_1.getSpecDir)(slug);
    }
    if (!dir) {
        return;
    }
    await (0, specHelpers_1.launchSpecImplementation)(dir);
}
function registerSpec(context) {
    context.subscriptions.push(vscode.commands.registerCommand('kodrix.spec.create', () => createSpec(false)), vscode.commands.registerCommand('kodrix.spec.open', () => openSpec()), vscode.commands.registerCommand('kodrix.spec.implement', () => implementSpec()));
}
