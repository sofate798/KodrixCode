"use strict";
/*---------------------------------------------------------------------------------------------
 *  Kodrix Agent OS — 共享路径工具
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
exports.getKodrixDir = getKodrixDir;
exports.getPrimaryWorkspaceFolder = getPrimaryWorkspaceFolder;
exports.getProjectHash = getProjectHash;
exports.getWorkspaceKodrixDir = getWorkspaceKodrixDir;
exports.ensureDir = ensureDir;
exports.getWikiDir = getWikiDir;
exports.getSpecsDir = getSpecsDir;
exports.getMemoryDir = getMemoryDir;
exports.getMemoryPath = getMemoryPath;
exports.getMemoryInstructionsPath = getMemoryInstructionsPath;
exports.getLearningLogPath = getLearningLogPath;
exports.getWikiInstructionsPath = getWikiInstructionsPath;
exports.getWorkspaceInstructionsDir = getWorkspaceInstructionsDir;
exports.getGlobalInstructionsDir = getGlobalInstructionsDir;
exports.getKanbanPath = getKanbanPath;
exports.getAcpAgentsPath = getAcpAgentsPath;
exports.getHooksDir = getHooksDir;
exports.getGlobalInstructionsLocationKey = getGlobalInstructionsLocationKey;
exports.getWorkspaceInstructionsLocationKey = getWorkspaceInstructionsLocationKey;
exports.getMemoryInstructionLocationKey = getMemoryInstructionLocationKey;
exports.getWikiInstructionLocationKey = getWikiInstructionLocationKey;
exports.getIdeaFlowPath = getIdeaFlowPath;
exports.getSessionsDir = getSessionsDir;
exports.getPendingSessionsDir = getPendingSessionsDir;
exports.getProcessedSessionsDir = getProcessedSessionsDir;
exports.getSessionIndexPath = getSessionIndexPath;
exports.getWorkspaceHooksScriptDir = getWorkspaceHooksScriptDir;
exports.getGithubHooksDir = getGithubHooksDir;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
function getKodrixDir() {
    return path.join(os.homedir(), '.kodrix');
}
/**
 * 返回工作区的「主根」文件夹。所有工作区级持久化（.kodrix/、memory hash）
 * 均以此为准，确保 memory / wiki / spec / sessions 路径在多根工作区下保持一致。
 */
function getPrimaryWorkspaceFolder() {
    return vscode.workspace.workspaceFolders?.[0];
}
function getProjectHash() {
    const primary = getPrimaryWorkspaceFolder();
    if (!primary) {
        return 'global';
    }
    // 以主根路径派生 hash，与 getWorkspaceKodrixDir 使用同一个 folder，
    // 避免「memory 按全量 folder 组合 hash、而 wiki/spec 写在主根」造成的路径错位。
    return crypto.createHash('sha256').update(primary.uri.fsPath).digest('hex').slice(0, 12);
}
function getWorkspaceKodrixDir() {
    const folder = getPrimaryWorkspaceFolder();
    if (!folder) {
        return undefined;
    }
    return path.join(folder.uri.fsPath, '.kodrix');
}
function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}
function getWikiDir() {
    const base = getWorkspaceKodrixDir();
    if (!base) {
        return undefined;
    }
    return path.join(base, 'wiki');
}
function getSpecsDir() {
    const base = getWorkspaceKodrixDir();
    if (!base) {
        return undefined;
    }
    return path.join(base, 'specs');
}
function getMemoryDir() {
    return path.join(getKodrixDir(), 'memory', getProjectHash());
}
function getMemoryPath() {
    return path.join(getMemoryDir(), 'memory.md');
}
function getMemoryInstructionsPath() {
    return path.join(getMemoryDir(), 'project.instructions.md');
}
function getLearningLogPath() {
    return path.join(getMemoryDir(), 'learning.jsonl');
}
function getWikiInstructionsPath() {
    const wikiDir = getWikiDir();
    return wikiDir ? path.join(wikiDir, 'repo-context.instructions.md') : undefined;
}
function getWorkspaceInstructionsDir() {
    const base = getWorkspaceKodrixDir();
    return base ? path.join(base, 'instructions') : undefined;
}
function getGlobalInstructionsDir() {
    return path.join(getKodrixDir(), 'instructions');
}
function getKanbanPath() {
    const base = getWorkspaceKodrixDir();
    if (!base) {
        return undefined;
    }
    return path.join(base, 'kanban.json');
}
function getAcpAgentsPath() {
    return path.join(getKodrixDir(), 'acp', 'agents.json');
}
function getHooksDir() {
    return path.join(getKodrixDir(), 'hooks');
}
/** VS Code instructionsFilesLocations 使用的规范路径（tilde / 工作区相对） */
function getGlobalInstructionsLocationKey() {
    return '~/.kodrix/instructions';
}
function getWorkspaceInstructionsLocationKey() {
    return '.kodrix/instructions';
}
function getMemoryInstructionLocationKey() {
    return `~/.kodrix/memory/${getProjectHash()}`;
}
function getWikiInstructionLocationKey() {
    return '.kodrix/wiki';
}
function getIdeaFlowPath() {
    const base = getWorkspaceKodrixDir();
    return base ? path.join(base, 'idea-flow.json') : undefined;
}
function getSessionsDir() {
    const base = getWorkspaceKodrixDir();
    return base ? path.join(base, 'sessions') : undefined;
}
function getPendingSessionsDir() {
    const base = getSessionsDir();
    return base ? path.join(base, 'pending') : undefined;
}
function getProcessedSessionsDir() {
    const base = getSessionsDir();
    return base ? path.join(base, 'processed') : undefined;
}
function getSessionIndexPath() {
    const base = getSessionsDir();
    return base ? path.join(base, 'index.json') : undefined;
}
function getWorkspaceHooksScriptDir() {
    const base = getWorkspaceKodrixDir();
    return base ? path.join(base, 'hooks', 'scripts') : undefined;
}
function getGithubHooksDir() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return undefined;
    }
    return path.join(folder.uri.fsPath, '.github', 'hooks');
}
