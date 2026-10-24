'use strict';

const { call, siteRef, siteRefFields, storefrontQuery } = require('../lib/api');

/** Suspend, Resume and Delete: one call on the site found by reference or ID. */
const action = ({ key, label, description, method, path, extraFields = [], body }) => ({
  key,
  noun: 'Site',
  display: { label, description },
  operation: {
    inputFields: [...siteRefFields, ...extraFields],
    perform: async (z, bundle) => {
      const ref = siteRef(z, bundle);
      const answer = await call(z, bundle, method, path, {
        params: { ...storefrontQuery(bundle), ...ref },
        body: body ? body(bundle) : undefined,
      });
      return { tenantId: ref.tenantId || null, externalId: ref.externalId || null, ...(answer || {}), scheduled: true };
    },
    sample: { tenantId: '90b97b83-b320-4006-aaa8-dacb0639325c', externalId: 'order-1042', backupId: null, scheduled: true },
    outputFields: [
      { key: 'tenantId', label: 'Site ID' },
      { key: 'externalId', label: 'Your Reference' },
      { key: 'backupId', label: 'Backup ID' },
    ],
  },
});

module.exports = [
  action({
    key: 'suspend_site',
    label: 'Suspend Site',
    description: 'Takes a site offline, backing it up first.',
    method: 'POST',
    path: '/v1/tenants/suspend',
    extraFields: [{ key: 'takeBackup', label: 'Back Up First', type: 'boolean', default: 'true', required: false }],
    body: (bundle) => ({ takeBackup: bundle.inputData.takeBackup !== false && bundle.inputData.takeBackup !== 'false' }),
  }),
  action({
    key: 'resume_site',
    label: 'Resume Site',
    description: 'Brings a suspended site back online.',
    method: 'POST',
    path: '/v1/tenants/resume',
  }),
  action({
    key: 'delete_site',
    label: 'Delete Site',
    description: 'Deletes a site. Its backups are kept, so it can be restored.',
    method: 'DELETE',
    path: '/v1/tenants',
  }),
];
