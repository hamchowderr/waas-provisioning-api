import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class AnyPressApi implements ICredentialType {
	name = 'anyPressApi';

	displayName = 'AnyPress API';

	icon: Icon = { light: 'file:../icons/anypress.svg', dark: 'file:../icons/anypress.dark.svg' };

	documentationUrl = 'https://shop.anypress.io/docs-category/automation/';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'A storefront API key from app.anypress.io (API keys), or a partner key that works on every storefront in a reseller account',
		},
		{
			displayName: 'API Secret',
			name: 'apiSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'The secret shown once when the key was made',
		},
		{
			displayName: 'API Address',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.anypress.io',
			description: 'Change this only if you run your own copy of the API',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			auth: {
				username: '={{$credentials.apiKey}}',
				password: '={{$credentials.apiSecret}}',
			},
		},
	};

	// Starting sites (templates) answer for both storefront keys and partner keys, with no storefront picked.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/v1/basesnapshots',
			method: 'GET',
		},
	};
}
