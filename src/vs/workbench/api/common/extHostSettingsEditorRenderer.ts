/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { ExtHostSettingsEditorRendererShape, type ISettingsEditorSettingContextDto, IMainContext, MainContext, MainThreadSettingsEditorRendererShape } from './extHost.protocol.js';
import { Disposable } from './extHostTypes.js';
import { ExtHostWebviews } from './extHostWebview.js';

export class ExtHostSettingsEditorRenderer implements ExtHostSettingsEditorRendererShape {

	private readonly _proxy: MainThreadSettingsEditorRendererShape;

	private readonly _renderers = new Map</*viewType*/ string, {
		readonly renderer: vscode.SettingsEditorSettingRenderer;
		readonly extension: IExtensionDescription;
	}>();

	constructor(
		mainContext: IMainContext,
		private readonly webviews: ExtHostWebviews,
	) {
		this._proxy = mainContext.getProxy(MainContext.MainThreadSettingsEditorRenderer);
	}

	registerSettingsEditorRenderer(extension: IExtensionDescription, viewType: string, renderer: vscode.SettingsEditorSettingRenderer): vscode.Disposable {
		if (this._renderers.has(viewType)) {
			throw new Error(`Settings editor renderer already registered for: ${viewType}`);
		}

		this._renderers.set(viewType, { extension, renderer });
		this._proxy.$registerSettingsEditorRenderer(viewType, extension.identifier, extension.extensionLocation);

		return new Disposable(() => {
			this._renderers.delete(viewType);
			this._proxy.$unregisterSettingsEditorRenderer(viewType);
		});
	}

	async $resolveSettingsEditorSetting(viewType: string, setting: ISettingsEditorSettingContextDto, webviewHandle: string, token: CancellationToken): Promise<void> {
		const entry = this._renderers.get(viewType);
		if (!entry) {
			throw new Error(`No settings editor renderer registered for: ${viewType}`);
		}

		const extHostWebview = this.webviews.createNewWebview(webviewHandle, {}, entry.extension);
		const settingsWebview: vscode.SettingsEditorSettingWebview = Object.freeze({
			webview: extHostWebview,
			onDidDispose: extHostWebview._onDidDispose,
		});
		return entry.renderer.resolveSettingsEditorSetting(Object.freeze(setting), settingsWebview, token);
	}
}
