/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../base/browser/dom.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IJSONSchema, TypeFromJsonSchema } from '../../../../base/common/jsonSchema.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import * as nls from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ExtensionKeyedWebviewOriginStore, IWebview, IWebviewService, WebviewContentPurpose } from '../../webview/browser/webview.js';
import { IExtensionService, isProposedApiEnabled } from '../../../services/extensions/common/extensions.js';
import { ExtensionsRegistry, IExtensionPointUser } from '../../../services/extensions/common/extensionsRegistry.js';

export interface ISettingsEditorSettingRenderContext {
	readonly key: string;
	readonly value: unknown;
}

export interface ISettingsEditorItemRenderer {
	renderSetting(webview: IWebview, context: ISettingsEditorSettingRenderContext, token: CancellationToken): Promise<void>;
}

interface RegisterOptions {
	readonly extension?: {
		readonly id: ExtensionIdentifier;
		readonly location: URI;
	};
}

export const ISettingsEditorRendererService = createDecorator<ISettingsEditorRendererService>('settingsEditorRendererService');

export interface ISettingsEditorRendererService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeRenderers: Event<void>;

	registerRenderer(viewType: string, renderer: ISettingsEditorItemRenderer, options: RegisterOptions): IDisposable;

	hasRenderer(viewType: string): boolean;

	renderSetting(viewType: string, parent: HTMLElement, context: ISettingsEditorSettingRenderContext, token: CancellationToken): Promise<RenderedSettingsEditorPart>;
}

export interface RenderedSettingsEditorPart extends IDisposable {
	readonly onDidChangeHeight: Event<number>;
	readonly webview: IWebview;
}

interface RendererEntry {
	readonly viewType: string;
	readonly renderer: ISettingsEditorItemRenderer;
	readonly options: RegisterOptions;
}

export class SettingsEditorRendererService extends Disposable implements ISettingsEditorRendererService {
	_serviceBrand: undefined;

	private readonly _originStore: ExtensionKeyedWebviewOriginStore;
	private readonly _contributions = new Set</*viewType*/ string>();
	private readonly _renderers = new Map</*viewType*/ string, RendererEntry>();

	private readonly _onDidChangeRenderers = this._register(new Emitter<void>());
	readonly onDidChangeRenderers = this._onDidChangeRenderers.event;

	constructor(
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IStorageService storageService: IStorageService,
	) {
		super();
		this._originStore = new ExtensionKeyedWebviewOriginStore('settingsEditorRenderer.origins', storageService);

		this._register(settingsEditorRenderContributionPoint.setHandler(extensions => {
			this.updateContributions(extensions);
		}));
	}

	registerRenderer(viewType: string, renderer: ISettingsEditorItemRenderer, options: RegisterOptions): IDisposable {
		this._renderers.set(viewType, { viewType, renderer, options });
		this._onDidChangeRenderers.fire();
		return {
			dispose: () => {
				this._renderers.delete(viewType);
				this._onDidChangeRenderers.fire();
			}
		};
	}

	hasRenderer(viewType: string): boolean {
		return this._contributions.has(viewType) || this._renderers.has(viewType);
	}

	async renderSetting(viewType: string, parent: HTMLElement, context: ISettingsEditorSettingRenderContext, token: CancellationToken): Promise<RenderedSettingsEditorPart> {
		const rendererData = await this.getRenderer(viewType, token);
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		if (!rendererData) {
			throw new Error(`No settings editor renderer registered for view type: ${viewType}`);
		}

		const store = new DisposableStore();
		const webview = store.add(this._webviewService.createWebviewElement({
			title: context.key,
			origin: this.getOrigin(rendererData),
			providedViewType: rendererData.viewType,
			options: {
				enableFindWidget: false,
				purpose: WebviewContentPurpose.SettingsEditorItem,
				tryRestoreScrollPosition: false,
			},
			contentOptions: {
				allowScripts: true,
			},
			extension: rendererData.options.extension ? rendererData.options.extension : undefined,
		}));
		webview.setContextKeyService(store.add(this._contextKeyService.createScoped(parent)));

		const onDidChangeHeight = store.add(new Emitter<number>());
		store.add(autorun(reader => {
			const height = reader.readObservable(webview.intrinsicContentSize);
			if (height) {
				onDidChangeHeight.fire(height.height);
				parent.style.height = `${height.height}px`;
			}
		}));

		webview.mountTo(parent, getWindow(parent));
		await rendererData.renderer.renderSetting(webview, context, token);

		return {
			get webview() { return webview; },
			onDidChangeHeight: onDidChangeHeight.event,
			dispose: () => {
				store.dispose();
			},
		};
	}

	private getOrigin(rendererData: RendererEntry): string | undefined {
		return rendererData.options.extension ? this._originStore.getOrigin(rendererData.viewType, rendererData.options.extension.id) : undefined;
	}

	private async getRenderer(viewType: string, token: CancellationToken): Promise<RendererEntry | undefined> {
		await raceCancellationError(this._extensionService.whenInstalledExtensionsRegistered(), token);
		if (this._contributions.has(viewType)) {
			await raceCancellationError(this._extensionService.activateByEvent(`onSettingsEditorRenderer:${viewType}`), token);
		}
		return this._renderers.get(viewType);
	}

	private updateContributions(extensions: readonly IExtensionPointUser<readonly ISettingsEditorRendererContribution[]>[]) {
		this._contributions.clear();
		for (const extension of extensions) {
			if (!isProposedApiEnabled(extension.description, 'settingsEditorRenderer')) {
				continue;
			}

			for (const contribution of extension.value) {
				if (this._contributions.has(contribution.viewType)) {
					extension.collector.error(`Settings editor renderer with view type '${contribution.viewType}' already registered`);
					continue;
				}
				this._contributions.add(contribution.viewType);
			}
		}
		this._onDidChangeRenderers.fire();
	}
}

const settingsEditorRendererContributionSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['viewType'],
	properties: {
		viewType: {
			type: 'string',
			description: nls.localize('settingsEditorRenderer.viewType', 'Unique identifier for the settings editor renderer.'),
		},
	}
} as const satisfies IJSONSchema;

type ISettingsEditorRendererContribution = TypeFromJsonSchema<typeof settingsEditorRendererContributionSchema>;

const settingsEditorRenderContributionPoint = ExtensionsRegistry.registerExtensionPoint<ISettingsEditorRendererContribution[]>({
	extensionPoint: 'settingsEditorRenderers',
	activationEventsGenerator: function* (contributions) {
		for (const contrib of contributions) {
			yield `onSettingsEditorRenderer:${contrib.viewType}`;
		}
	},
	jsonSchema: {
		description: nls.localize('vscode.extension.contributes.settingsEditorRenderers', 'Contributes a custom webview renderer for settings whose configuration schema declares a matching `renderer` view type.'),
		type: 'array',
		items: settingsEditorRendererContributionSchema,
	}
});

registerSingleton(ISettingsEditorRendererService, SettingsEditorRendererService, InstantiationType.Delayed);
