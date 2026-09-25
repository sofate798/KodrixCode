"use strict";
/*---------------------------------------------------------------------------------------------
 *  Codebase Intelligence — 全工程级语义索引类型定义
 *  大厂对标：Sourcegraph Code Intelligence + GitHub Copilot Workspace Context
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.SymbolVisibility = exports.SymbolKind = void 0;
/** 符号类型枚举 */
var SymbolKind;
(function (SymbolKind) {
    SymbolKind["Class"] = "class";
    SymbolKind["Interface"] = "interface";
    SymbolKind["Function"] = "function";
    SymbolKind["Method"] = "method";
    SymbolKind["Variable"] = "variable";
    SymbolKind["TypeAlias"] = "type";
    SymbolKind["Enum"] = "enum";
    SymbolKind["Namespace"] = "namespace";
    SymbolKind["Module"] = "module";
    SymbolKind["Unknown"] = "unknown";
})(SymbolKind || (exports.SymbolKind = SymbolKind = {}));
/** 符号可见性 */
var SymbolVisibility;
(function (SymbolVisibility) {
    SymbolVisibility["Public"] = "public";
    SymbolVisibility["Protected"] = "protected";
    SymbolVisibility["Private"] = "private";
    SymbolVisibility["Exported"] = "exported";
})(SymbolVisibility || (exports.SymbolVisibility = SymbolVisibility = {}));
