import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	sleep,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
} from 'n8n-workflow';
import { anyPressRequest, getStorefronts, STATUS, storefrontProperty, storefrontQuery, withUrl } from './shared';

const SITE_REF_OPERATIONS = ['get', 'suspend', 'resume', 'delete'];

export class AnyPress implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AnyPress',
		name: 'anyPress',
		icon: { light: 'file:../../icons/anypress.svg', dark: 'file:../../icons/anypress.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": site"}}',
		description: 'Create and manage WordPress sites on AnyPress',
		defaults: {
			name: 'AnyPress',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'anyPressApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [{ name: 'Site', value: 'site' }],
				default: 'site',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['site'] } },
				options: [
					{
						name: 'Create',
						value: 'create',
						description: 'Create a site from your starting site',
						action: 'Create a site',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a site. Its backups are kept, so it can be restored.',
						action: 'Delete a site',
					},
					{ name: 'Get', value: 'get', description: 'Get a site and its status', action: 'Get a site' },
					{
						name: 'Resume',
						value: 'resume',
						description: 'Bring a suspended site back online',
						action: 'Resume a site',
					},
					{
						name: 'Suspend',
						value: 'suspend',
						description: 'Take a site offline, backing it up first',
						action: 'Suspend a site',
					},
				],
				default: 'create',
			},
			{ ...storefrontProperty, displayOptions: { show: { resource: ['site'] } } },

			// Create
			{
				displayName: 'Site Name',
				name: 'name',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'Rose and Fern',
				description:
					'Up to 30 characters, starting and ending with a letter or number. The free address is made from it, for example rose-and-fern.anypress.site.',
				displayOptions: { show: { resource: ['site'], operation: ['create'] } },
			},
			{
				displayName: 'Your Reference',
				name: 'externalId',
				type: 'string',
				default: '',
				placeholder: 'order-1042',
				description:
					'Your own ID for the site, such as the order, deal or form entry number. Letters, numbers and dashes only. Sending the same create again answers with the site already made, so a retry never builds a second one. Left empty, AnyPress makes one.',
				displayOptions: { show: { resource: ['site'], operation: ['create'] } },
			},
			{
				displayName: 'Client Email',
				name: 'email',
				type: 'string',
				placeholder: 'name@email.com',
				default: '',
				description: 'Makes a WordPress login for your client with this email',
				displayOptions: { show: { resource: ['site'], operation: ['create'] } },
			},
			{
				displayName: 'Wait Until Ready',
				name: 'waitUntilReady',
				type: 'boolean',
				default: false,
				description:
					'Whether to wait for the site to be built before going on (usually a few minutes). Off, the node answers at once and the AnyPress Trigger tells you when the site is ready.',
				displayOptions: { show: { resource: ['site'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['site'], operation: ['create'] } },
				options: [
					{
						displayName: 'Client Role',
						name: 'role',
						type: 'options',
						options: [
							{ name: 'Administrator', value: 'administrator' },
							{ name: 'Author', value: 'author' },
							{ name: 'Contributor', value: 'contributor' },
							{ name: 'Editor', value: 'editor' },
						],
						default: 'administrator',
						description: "The client's WordPress role",
					},
					{
						displayName: 'Client Username',
						name: 'username',
						type: 'string',
						default: '',
						description: "The client's WordPress username. The email is used when this is empty.",
					},
					{
						displayName: 'Custom Domain',
						name: 'customDomainName',
						type: 'string',
						default: '',
						placeholder: 'roseandfern.com',
						description: "The client's own domain, if they have one. It can be added later instead.",
					},
					{
						displayName: 'Size',
						name: 'size',
						type: 'options',
						options: [
							{ name: 'Small', value: 'small' },
							{ name: 'Medium', value: 'medium' },
							{ name: 'Large', value: 'large' },
						],
						default: 'small',
					},
					{
						displayName: 'Starting Site Group',
						name: 'groupName',
						type: 'string',
						default: '',
						description: 'Which of your starting sites to copy, by its group name. Empty uses your current one.',
					},
					{
						displayName: 'Version ID',
						name: 'versionId',
						type: 'string',
						default: '',
						description: 'The storefront version to build on. Empty uses the production version.',
					},
					{
						displayName: 'Wait Timeout (Minutes)',
						name: 'waitMinutes',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 60 },
						default: 15,
						description: 'How long Wait Until Ready waits before giving up',
					},
				],
			},

			// Get, suspend, resume, delete
			{
				displayName: 'Find Site By',
				name: 'findBy',
				type: 'options',
				options: [
					{ name: 'Your Reference', value: 'externalId' },
					{ name: 'Site ID', value: 'tenantId' },
				],
				default: 'externalId',
				displayOptions: { show: { resource: ['site'], operation: SITE_REF_OPERATIONS } },
			},
			{
				displayName: 'Your Reference',
				name: 'ref',
				type: 'string',
				required: true,
				default: '',
				description: 'The reference the site was created with',
				displayOptions: { show: { resource: ['site'], operation: SITE_REF_OPERATIONS, findBy: ['externalId'] } },
			},
			{
				displayName: 'Site ID',
				name: 'siteId',
				type: 'string',
				required: true,
				default: '',
				description: "The site's ID, as Create or the trigger gave it",
				displayOptions: { show: { resource: ['site'], operation: SITE_REF_OPERATIONS, findBy: ['tenantId'] } },
			},
			{
				displayName: 'Back Up First',
				name: 'takeBackup',
				type: 'boolean',
				default: true,
				description: 'Whether to take a full backup before the site goes offline',
				displayOptions: { show: { resource: ['site'], operation: ['suspend'] } },
			},
		],
	};

	methods = {
		loadOptions: { getStorefronts },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				const storefront = storefrontQuery(this.getNodeParameter('storefront', i, '') as string);
				let result: IDataObject;

				if (operation === 'create') {
					result = await createSite.call(this, i, storefront);
				} else {
					const findBy = this.getNodeParameter('findBy', i) as 'externalId' | 'tenantId';
					const value = (
						this.getNodeParameter(findBy === 'externalId' ? 'ref' : 'siteId', i) as string
					).trim();
					const ref = { ...storefront, [findBy]: value };

					if (operation === 'get') {
						const tenant = await getSite.call(this, ref);
						if (!tenant) {
							throw new NodeOperationError(this.getNode(), `No site found with ${findBy} "${value}"`, {
								itemIndex: i,
							});
						}
						result = withUrl(tenant);
					} else if (operation === 'suspend') {
						const takeBackup = this.getNodeParameter('takeBackup', i) as boolean;
						result = (await anyPressRequest.call(this, 'POST', '/v1/tenants/suspend', ref, {
							takeBackup,
						})) as IDataObject;
					} else if (operation === 'resume') {
						result = (await anyPressRequest.call(this, 'POST', '/v1/tenants/resume', ref)) as IDataObject;
					} else if (operation === 'delete') {
						await anyPressRequest.call(this, 'DELETE', '/v1/tenants', ref);
						result = { deleted: true, [findBy]: value };
					} else {
						throw new NodeOperationError(this.getNode(), `The operation "${operation}" is not supported`, {
							itemIndex: i,
						});
					}
				}

				returnData.push({ json: result, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// Errors from the API already arrive as NodeApiError; anything else is wrapped so n8n shows it well.
				throw error instanceof NodeOperationError || error instanceof NodeApiError
					? error
					: new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}

async function getSite(this: IExecuteFunctions, ref: IDataObject): Promise<IDataObject | undefined> {
	const tenants = (await anyPressRequest.call(this, 'GET', '/v1/tenants', ref)) as IDataObject[];
	return tenants[0];
}

async function createSite(this: IExecuteFunctions, i: number, storefront: IDataObject): Promise<IDataObject> {
	const email = (this.getNodeParameter('email', i, '') as string).trim();
	const externalId = (this.getNodeParameter('externalId', i, '') as string).trim();
	const extra = this.getNodeParameter('additionalFields', i, {}) as {
		role?: string;
		username?: string;
		customDomainName?: string;
		size?: string;
		groupName?: string;
		versionId?: string;
		waitMinutes?: number;
	};

	const body: IDataObject = { name: (this.getNodeParameter('name', i) as string).trim() };
	if (externalId) body.externalId = externalId;
	if (email) {
		body.wordPressUserEmail = email;
		body.wordPressUserName = extra.username?.trim() || email;
		body.wordPressUserRole = extra.role || 'administrator';
	}
	for (const field of ['customDomainName', 'size', 'groupName', 'versionId'] as const) {
		const value = extra[field]?.trim();
		if (value) body[field] = value;
	}

	const created = (await anyPressRequest.call(this, 'POST', '/v1/tenants', storefront, body)) as IDataObject;
	if (!this.getNodeParameter('waitUntilReady', i, false)) return created;

	const deadline = Date.now() + (extra.waitMinutes ?? 15) * 60_000;
	const ref = { ...storefront, tenantId: created.id as string };
	for (;;) {
		const tenant = await getSite.call(this, ref);
		if (tenant?.statusCode === STATUS.Done) return { ...withUrl(tenant), created };
		if (tenant?.statusCode === STATUS.Failed) {
			throw new NodeOperationError(this.getNode(), `The site "${body.name as string}" failed to build`, {
				itemIndex: i,
				description: 'AnyPress has been told. Try again, or write to support@anypress.io.',
			});
		}
		if (Date.now() + 10_000 > deadline) {
			throw new NodeOperationError(this.getNode(), `The site "${body.name as string}" was not ready in time`, {
				itemIndex: i,
				description: 'It is still being built. Use Get later, or the AnyPress Trigger, to find out when it is ready.',
			});
		}
		await sleep(10_000);
	}
}
