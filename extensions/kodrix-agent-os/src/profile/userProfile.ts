/*---------------------------------------------------------------------------------------------
 *  User Profile — 全局用户偏好画像（对标 Cursor 的全局偏好记忆）
 *
 *  能力：
 *    1. 用户级画像文件（~/.kodrix/user-profile.json，跨项目共享，不随工作区隔离）
 *    2. 画像注入：Crew / 后台 Agent 执行时自动附加到上下文中（语言/语气/技术栈/风格/约束）
 *    3. 管理命令：查看/编辑画像、重置画像
 *    4. 零外部依赖（os + fs），便于单元测试
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../logger';
import { COMMANDS, USER_PROFILE_DEFAULT, USER_PROFILE_FILE } from '../shared/constants';

/** 用户偏好画像 */
export interface UserProfile {
	/** 产出语言（如 简体中文 / English） */
	language?: string;
	/** 沟通与产出语气 */
	tone?: string;
	/** 常用技术栈 */
	techStack?: string[];
	/** 代码风格偏好 */
	codingStyle?: string;
	/** 关键约束（跨项目长期生效，如 不使用任何前端框架 / 注释用中文） */
	keyConstraints?: string[];
	/** 最近更新时间 */
	updatedAt?: string;
}

/** 用户级 Kodrix 目录 */
export function getUserKodrixDir(): string {
	return path.join(os.homedir(), '.kodrix');
}

/** 用户画像文件路径（跨项目全局） */
export function getUserProfilePath(): string {
	return path.join(getUserKodrixDir(), USER_PROFILE_FILE);
}

/** 读取用户画像（不存在/损坏时返回默认） */
export function loadUserProfile(): UserProfile {
	const p = getUserProfilePath();
	try {
		if (!fs.existsSync(p)) {
			return { ...USER_PROFILE_DEFAULT };
		}
		const raw = fs.readFileSync(p, 'utf-8');
		const parsed = JSON.parse(raw) as UserProfile;
		return { ...USER_PROFILE_DEFAULT, ...parsed };
	} catch (err) {
		logger.warn('[UserProfile] 读取画像失败（使用默认）', err);
		return { ...USER_PROFILE_DEFAULT };
	}
}

/** 保存用户画像 */
export function saveUserProfile(profile: UserProfile): void {
	const p = getUserProfilePath();
	try {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		profile.updatedAt = new Date().toISOString();
		fs.writeFileSync(p, JSON.stringify(profile, null, 2), 'utf-8');
	} catch (err) {
		logger.error('[UserProfile] 保存画像失败', err);
		throw err;
	}
}

/** 生成注入到 Agent 上下文中的用户画像片段（Markdown） */
export function getProfileInjection(): string {
	const p = loadUserProfile();
	const lines: string[] = ['## 用户偏好画像（跨项目全局，必须遵循）'];
	lines.push(`- 产出语言：${p.language?.trim() || '未设置'}`);
	lines.push(`- 语气：${p.tone?.trim() || '未设置'}`);
	if (p.techStack?.length) {
		lines.push(`- 技术栈：${p.techStack.join(', ')}`);
	}
	if (p.codingStyle?.trim()) {
		lines.push(`- 代码风格：${p.codingStyle.trim()}`);
	}
	if (p.keyConstraints?.length) {
		lines.push(`- 关键约束：${p.keyConstraints.join('；')}`);
	}
	lines.push('所有产出（代码 / 文档 / 方案 / 消息）一律遵循以上偏好，如无冲突不要另行询问。');
	return lines.join('\n');
}

/** 注册用户画像命令 */
export function registerUserProfile(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.userProfileView, async () => {
			const profile = loadUserProfile();
			const doc = await vscode.workspace.openTextDocument({
				content: [
					'// Kodrix 全局用户偏好画像（跨项目注入所有 Agent 上下文）',
					'// 编辑保存后生效；字段说明见 README 或「Kodrix: 重置用户偏好画像」',
					JSON.stringify(profile, null, 2),
				].join('\n'),
				language: 'jsonc',
			});
			await vscode.window.showTextDocument(doc, { preview: false });
		}),
		vscode.commands.registerCommand(COMMANDS.userProfileReset, async () => {
			const ok = await vscode.window.showWarningMessage('确定重置全局用户偏好画像？此操作不可撤销。', { modal: true }, '重置');
			if (ok !== '重置') {
				return;
			}
			saveUserProfile({ ...USER_PROFILE_DEFAULT });
			await vscode.window.showInformationMessage('用户偏好画像已重置为默认值');
		}),
	);
}
