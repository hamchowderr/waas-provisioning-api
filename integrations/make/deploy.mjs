// Deploys this folder to a Make custom app through Make's API: the same calls the Make Apps
// VS Code extension makes for "Deploy to Make". Run by .github/workflows/release-make.yml.
//
//   MAKE_API_TOKEN  a Make API token with the sdk-apps:read and sdk-apps:write scopes
//   MAKE_ZONE       the Make zone the account is in, such as us1.make.com or eu2.make.com
//   MAKE_APP_ID     the app's name in Make, or the start of it: Make adds a suffix when it creates
//                   the app (anypress becomes anypress-ab12cd). Created the first time
//
// Components are matched by name (modules) or by label (the connection and the webhook, whose
// names Make picks), so running it again updates the same app.
import { readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const { MAKE_API_TOKEN: token, MAKE_ZONE: zone, MAKE_APP_ID: appId } = process.env;
if (!token || !zone || !appId) throw new Error('MAKE_API_TOKEN, MAKE_ZONE and MAKE_APP_ID are required');
const version = 1;
const api = `https://${zone}/api/v2/sdk/apps`;
const app = JSON.parse(readFileSync(new URL('makecomapp.json', dir), 'utf8'));
const MODULE_TYPES = { trigger: 1, action: 4, search: 9, instant_trigger: 10, responder: 11, universal: 12 };

async function call(method, url, body, contentType = 'application/json') {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Token ${token}`, ...(body === undefined ? {} : { 'Content-Type': contentType }) },
    // Code files arrive as text already; only objects get encoded here.
    body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  if (method === 'GET' && res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

/** Uploads one code file. IML files go up as written, comments included, as the extension sends them. */
async function putCode(url, file) {
  if (!file) return;
  const type = file.endsWith('.md') ? 'text/markdown' : file.endsWith('.jsonc') ? 'application/jsonc' : 'application/json';
  await call('PUT', url, readFileSync(new URL(file, dir), 'utf8'), type);
  console.log(`  ${file}`);
}

// The app itself. Make adds a suffix to new app names (anypress becomes anypress-ab12cd), and
// answers 403 rather than 404 for a name the token can't see, so find it among the token's own apps.
const ownApps = (await call('GET', api)).apps ?? [];
let found = ownApps.find((a) => a.name === appId || a.name.startsWith(`${appId}-`));
if (!found) {
  console.log(`Creating app ${appId}`);
  const created = await call('POST', api, {
    name: appId,
    label: 'AnyPress',
    version,
    description: 'Create and manage WordPress sites on AnyPress, and start a scenario when a site is ready.',
    theme: '#EE2F5E',
    language: 'en',
    audience: 'global',
  });
  found = created.app ?? created;
}
const appName = found.name;
console.log(`App ${appName}`);
// groups goes up last: Make checks that the modules it names exist.
const general = { base: 'base', common: 'common', readme: 'readme' };
for (const [code, path] of Object.entries(general)) await putCode(`${api}/${appName}/${version}/${path}`, app.generalCodeFiles[code]);

// The connection.
const connectionNames = {};
const connections = (await call('GET', `${api}/${appName}/connections`)).appConnections ?? [];
for (const [localId, meta] of Object.entries(app.components.connection)) {
  let name = connections.find((c) => c.label === meta.label)?.name;
  if (!name) name = (await call('POST', `${api}/${appName}/connections`, { label: meta.label, type: meta.connectionType })).appConnection.name;
  connectionNames[localId] = name;
  console.log(`Connection ${localId} = ${name}`);
  await putCode(`${api}/connections/${name}/api`, meta.codeFiles.communication);
  await putCode(`${api}/connections/${name}/parameters`, meta.codeFiles.params);
}

// The webhook.
const webhookNames = {};
const webhooks = (await call('GET', `${api}/${appName}/webhooks`)).appWebhooks ?? [];
for (const [localId, meta] of Object.entries(app.components.webhook)) {
  let name = webhooks.find((w) => w.label === meta.label)?.name;
  const connection = connectionNames[meta.connection] ?? null;
  if (!name) name = (await call('POST', `${api}/${appName}/webhooks`, { label: meta.label, type: meta.webhookType, connection })).appWebhook.name;
  webhookNames[localId] = name;
  console.log(`Webhook ${localId} = ${name}`);
  await call('PATCH', `${api}/webhooks/${name}`, { label: meta.label, connection, altConnection: null });
  const files = meta.codeFiles;
  await putCode(`${api}/webhooks/${name}/api`, files.communication);
  await putCode(`${api}/webhooks/${name}/parameters`, files.params);
  await putCode(`${api}/webhooks/${name}/attach`, files.attach);
  await putCode(`${api}/webhooks/${name}/detach`, files.detach);
  await putCode(`${api}/webhooks/${name}/update`, files.update);
  await putCode(`${api}/webhooks/${name}/scope`, files.requiredScope);
}

// The modules, named as in makecomapp.json.
for (const [name, meta] of Object.entries(app.components.module)) {
  const url = `${api}/${appName}/${version}/modules/${name}`;
  const metadata = {
    label: meta.label,
    description: meta.description,
    typeId: MODULE_TYPES[meta.moduleType],
    connection: connectionNames[meta.connection] ?? null,
    altConnection: null,
    ...(meta.moduleType === 'action' ? { crud: meta.actionCrud } : {}),
    ...(meta.moduleType === 'instant_trigger' ? { webhook: webhookNames[meta.webhook] } : {}),
  };
  if (!(await call('GET', url))) {
    console.log(`Creating module ${name}`);
    await call('POST', `${api}/${appName}/${version}/modules`, { name, moduleInitMode: 'blank', ...metadata });
  }
  console.log(`Module ${name}`);
  await call('PATCH', url, metadata);
  const files = meta.codeFiles;
  await putCode(`${url}/api`, files.communication);
  await putCode(`${url}/parameters`, files.staticParams);
  await putCode(`${url}/expect`, files.mappableParams);
  await putCode(`${url}/interface`, files.interface);
  await putCode(`${url}/samples`, files.samples);
  await putCode(`${url}/scope`, files.scope);
}

await putCode(`${api}/${appName}/${version}/groups`, app.generalCodeFiles.groups);

console.log(`Deployed ${appName} to ${zone}`);
