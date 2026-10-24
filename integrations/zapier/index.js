'use strict';

const authentication = require('./authentication');
const siteEvent = require('./triggers/siteEvent');
const storefronts = require('./triggers/storefronts');
const createSite = require('./creates/createSite');
const siteActions = require('./creates/siteActions');
const findSite = require('./searches/findSite');

/** Signs every request with the connection's key and secret (Basic auth). */
const addAuth = (request, z, bundle) => {
  const { apiKey, apiSecret } = bundle.authData || {};
  if (apiKey && apiSecret) {
    request.headers = request.headers || {};
    request.headers.Authorization = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
    request.headers.Accept = 'application/json';
  }
  return request;
};

const byKey = (list) => Object.fromEntries(list.map((item) => [item.key, item]));

module.exports = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,
  authentication,
  beforeRequest: [addAuth],
  afterResponse: [],
  triggers: byKey([siteEvent, storefronts]),
  searches: byKey([findSite]),
  creates: byKey([createSite, ...siteActions]),
  resources: {},
};
