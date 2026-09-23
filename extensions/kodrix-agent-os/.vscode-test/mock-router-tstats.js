'use strict';
module.exports = {
	routeModel: async () => ({
		model: { sendRequest: async () => ({ stream: (async function* () { yield new (require('vscode').LanguageModelTextPart)('fast result'); })() }) },
	}),
};
