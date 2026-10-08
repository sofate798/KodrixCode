/*---------------------------------------------------------------------------------------------
 *  Feature Flags — kodrix.features.* 功能开关读取的统一入口
 *
 *  语义约定：所有功能开关默认 true（向后兼容：不配置时行为与此前完全一致）；
 *  关闭时在功能入口给出可操作提示（指向设置项），与 Arena 开关行为对齐。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { CONFIG_FEATURES } from '../shared/constants';

/** 读取 kodrix.features.<flag>（缺省视为启用） */
export function isKodrixFeatureEnabled(flag: string): boolean {
	return vscode.workspace.getConfiguration(CONFIG_FEATURES).get<boolean>(flag, true);
}

/** 功能被关闭时的统一提示（不弹窗，返回文案供调用方展示） */
export function featureDisabledNotice(flag: string): string {
	return l10n.t('{0} is disabled. You can enable {1} in settings',
		flag,
		`${CONFIG_FEATURES}.${flag}`);
}
