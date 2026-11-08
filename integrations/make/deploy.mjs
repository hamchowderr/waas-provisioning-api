// Deploys this folder to the AnyPress custom app on Make with Make's official SDK (@makehq/sdk):
// the same steps as the Make Apps VS Code extension's "Deploy to Make". Run by
// .github/workflows/release-make.yml after `npm ci` in this folder.
//
//   MAKE_API_TOKEN  a Make API token with the sdk-apps:read and sdk-apps:write scopes
//   MAKE_ZONE       the Make zone the account is in, such as us1.make.com or eu2.make.com
//   MAKE_APP_ID     the app's name in Make, or the start of it: Make adds a suffix when it creates
//                   the app (anypress becomes anypress-ab12cd). Created the first time
//
// Components are matched by name (modules) or by label (the connection and the webhook, whose
// names Make picks), so running it again updates the same app. The SDK has no method for a few
// settings (a webhook's update code, and a module's webhook, connection and crud together), so
// those go through the SDK's own authenticated make.fetch.
import { readFileSync } from 'node:fs';
import { Make, MakeError } from '@makehq/sdk';

const dir = new URL('./', import.meta.url);
const { MAKE_API_TOKEN: token, MAKE_ZONE: zone, MAKE_APP_ID: appId } = process.env;
if (!token || !zone || !appId) throw new Error('MAKE_API_TOKEN, MAKE_ZONE and MAKE_APP_ID are required');
const version = 1;
const app = JSON.parse(readFileSync(new URL('makecomapp.json', dir), 'utf8'));
const MODULE_TYPES = { trigger: 1, action: 4, search: 9, instant_trigger: 10, responder: 11, universal: 12 };
// The AnyPress ribbon "A": black on transparent, which Make shows as white on the theme colour.
const THEME = '#EE2F5E';
const ICON = 'assets/icon.png';

const make = new Make(token, zone);
const { apps, connections, webhooks, modules } = make.sdk;
const read = (file) => readFileSync(new URL(file, dir), 'utf8');

/** Runs one upload when the file is set, and logs it. IML files go up as written, comments included. */
async function upload(file, put) {
  if (!file) return;
  await put(read(file));
  console.log(`  ${file}`);
}

// The app itself. Make adds a suffix to new app names (anypress becomes anypress-ab12cd), and
// answers 403 rather than 404 for a name the token can't see, so find it among the token's own apps.
const ownApps = await apps.list();
let found = ownApps.find((a) => a.name === appId || a.name.startsWith(`${appId}-`));
if (!found) {
  console.log(`Creating app ${appId}`);
  found = await apps.create({
    name: appId,
    label: 'AnyPress',
    version,
    description: 'Create and manage WordPress sites on AnyPress, and start a scenario when a site is ready.',
    theme: THEME,
    language: 'en',
    audience: 'global',
  });
}
const appName = found.name;
console.log(`App ${appName}`);
await apps.update(appName, version, { theme: THEME });
await apps.setIcon(appName, version, readFileSync(new URL(ICON, dir)));
console.log(`  ${ICON} (theme ${THEME})`);
await upload(app.generalCodeFiles.base, (code) => apps.setSection(appName, version, 'base', code));
await upload(app.generalCodeFiles.common, (code) => apps.setCommon(appName, version, JSON.parse(code)));
await upload(app.generalCodeFiles.readme, (code) => apps.setDocs(appName, version, code));

// The connection.
const connectionNames = {};
const existingConnections = await connections.list(appName);
for (const [localId, meta] of Object.entries(app.components.connection)) {
  let name = existingConnections.find((c) => c.label === meta.label)?.name;
  if (!name) name = (await connections.create(appName, { label: meta.label, type: meta.connectionType })).name;
  connectionNames[localId] = name;
  console.log(`Connection ${localId} = ${name}`);
  await upload(meta.codeFiles.communication, (code) => connections.setSection(name, 'api', code));
  await upload(meta.codeFiles.params, (code) => connections.setSection(name, 'parameters', code));
}

// The webhook.
const webhookNames = {};
const existingWebhooks = await webhooks.list(appName);
for (const [localId, meta] of Object.entries(app.components.webhook)) {
  let name = existingWebhooks.find((w) => w.label === meta.label)?.name;
  const connection = connectionNames[meta.connection] ?? null;
  if (!name) {
    const created = await make.fetch(`/sdk/apps/${appName}/webhooks`, { method: 'POST', body: { label: meta.label, type: meta.webhookType, connection } });
    name = created.appWebhook.name;
  }
  webhookNames[localId] = name;
  console.log(`Webhook ${localId} = ${name}`);
  await make.fetch(`/sdk/apps/webhooks/${name}`, { method: 'PATCH', body: { label: meta.label, connection, altConnection: null } });
  const files = meta.codeFiles;
  await upload(files.communication, (code) => webhooks.setSection(name, 'api', code));
  await upload(files.params, (code) => webhooks.setSection(name, 'parameters', code));
  await upload(files.attach, (code) => webhooks.setSection(name, 'attach', code));
  await upload(files.detach, (code) => webhooks.setSection(name, 'detach', code));
  // "update" isn't in the SDK's list of webhook sections yet; it's the same call.
  await upload(files.update, (code) =>
    make.fetch(`/sdk/apps/webhooks/${name}/update`, { method: 'PUT', headers: { 'Content-Type': 'application/jsonc' }, body: code }),
  );
  await upload(files.requiredScope, (code) => webhooks.setSection(name, 'scope', code));
}

// The modules, named as in makecomapp.json.
for (const [name, meta] of Object.entries(app.components.module)) {
  const typeId = MODULE_TYPES[meta.moduleType];
  const metadata = {
    label: meta.label,
    description: meta.description,
    typeId,
    connection: connectionNames[meta.connection] ?? null,
    altConnection: null,
    ...(meta.moduleType === 'action' ? { crud: meta.actionCrud } : {}),
    ...(meta.moduleType === 'instant_trigger' ? { webhook: webhookNames[meta.webhook] } : {}),
  };
  const exists = await modules.get(appName, version, name).then(
    () => true,
    (err) => {
      if (err instanceof MakeError && err.statusCode === 404) return false;
      throw err;
    },
  );
  if (!exists) {
    console.log(`Creating module ${name}`);
    await make.fetch(`/sdk/apps/${appName}/${version}/modules`, { method: 'POST', body: { name, moduleInitMode: 'blank', ...metadata } });
  }
  console.log(`Module ${name}`);
  // modules.update only takes label, description and connection; the webhook and crud go too.
  await make.fetch(`/sdk/apps/${appName}/${version}/modules/${name}`, { method: 'PATCH', body: metadata });
  const files = meta.codeFiles;
  const section = (s) => (code) => modules.setSection(appName, version, name, s, code);
  await upload(files.communication, section('api'));
  await upload(files.staticParams, section('parameters'));
  await upload(files.mappableParams, section('expect'));
  await upload(files.interface, section('interface'));
  await upload(files.samples, section('samples'));
  await upload(files.scope, section('scope'));
}

// groups goes up last: Make checks that the modules it names exist.
await upload(app.generalCodeFiles.groups, (code) => apps.setSection(appName, version, 'groups', code));

console.log(`Deployed ${appName} to ${zone}`);
