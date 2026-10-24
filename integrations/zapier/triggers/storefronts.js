'use strict';

const { baseUrl, call } = require('../lib/api');

/** Hidden: fills the Storefront dropdown. A storefront's own key can't list storefronts (403), and needs none. */
const perform = async (z, bundle) => {
  const probe = await z.request({ url: `${baseUrl(bundle)}/v1/products`, skipThrowForStatus: true });
  if (probe.status === 403) return [];
  const products = await call(z, bundle, 'GET', '/v1/products');
  return products.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
};

module.exports = {
  key: 'storefronts',
  noun: 'Storefront',
  display: { label: 'List Storefronts', description: 'The storefronts of a partner key, for dropdowns.', hidden: true },
  operation: {
    perform,
    sample: { id: '9d4b7e12-5a1c-4f0e-8b3d-2c6e7f9a1b04', name: 'Acme Florists' },
    outputFields: [
      { key: 'id', label: 'Storefront ID' },
      { key: 'name', label: 'Name' },
    ],
  },
};
