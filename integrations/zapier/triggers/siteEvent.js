'use strict';

const {
  SITE_EVENTS,
  SITE_OUTPUT_FIELDS,
  SITE_SAMPLE,
  baseUrl,
  call,
  eventToItem,
  hookHeaders,
  storefrontField,
  storefrontQuery,
  verifySignature,
} = require('../lib/api');

/** Registers the Zap's hook address with AnyPress. The answer keeps the endpoint id and its signing secret. */
const performSubscribe = (z, bundle) =>
  call(z, bundle, 'POST', '/v1/webhooks', {
    params: storefrontQuery(bundle),
    body: { url: bundle.targetUrl, eventTypes: [bundle.inputData.event], description: 'Zapier' },
  });

const performUnsubscribe = async (z, bundle) => {
  const response = await z.request({
    method: 'DELETE',
    url: `${baseUrl(bundle)}/v1/webhooks/${encodeURIComponent(bundle.subscribeData.id)}`,
    params: storefrontQuery(bundle),
    skipThrowForStatus: true,
  });
  // Already gone, removed on the dashboard say, is what was wanted.
  if (response.status >= 400 && response.status !== 404) {
    throw new z.errors.Error((response.data && response.data.message) || `AnyPress answered ${response.status}`, `Http${response.status}`, response.status);
  }
  return {};
};

/** A request from AnyPress. One with a bad or old signature starts nothing. */
const perform = (z, bundle) => {
  const raw = bundle.rawRequest || {};
  const headers = hookHeaders(raw.headers);
  const body = typeof raw.content === 'string' ? raw.content : JSON.stringify(bundle.cleanedRequest);
  if (!verifySignature(bundle.subscribeData && bundle.subscribeData.secret, headers, body)) {
    z.console.log('Ignored a request whose AnyPress signature does not match');
    return [];
  }
  return [eventToItem(JSON.parse(body), headers['webhook-id'])];
};

/** Samples while setting up the Zap: the newest sites, shaped like an event. */
const performList = async (z, bundle) => {
  const tenants = await call(z, bundle, 'GET', '/v1/tenants', { params: storefrontQuery(bundle) });
  return tenants
    .sort((a, b) => String(b.dateCreated).localeCompare(String(a.dateCreated)))
    .slice(0, 3)
    .map((tenant) =>
      eventToItem({ type: bundle.inputData.event, timestamp: tenant.dateChanged || tenant.dateCreated, data: { tenant } }, `sample-${tenant.id}`),
    );
};

module.exports = {
  key: 'site_event',
  noun: 'Site',
  display: {
    label: 'Site Event',
    description: 'Starts when a site is ready, fails, is suspended, resumed, deleted and more.',
  },
  operation: {
    type: 'hook',
    inputFields: [
      storefrontField,
      {
        key: 'event',
        label: 'Event',
        required: true,
        choices: SITE_EVENTS,
        default: 'tenant.ready',
        altersDynamicFields: false,
      },
    ],
    performSubscribe,
    performUnsubscribe,
    perform,
    performList,
    sample: { ...SITE_SAMPLE, id: '5b1d6c0e-7f2a-4c3e-9a8b-1d2e3f4a5b6c', siteId: SITE_SAMPLE.id, event: 'tenant.ready', timestamp: '2026-10-24T17:03:00Z' },
    outputFields: [{ key: 'event', label: 'Event' }, { key: 'id', label: 'Event ID' }, { key: 'timestamp', label: 'When' }, ...SITE_OUTPUT_FIELDS],
  },
};
