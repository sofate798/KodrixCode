'use strict';
module.exports = {
	routeModel: async ({ tier }) => {
		global.__fimFastCalled = tier;
		return {
			model: {
				sendRequest: async () => ({
					stream: (async function* () { yield new (require('vscode').LanguageModelTextPart)('fast result'); })(),
				}),
			},
		};
	},
};
