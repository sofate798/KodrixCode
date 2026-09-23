/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize2 } from '../../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ChatViewId } from '../../browser/chat.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

const TOGGLE_CHAT_ACTION_ID = 'workbench.action.chat.toggle';

MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: {
		id: TOGGLE_CHAT_ACTION_ID,
		title: localize2('toggleChat', "Toggle Chat"),
		icon: Codicon.comment,
	},
	when: ContextKeyExpr.and(
		ContextKeyExpr.equals('view', ChatViewId),
		ChatContextKeys.enabled,
	),
	group: 'navigation',
	order: 5,
});
