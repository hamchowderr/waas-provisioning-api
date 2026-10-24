import {
	NodeApiError,
	NodeConnectionTypes,
	type IDataObject,
	type IHookFunctions,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
	type JsonObject,
} from 'n8n-workflow';
import {
	anyPressRequest,
	eventToItem,
	getStorefronts,
	SITE_EVENTS,
	storefrontProperty,
	storefrontQuery,
	verifySignature,
} from '../AnyPress/shared';

interface StaticData {
	webhookId?: string;
	webhookSecret?: string;
}

export class AnyPressTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AnyPress Trigger',
		name: 'anyPressTrigger',
		icon: { light: 'file:../../icons/anypress.svg', dark: 'file:../../icons/anypress.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when an AnyPress site is ready, fails, is suspended and more',
		defaults: {
			name: 'AnyPress Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'anyPressApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'AnyPress only sends to https addresses on the public internet, so n8n must be reachable from outside to use this trigger',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			storefrontProperty,
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				options: SITE_EVENTS,
				default: ['tenant.ready'],
				description: 'Which site events start the workflow',
			},
		],
	};

	methods = {
		loadOptions: { getStorefronts },
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node') as StaticData;
				if (!data.webhookId) return false;
				const storefront = storefrontQuery(this.getNodeParameter('storefront', '') as string);
				try {
					const endpoint = (await anyPressRequest.call(
						this,
						'GET',
						`/v1/webhooks/${encodeURIComponent(data.webhookId)}`,
						storefront,
					)) as IDataObject;
					if (endpoint.url === this.getNodeWebhookUrl('default') && data.webhookSecret) return true;
				} catch (error) {
					if ((error as { httpCode?: string }).httpCode !== '404') {
						throw new NodeApiError(this.getNode(), error as JsonObject);
					}
				}
				delete data.webhookId;
				delete data.webhookSecret;
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const storefront = storefrontQuery(this.getNodeParameter('storefront', '') as string);
				const eventTypes = this.getNodeParameter('events', []) as string[];
				try {
					const endpoint = (await anyPressRequest.call(this, 'POST', '/v1/webhooks', storefront, {
						url: this.getNodeWebhookUrl('default') as string,
						description: `n8n: ${this.getWorkflow().name ?? 'workflow'}`.slice(0, 200),
						eventTypes,
					})) as IDataObject;
					const data = this.getWorkflowStaticData('node') as StaticData;
					data.webhookId = endpoint.id as string;
					data.webhookSecret = endpoint.secret as string;
				} catch (error) {
					throw new NodeApiError(this.getNode(), error as JsonObject);
				}
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node') as StaticData;
				if (data.webhookId) {
					const storefront = storefrontQuery(this.getNodeParameter('storefront', '') as string);
					try {
						await anyPressRequest.call(
							this,
							'DELETE',
							`/v1/webhooks/${encodeURIComponent(data.webhookId)}`,
							storefront,
						);
					} catch (error) {
						// Already gone (removed on the dashboard, say) is what we wanted.
						if ((error as { httpCode?: string }).httpCode !== '404') return false;
					}
				}
				delete data.webhookId;
				delete data.webhookSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const data = this.getWorkflowStaticData('node') as StaticData;
		const raw = (req as { rawBody?: Buffer }).rawBody;
		const rawBody = raw ? raw.toString('utf8') : JSON.stringify(req.body);

		if (!data.webhookSecret || !verifySignature(data.webhookSecret, req.headers, rawBody)) {
			const res = this.getResponseObject();
			res.status(401).json({ message: 'The webhook signature does not match' });
			return { noWebhookResponse: true };
		}

		const event = JSON.parse(rawBody) as IDataObject;
		const eventId = req.headers['webhook-id'];
		return {
			workflowData: [
				this.helpers.returnJsonArray([eventToItem(event, Array.isArray(eventId) ? eventId[0] : eventId)]),
			],
		};
	}
}
