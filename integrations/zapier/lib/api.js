'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');

const DEFAULT_BASE_URL = 'https://api.anypress.io';

/** The API address from the connection, without a trailing slash. */
const baseUrl = (bundle) => String(bundle.authData.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

/** A partner key names the storefront on every site call; a storefront's own key ignores it. */
const storefrontQuery = (bundle) => (bundle.inputData.storefront ? { productId: bundle.inputData.storefront } : {});

/** The site to act on: by the caller's own reference (externalId) or by the site's id. */
const siteRef = (z, bundle) => {
  const externalId = (bundle.inputData.externalId || '').trim();
  const tenantId = (bundle.inputData.siteId || '').trim();
  if (!externalId && !tenantId) throw new z.errors.Error('Fill in Your Reference or Site ID', 'MissingSite', 400);
  return tenantId ? { tenantId } : { externalId };
};

/** One call to the API. The Basic auth header is added by the app's beforeRequest middleware. */
const call = async (z, bundle, method, path, { params = {}, body } = {}) => {
  const response = await z.request({
    method,
    url: `${baseUrl(bundle)}${path}`,
    params,
    body,
    skipThrowForStatus: true,
  });
  if (response.status >= 400) {
    const message = (response.data && response.data.message) || `AnyPress answered ${response.status}`;
    throw new z.errors.Error(message, `Http${response.status}`, response.status);
  }
  return response.content ? response.data : null;
};

/** A site as the API lists it, plus its address with https:// in front. */
const withUrl = (tenant) => ({ ...tenant, url: tenant.domainName ? `https://${tenant.domainName}` : null });

/**
 * Headers of a hook request, by lowercased name. Zapier gives them in Camel-Case with an Http-
 * prefix (Http-Webhook-Signature); plain names are accepted too.
 */
const hookHeaders = (rawHeaders = {}) => {
  const headers = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    headers[name.toLowerCase().replace(/^http-/, '')] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
};

/**
 * Checks a webhook request from AnyPress (Standard Webhooks signing): `v1,` and the base64
 * HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<raw body>`, keyed by the base64-decoded part of
 * the secret after `whsec_`. A timestamp more than five minutes off is refused.
 */
const verifySignature = (secret, headers, rawBody, nowSeconds = Date.now() / 1000) => {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatures = headers['webhook-signature'];
  if (!secret || !id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = Buffer.from(createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64'));
  return signatures.split(' ').some((signature) => {
    const [version, value] = signature.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
};

/** One flat item from a webhook event. `id` is the event id, the same on every retry of that event. */
const eventToItem = (event, eventId) => {
  const { tenant, version, ...rest } = event.data || {};
  return {
    ...(tenant ? withUrl(tenant) : {}),
    ...rest,
    ...(version ? { version } : {}),
    id: eventId,
    siteId: tenant ? tenant.id : null,
    event: event.type,
    timestamp: event.timestamp,
  };
};

const SITE_EVENTS = {
  'tenant.ready': 'Site ready',
  'tenant.failed': 'Site failed',
  'tenant.updated': 'Site updated',
  'tenant.domains_changed': 'Domains changed',
  'tenant.version_changed': 'Version changed',
  'tenant.suspended': 'Site suspended',
  'tenant.resumed': 'Site resumed',
  'tenant.live': 'Moved-in site live',
  'tenant.deleted': 'Site deleted',
  'tenant.restored': 'Site restored',
  'tenant.rolled_back': 'Site rolled back',
  'tenant.backup_completed': 'Backup completed',
  'tenant.backup_failed': 'Backup failed',
};

/** The storefront field every site step has. Only partner keys need it. */
const storefrontField = {
  key: 'storefront',
  label: 'Storefront',
  dynamic: 'storefronts.id.name',
  required: false,
  helpText:
    'Partner keys only: which storefront in the account the site belongs to. Leave it empty with a storefront\'s own API key.',
};

const siteRefFields = [
  storefrontField,
  {
    key: 'externalId',
    label: 'Your Reference',
    required: false,
    helpText: 'The reference the site was created with, such as the order number. Fill in this or Site ID.',
  },
  { key: 'siteId', label: 'Site ID', required: false, helpText: "The site's ID, from Create Site or the trigger." },
];

const SITE_SAMPLE = {
  tenantId: '90b97b83-b320-4006-aaa8-dacb0639325c',
  id: '90b97b83-b320-4006-aaa8-dacb0639325c',
  externalId: 'order-1042',
  name: 'Rose and Fern',
  domainName: 'rose-and-fern.anypress.site',
  url: 'https://rose-and-fern.anypress.site',
  statusCode: 1,
  statusName: 'Done',
  isSuspended: false,
  size: 'small',
  dateCreated: '2026-10-24T17:00:00Z',
};

const SITE_OUTPUT_FIELDS = [
  { key: 'tenantId', label: 'Site ID' },
  { key: 'externalId', label: 'Your Reference' },
  { key: 'name', label: 'Site Name' },
  { key: 'url', label: 'Site Address' },
  { key: 'domainName', label: 'Domain' },
  { key: 'statusName', label: 'Status' },
  { key: 'isSuspended', label: 'Suspended', type: 'boolean' },
  { key: 'size', label: 'Size' },
  { key: 'dateCreated', label: 'Created' },
];

module.exports = {
  DEFAULT_BASE_URL,
  SITE_EVENTS,
  SITE_OUTPUT_FIELDS,
  SITE_SAMPLE,
  baseUrl,
  call,
  eventToItem,
  hookHeaders,
  siteRef,
  siteRefFields,
  storefrontField,
  storefrontQuery,
  verifySignature,
  withUrl,
};
