/*---------------------------------------------------------------------------------------------
 *  Learning Retrieval — 启发式学习条目分类
 *
 *  说明：语义检索统一由 `semanticMemory.searchSimilar`（TF-IDF 向量 + 时间衰减）提供，
 *  本文件仅保留分类推断。此前的 `rankLearningEntries` / `scoreRelevance` / `tokenize`
 *  为未被引用的第二套检索实现（与 semanticMemory 行为不一致），已移除以消除双轨。
 *--------------------------------------------------------------------------------------------*/

import type { LearningCategory } from './learningEngine';

/** 启发式自动分类 — 减少手动选类别的摩擦 */
export function inferLearningCategory(content: string): LearningCategory {
	const text = content.toLowerCase();
	if (/架构|architecture|模块|分层|微服务|monorepo|design pattern/i.test(text)) {
		return 'architecture';
	}
	if (/命名|convention|规范|lint|eslint|prettier|风格|style guide/i.test(text)) {
		return 'convention';
	}
	if (/陷阱|pitfall|注意|avoid|don't|别用|坑|bug|issue|错误/i.test(text)) {
		return 'pitfall';
	}
	if (/偏好|prefer|喜欢|习惯|favorite|default/i.test(text)) {
		return 'preference';
	}
	if (/模式|pattern|repository|factory|singleton|hook|middleware|adapter/i.test(text)) {
		return 'pattern';
	}
	return 'other';
}
