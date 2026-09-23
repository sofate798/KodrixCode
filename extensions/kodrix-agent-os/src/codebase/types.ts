/*---------------------------------------------------------------------------------------------
 *  Codebase Intelligence — 全工程级语义索引类型定义
 *  大厂对标：Sourcegraph Code Intelligence + GitHub Copilot Workspace Context
 *--------------------------------------------------------------------------------------------*/

/** 符号类型枚举 */
export enum SymbolKind {
	Class = 'class',
	Interface = 'interface',
	Function = 'function',
	Method = 'method',
	Variable = 'variable',
	TypeAlias = 'type',
	Enum = 'enum',
	Namespace = 'namespace',
	Module = 'module',
	Unknown = 'unknown',
}

/** 符号可见性 */
export enum SymbolVisibility {
	Public = 'public',
	Protected = 'protected',
	Private = 'private',
	Exported = 'exported',
}

/** 单个符号定义 */
export interface CodeSymbol {
	/** 符号唯一标识：filePath#symbolName */
	id: string;
	/** 符号名称 */
	name: string;
	/** 符号类型 */
	kind: SymbolKind;
	/** 所在文件绝对路径 */
	filePath: string;
	/** 所在行号（1-based） */
	line: number;
	/** 所在列号（1-based） */
	column: number;
	/** 父符号 id（如方法属于某个类） */
	parentId?: string;
	/** 可见性 */
	visibility: SymbolVisibility;
	/** 文档注释（JSDoc） */
	docComment?: string;
	/** 签名（函数参数、返回值等） */
	signature?: string;
	/** 导出方式：named / default / re-export */
	exportKind?: 'named' | 'default' | 'reexport';
}

/** 导入关系 */
export interface ImportRelation {
	/** 导入方文件路径 */
	importerPath: string;
	/** 被导入方文件路径 */
	importeePath: string;
	/** 导入的符号名列表 */
	symbols: string[];
	/** 是否是默认导入 */
	isDefault: boolean;
	/** 是否是类型导入 */
	isTypeOnly: boolean;
	/** 模块说明符（如 './foo'） */
	moduleSpecifier: string;
}

/** 文件间依赖关系 */
export interface FileDependency {
	/** 依赖方 */
	from: string;
	/** 被依赖方 */
	to: string;
	/** 依赖类型 */
	type: 'import' | 'dynamic-import' | 'require' | 'reference';
	/** 引用的符号 */
	symbols?: string[];
}

/** 调用关系 */
export interface CallRelation {
	/** 调用方符号 id */
	callerId: string;
	/** 被调用方符号 id */
	calleeId: string;
	/** 调用所在行 */
	line: number;
}

/** 文件索引摘要 */
export interface FileIndexSummary {
	filePath: string;
	relativePath: string;
	symbolCount: number;
	exportCount: number;
	importCount: number;
	sizeBytes: number;
	lastModified: number;
	language: string;
}

/** 完整项目索引 */
export interface ProjectIndex {
	/** 索引版本号 */
	version: number;
	/** 项目根路径 */
	rootPath: string;
	/** 索引创建时间 */
	createdAt: string;
	/** 最后更新时间 */
	updatedAt: string;
	/** 所有符号（id → symbol） */
	symbols: Record<string, CodeSymbol>;
	/** 符号名索引（name → symbol ids），用于快速按名查找 */
	symbolNameIndex: Record<string, string[]>;
	/** 文件索引（filePath → FileIndexSummary） */
	files: Record<string, FileIndexSummary>;
	/** 导入关系列表 */
	imports: ImportRelation[];
	/** 文件依赖图（from → to[]） */
	dependencyGraph: Record<string, string[]>;
	/** 反向依赖图（to → from[]） */
	reverseDependencyGraph: Record<string, string[]>;
	/** 调用关系列表 */
	calls: CallRelation[];
	/** 被引用最多的符号 Top N */
	hotSymbols: string[];
	/** 统计信息 */
	stats: IndexStats;
}

/** 索引统计 */
export interface IndexStats {
	totalFiles: number;
	totalSymbols: number;
	totalImports: number;
	totalCalls: number;
	languageDistribution: Record<string, number>;
	indexDurationMs: number;
}

/** 代码搜索查询 */
export interface CodebaseQuery {
	/** 自然语言查询文本 */
	text: string;
	/** 查询类型 */
	type: 'definition' | 'usage' | 'callers' | 'structure' | 'natural';
	/** 限制返回条数 */
	topK?: number;
}

/** 代码搜索结果 */
export interface CodebaseSearchResult {
	/** 匹配的符号 */
	symbol?: CodeSymbol;
	/** 匹配原因描述 */
	reason: string;
	/** 相关文件路径 */
	filePath: string;
	/** 匹配分数（0-1） */
	score: number;
	/** 上下文代码片段 */
	snippet?: string;
	/** 代码位置行范围 */
	lineRange?: [number, number];
}

/** 预测补全上下文 */
export interface PredictionContext {
	/** 当前文件路径 */
	currentFile: string;
	/** 光标前文本 */
	prefix: string;
	/** 光标后文本 */
	suffix: string;
	/** 相关的项目级符号（来自索引） */
	relevantSymbols: CodeSymbol[];
	/** 可能的下一步编辑 */
	suggestions: EditSuggestion[];
}

/** 编辑建议 */
export interface EditSuggestion {
	/** 建议的编辑文本 */
	insertText: string;
	/** 原因（如 "匹配项目模式: 创建新的 API Route"） */
	reason: string;
	/** 相关文件（需要同步修改的文件） */
	relatedFiles: string[];
	/** 置信度 */
	confidence: number;
}

/** 索引配置 */
export interface IndexerConfig {
	/** 需要索引的文件扩展名 */
	includeExtensions: string[];
	/** 排除的目录 */
	excludeDirs: string[];
	/** 排除的 glob 模式 */
	excludeGlobs: string[];
	/** 最大文件大小（字节），超过大小则跳过 */
	maxFileSize: number;
	/** 是否自动增量更新 */
	watch: boolean;
}
