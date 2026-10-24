'use strict';

const { SITE_OUTPUT_FIELDS, SITE_SAMPLE, call, siteRef, siteRefFields, storefrontQuery, withUrl } = require('../lib/api');

const perform = async (z, bundle) => {
  const tenants = await call(z, bundle, 'GET', '/v1/tenants', { params: { ...storefrontQuery(bundle), ...siteRef(z, bundle) } });
  return tenants.slice(0, 1).map(withUrl);
};

module.exports = {
  key: 'find_site',
  noun: 'Site',
  display: { label: 'Find Site', description: 'Finds a site by your reference or its ID, with its status and address.' },
  operation: {
    inputFields: siteRefFields,
    perform,
    sample: SITE_SAMPLE,
    outputFields: SITE_OUTPUT_FIELDS,
  },
};
