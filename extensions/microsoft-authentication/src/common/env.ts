/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Uri } from 'vscode';

export const DEFAULT_REDIRECT_URI = 'https://vscode.dev/redirect';

// Kodrix uses urlProtocol `kodrix`; vscode.dev/redirect will not bounce it back.
// Force non-redirect flows (device code), same approach as github-authentication.
export function isSupportedClient(_uri: Uri): boolean {
	return false;
}
