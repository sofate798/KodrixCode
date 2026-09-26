/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	/**
	 * Information about the setting being rendered in the Settings editor.
	 */
	export interface SettingsEditorSettingContext {
		/**
		 * The configuration key of the setting.
		 */
		readonly key: string;

		/**
		 * The current value of the setting in the active Settings target.
		 */
		readonly value: unknown;
	}

	/**
	 * A webview used to render a custom setting control in the Settings editor.
	 */
	export interface SettingsEditorSettingWebview {
		/**
		 * The webview to render content into.
		 */
		readonly webview: Webview;

		/**
		 * Fired when the webview is disposed.
		 */
		readonly onDidDispose: Event<void>;
	}

	/**
	 * A provider that renders a custom control for a setting in the Settings editor.
	 */
	export interface SettingsEditorSettingRenderer {
		/**
		 * Fill in the contents of a newly created settings editor webview for a setting.
		 *
		 * @param setting The setting being rendered.
		 * @param webview The webview to render into.
		 * @param token A cancellation token that is cancelled if we no longer care about the rendering.
		 */
		resolveSettingsEditorSetting(setting: SettingsEditorSettingContext, webview: SettingsEditorSettingWebview, token: CancellationToken): Thenable<void>;
	}

	export namespace window {
		/**
		 * Registers a renderer that can provide a custom webview control for settings
		 * whose configuration schema declares `"renderer": "<viewType>"`.
		 *
		 * Note: To use this API, you should also add a contribution point in your extension's
		 * package.json:
		 *
		 * ```json
		 * "contributes": {
		 *   "settingsEditorRenderers": [
		 *     {
		 *       "viewType": "myExt.mySettingsRenderer"
		 *     }
		 *   ],
		 *   "configuration": {
		 *     "properties": {
		 *       "myExt.mySetting": {
		 *         "type": "null",
		 *         "renderer": "myExt.mySettingsRenderer",
		 *         "description": "..."
		 *       }
		 *     }
		 *   }
		 * }
		 * ```
		 *
		 * @param viewType Unique identifier for the renderer. This should match the `viewType` in your contribution point
		 * and the `renderer` field on the configuration property.
		 * @param renderer The renderer to register.
		 */
		export function registerSettingsEditorRenderer(viewType: string, renderer: SettingsEditorSettingRenderer): Disposable;
	}
}
