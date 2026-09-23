/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { ExtensionIdentifier } from '../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { ISettingsEditorRendererService } from '../../contrib/preferences/browser/settingsEditorRendererService.js';
import { IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ExtHostContext, ExtHostSettingsEditorRendererShape, MainThreadSettingsEditorRendererShape } from '../common/extHost.protocol.js';
import { MainThreadWebviews } from './mainThreadWebviews.js';

export class MainThreadSettingsEditorRenderer extends Disposable implements MainThreadSettingsEditorRendererShape {

	private readonly _proxy: ExtHostSettingsEditorRendererShape;
	private _webviewHandlePool = 0;
	private readonly registeredRenderers = new Map</* viewType */ string, IDisposable>();

	constructor(
		extHostContext: IExtHostContext,
		private readonly _mainThreadWebview: MainThreadWebviews,
		@ISettingsEditorRendererService private readonly _rendererService: ISettingsEditorRendererService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostSettingsEditorRenderer);
	}

	override dispose(): void {
		super.dispose();
		this.registeredRenderers.forEach(disposable => disposable.dispose());
		this.registeredRenderers.clear();
	}

	$registerSettingsEditorRenderer(viewType: string, extensionId: ExtensionIdentifier, extensionLocation: UriComponents): void {
		const existingRegistration = this.registeredRenderers.get(viewType);
		if (existingRegistration) {
			this._logService.warn(`Re-registering settings editor renderer for view type '${viewType}' from extension '${extensionId.value}'.`);
			existingRegistration.dispose();
		}

		const disposable = this._rendererService.registerRenderer(viewType, {
			renderSetting: async (webview, context, token) => {
				const webviewHandle = `settings-editor-${++this._webviewHandlePool}`;
				this._mainThreadWebview.addWebview(webviewHandle, webview, {
					serializeBuffersForPostMessage: true,
				});
				return this._proxy.$resolveSettingsEditorSetting(viewType, context, webviewHandle, token);
			},
		}, {
			extension: { id: extensionId, location: URI.revive(extensionLocation) }
		});
		this.registeredRenderers.set(viewType, disposable);
	}

	$unregisterSettingsEditorRenderer(viewType: string): void {
		this.registeredRenderers.get(viewType)?.dispose();
		this.registeredRenderers.delete(viewType);
	}
}
