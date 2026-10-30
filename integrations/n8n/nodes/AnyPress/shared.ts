import { createHmac, timingSafeEqual } from 'crypto';
import { NodeApiError } from 'n8n-workflow';
import type {
	IDataObject,
	JsonObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeProperties,
} from 'n8n-workflow';

export const DEFAULT_BASE_URL = 'https://api.anypress.io';

type Context = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions;

/** One call to the AnyPress API, signed in with the AnyPress API credential (Basic auth). */
export async function anyPressRequest(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	qs: IDataObject = {},
	body?: IDataObject,
): Promise<unknown> {
	const credentials = await this.getCredentials('anyPressApi');
	const baseUrl = String(credentials.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${path}`,
		qs,
		json: true,
	};
	if (body !== undefined) options.body = body;
	return await this.helpers.httpRequestWithAuthentication.call(this, 'anyPressApi', options);
}

/** The storefront query a partner key needs on every site call. A storefront's own key ignores it. */
export function storefrontQuery(storefront: string): IDataObject {
	return storefront ? { productId: storefront } : {};
}

/**
 * The storefronts in a reseller account, for a partner key. A storefront's own key can't list
 * storefronts (403): it only ever works on its own, so the one choice is that.
 */
export async function getStorefronts(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const own: INodePropertyOptions = { name: "This Key's Own Storefront", value: '' };
	let products: Array<{ id: string; name: string }>;
	try {
		products = (await anyPressRequest.call(this, 'GET', '/v1/products')) as typeof products;
	} catch (error) {
		const status = (error as { httpCode?: string }).httpCode;
		if (status === '403') return [own];
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
	return products
		.map((p) => ({ name: p.name, value: p.id }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export const storefrontProperty: INodeProperties = {
	displayName: 'Storefront Name or ID',
	name: 'storefront',
	type: 'options',
	typeOptions: { loadOptionsMethod: 'getStorefronts' },
	default: '',
	description:
		'Partner keys only: which storefront in the account the site belongs to. Leave it on the first choice with a storefront\'s own key. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
};

/** A site as the API lists it, plus its address with https:// in front. */
export function withUrl(tenant: IDataObject): IDataObject {
	const domain = tenant.domainName;
	return { ...tenant, url: typeof domain === 'string' && domain ? `https://${domain}` : null };
}

export const STATUS = { Pending: 0, Done: 1, Failed: 2, Removing: 3 } as const;

/** Every site event the API sends (docs/webhooks.md in the API repository). */
export const SITE_EVENTS: INodePropertyOptions[] = [
	{ name: 'Site Ready', value: 'tenant.ready', description: 'A new site is built and answering' },
	{ name: 'Site Failed', value: 'tenant.failed', description: 'A change still failed after its retries' },
	{ name: 'Site Updated', value: 'tenant.updated', description: 'Its options, size or email packs were applied' },
	{ name: 'Domains Changed', value: 'tenant.domains_changed', description: 'Its domains were applied' },
	{ name: 'Version Changed', value: 'tenant.version_changed', description: 'It moved to another version' },
	{ name: 'Site Suspended', value: 'tenant.suspended', description: 'Taken offline' },
	{ name: 'Site Resumed', value: 'tenant.resumed', description: 'Back online' },
	{ name: 'Moved-In Site Live', value: 'tenant.live', description: 'A site moved in went live: its hold ended' },
	{ name: 'Site Deleted', value: 'tenant.deleted', description: 'The site is gone' },
	{ name: 'Site Restored', value: 'tenant.restored', description: 'A deleted site is back from its backup' },
	{ name: 'Site Rolled Back', value: 'tenant.rolled_back', description: 'A live site went back to one of its backups' },
	{ name: 'Backup Completed', value: 'tenant.backup_completed', description: 'A backup finished, nightly ones included' },
	{ name: 'Backup Failed', value: 'tenant.backup_failed', description: 'A backup failed' },
];

/**
 * Checks a webhook request from AnyPress (Standard Webhooks signing): `v1,` and the base64
 * HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<raw body>`, keyed by the base64-decoded part of
 * the secret after `whsec_`. A timestamp more than five minutes off is refused, so an old request
 * can't be sent again.
 */
export function verifySignature(
	secret: string,
	headers: Record<string, string | string[] | undefined>,
	rawBody: string,
	nowSeconds = Date.now() / 1000,
): boolean {
	const header = (name: string) => {
		const value = headers[name];
		return Array.isArray(value) ? value[0] : value;
	};
	const id = header('webhook-id');
	const timestamp = header('webhook-timestamp');
	const signatures = header('webhook-signature');
	if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) return false;
	if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
	const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
	const expected = Buffer.from(createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64'));
	return signatures.split(' ').some((signature) => {
		const [version, value] = signature.split(',');
		if (version !== 'v1' || !value) return false;
		const given = Buffer.from(value);
		return given.length === expected.length && timingSafeEqual(given, expected);
	});
}

/** One flat item from a webhook event: the event's own fields, then the site's, then its address. */
export function eventToItem(event: IDataObject, eventId: string | undefined): IDataObject {
	const data = (event.data ?? {}) as IDataObject;
	const { tenant, version, ...rest } = data;
	const item: IDataObject = { event: event.type, eventId: eventId ?? null, timestamp: event.timestamp, ...rest };
	if (tenant && typeof tenant === 'object') Object.assign(item, withUrl(tenant as IDataObject));
	if (version && typeof version === 'object') item.version = version;
	return item;
}
