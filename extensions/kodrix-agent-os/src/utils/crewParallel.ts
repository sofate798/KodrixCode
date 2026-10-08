/*---------------------------------------------------------------------------------------------
 *  Crew Parallel — 并发上限解析（Crew 调度与 Subagent 派生共用）
 *
 *  设置项 kodrix.crew.maxParallel 此前仅在 Agent Crew 链路生效，
 *  Subagent 并行派生被硬编码为 3。本模块统一解析规则：
 *    显式入参 > 设置项 kodrix.crew.maxParallel > 默认 3（CREW_DEFAULT_MAX_PARALLEL），
 *  并钳制到 [1, 10]（与 package.json minimum/maximum 一致），非法值回退默认。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CREW_CONFIG, CREW_CONFIG_KEYS, CREW_DEFAULT_MAX_PARALLEL, clampCrewParallel } from '../shared/constants';

/** 解析并发上限：显式值优先；否则读设置项；结果收敛到合法区间 */
export function resolveCrewMaxParallel(explicit?: number): number {
	if (explicit !== undefined) {
		return clampCrewParallel(explicit);
	}
	const configured = vscode.workspace.getConfiguration(CREW_CONFIG)
		.get<number>(CREW_CONFIG_KEYS.maxParallel, CREW_DEFAULT_MAX_PARALLEL);
	return clampCrewParallel(configured, CREW_DEFAULT_MAX_PARALLEL);
}
