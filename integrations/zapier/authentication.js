'use strict';

const { baseUrl } = require('./lib/api');

/**
 * Checks the key and says what kind it is. A partner key reads its reseller account; a storefront's
 * own key gets 403 there, and is checked on the starting sites list, which both kinds can read.
 */
const test = async (z, bundle) => {
  const account = await z.request({ url: `${baseUrl(bundle)}/v1/subscriptions`, skipThrowForStatus: true });
  if (account.status === 200 && Array.isArray(account.data) && account.data[0]) {
    return { kind: 'Partner key', name: account.data[0].name };
  }
  const own = await z.request({ url: `${baseUrl(bundle)}/v1/basesnapshots`, skipThrowForStatus: true });
  if (own.status >= 400) {
    throw new z.errors.Error('AnyPress did not accept that API key and secret', 'AuthenticationError', own.status);
  }
  return { kind: 'Storefront key', name: String(bundle.authData.apiKey).slice(0, 8) };
};

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'apiKey',
      label: 'API Key',
      required: true,
      helpText:
        'Make one at [app.anypress.io](https://app.anypress.io) under API keys. Resellers can ask for a partner key, which works on every storefront in the account.',
    },
    { key: 'apiSecret', label: 'API Secret', required: true, type: 'password', helpText: 'Shown once, when the key was made.' },
    {
      key: 'baseUrl',
      label: 'API Address',
      required: false,
      default: 'https://api.anypress.io',
      helpText: 'Change this only if you run your own copy of the API.',
    },
  ],
  test,
  connectionLabel: '{{kind}}: {{name}}',
};
