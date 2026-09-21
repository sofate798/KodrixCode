export { ensureProjectIndex, getProjectIndex, startIndexWatcher, disposeIndexWatcher } from './projectIndexer';
export { queryCodebase, registerCodebaseChatParticipant, quickSearchSymbols, getFileDependencies, getFileDependents } from './codebaseQuery';
export { registerPredictiveCompletion, findAffectedCallSites, getAffectedFilesForSymbol } from './predictiveCompletion';
export { SymbolKind, SymbolVisibility } from './types';
export type { CodeSymbol, ProjectIndex, FileIndexSummary, FileDependency, ImportRelation, CallRelation, CodebaseSearchResult, IndexStats, IndexerConfig, PredictionContext, EditSuggestion } from './types';
