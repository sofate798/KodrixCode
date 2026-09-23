/*---------------------------------------------------------------------------------------------
 *  Shared helper: load webview HTML with CSP + Codicons stylesheet.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Load an HTML file from `resources/`, inject CSP source and Codicons CSS URI.
 * Callers must include `resources` (or `resources/codicons`) in `localResourceRoots`.
 */
export function loadWebviewHtml(
	webview: vscode.Webview,
	extensionPath: string,
	htmlFileName: string,
): string {
	const resourcesDir = path.join(extensionPath, 'resources');
	const htmlPath = path.join(resourcesDir, htmlFileName);
	const codiconsCssUri = webview.asWebviewUri(
		vscode.Uri.file(path.join(resourcesDir, 'codicons', 'codicon.css')),
	);
	const html = fs.readFileSync(htmlPath, 'utf-8');
	return html
		.replace(/\{\{cspSource\}\}/g, webview.cspSource)
		.replace(/\{\{codiconsCssUri\}\}/g, codiconsCssUri.toString());
}

/** Resources that must be allow-listed for Codicons + page assets. */
export function webviewResourceRoots(extensionPath: string): vscode.Uri[] {
	return [vscode.Uri.file(path.join(extensionPath, 'resources'))];
}
