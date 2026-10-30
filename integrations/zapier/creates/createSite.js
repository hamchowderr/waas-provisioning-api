'use strict';

const { SITE_SAMPLE, call, storefrontField, storefrontQuery } = require('../lib/api');

const perform = async (z, bundle) => {
  const input = bundle.inputData;
  const body = { name: input.name.trim() };
  if (input.externalId) body.externalId = input.externalId.trim();
  if (input.email) {
    body.wordPressUserEmail = input.email.trim();
    body.wordPressUserName = (input.username || input.email).trim();
    body.wordPressUserRole = input.role || 'administrator';
  }
  for (const field of ['size', 'groupName', 'customDomainName']) {
    if (input[field]) body[field] = String(input[field]).trim();
  }
  if (input.notifyOwner === true || input.notifyOwner === 'true') body.notifyOwner = true;
  const created = await call(z, bundle, 'POST', '/v1/tenants', { params: storefrontQuery(bundle), body });
  return { ...created, url: `https://${created.customDomain || created.baseDomain}` };
};

module.exports = {
  key: 'create_site',
  noun: 'Site',
  display: {
    label: 'Create Site',
    description: 'Creates a site from your starting site. Use the Site Event trigger to hear when it is ready.',
  },
  operation: {
    inputFields: [
      storefrontField,
      {
        key: 'name',
        label: 'Site Name',
        required: true,
        helpText: 'Up to 30 characters, starting and ending with a letter or number. The free address is made from it.',
      },
      {
        key: 'externalId',
        label: 'Your Reference',
        required: false,
        helpText:
          'Your own ID for the site, such as the order or deal number. Letters, numbers and dashes only. The same create sent again answers with the site already made, so a Zap that runs twice still makes one site.',
      },
      { key: 'email', label: 'Client Email', required: true, helpText: 'Makes a WordPress login for your client with this email. Every site needs one.' },
      { key: 'username', label: 'Client Username', required: false, helpText: 'Their WordPress username. The email is used when empty.' },
      {
        key: 'role',
        label: 'Client Role',
        required: false,
        default: 'administrator',
        choices: { administrator: 'Administrator', editor: 'Editor', author: 'Author', contributor: 'Contributor' },
      },
      { key: 'size', label: 'Size', required: false, default: 'small', choices: { small: 'Small', medium: 'Medium', large: 'Large' } },
      { key: 'groupName', label: 'Starting Site Group', required: false, helpText: 'Which starting site to copy, by group name. Empty uses your current one.' },
      { key: 'customDomainName', label: 'Custom Domain', required: false, helpText: "The client's own domain, if they have one." },
      {
        key: 'notifyOwner',
        label: 'Notify the Owner',
        type: 'boolean',
        required: false,
        default: 'false',
        helpText: 'Yes emails your client when the site is ready, with a link to set their password. Leave it off to tell them yourself.',
      },
    ],
    perform,
    sample: { id: SITE_SAMPLE.id, externalId: SITE_SAMPLE.externalId, baseDomain: SITE_SAMPLE.domainName, url: SITE_SAMPLE.url },
    outputFields: [
      { key: 'id', label: 'Site ID' },
      { key: 'externalId', label: 'Your Reference' },
      { key: 'baseDomain', label: 'Free Address' },
      { key: 'url', label: 'Site Address' },
    ],
  },
};
