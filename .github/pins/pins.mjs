#!/usr/bin/env node
// Keeps every pinned version in a repository on the newest release. The repository lists its pins in
// .github/pins.json (format: .github/pins/README.md).
//
//   node pins.mjs check    # lists each pin and its newest release; fails when a pin is behind one of our own releases
//   node pins.mjs update   # moves every pin (version, checksum, downloaded file) to the newest release
//
// GitHub releases are read with the GitHub CLI (`gh`, GitHub's official command line tool, preinstalled on Actions
// runners). wordpress.org has no official client library, so its public plugin and core version APIs are read with
// fetch.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const OWN = /^github:hamchowderr\//;
const mode = process.argv[2];
if (mode !== 'check' && mode !== 'update') {
  console.error('usage: pins.mjs check|update [repository root]');
  process.exit(2);
}
const root = resolve(process.argv[3] ?? '.');
const config = JSON.parse(readFileSync(resolve(root, '.github/pins.json'), 'utf8'));

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function http(url, as = 'json') {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      return as === 'json' ? await res.json() : Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const semver = (v) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
function newer(a, b) {
  const x = semver(a);
  const y = semver(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (x[i] === undefined) return typeof y[i] === 'number' ? -1 : 1; // 1.0.0 is newer than 1.0.0-beta.1
    if (y[i] === undefined) return typeof x[i] === 'number' ? 1 : -1;
    return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

/** The newest release of a pin's source: { version, tag, asset(): Promise<Buffer>, sha(): Promise<string> }. */
async function latest(pin) {
  const [kind, name] = [pin.source.slice(0, pin.source.indexOf(':')), pin.source.slice(pin.source.indexOf(':') + 1)];
  if (kind === 'github') {
    const prefix = pin.tagPrefix ?? 'v';
    const releases = JSON.parse(gh('api', `repos/${name}/releases?per_page=100`, '--jq', '[.[] | select(.draft | not) | {tag_name, prerelease}]'));
    const versions = releases
      .filter((r) => r.tag_name.startsWith(prefix) && (pin.prerelease || !r.prerelease))
      .map((r) => r.tag_name.slice(prefix.length))
      .filter((v) => /^\d+\.\d+\.\d+/.test(v))
      .sort(newer);
    const version = versions.at(-1);
    if (!version) throw new Error(`${pin.source} has no release tagged ${prefix}<version>`);
    const tag = prefix + version;
    const assets = () => JSON.parse(gh('api', `repos/${name}/releases/tags/${tag}`, '--jq', '[.assets[] | {id, name}]'));
    const download = (file) => {
      const found = assets().find((a) => a.name === file);
      if (!found) throw new Error(`${name} ${tag} has no ${file}`);
      return execFileSync('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${name}/releases/assets/${found.id}`], { maxBuffer: 256 * 1024 * 1024 });
    };
    const asset = async () => download(pin.asset);
    // The checksum the release itself published (its SHA256SUMS), checked against the zip.
    const sha = async () => {
      const own = sha256(await asset());
      const sums = assets().some((a) => a.name === 'SHA256SUMS') ? download('SHA256SUMS').toString() : '';
      const listed = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, f]) => f?.replace(/^\*/, '').split('/').pop() === pin.asset)?.[0];
      if (listed && listed !== own) throw new Error(`${name} ${tag}: ${pin.asset} does not match its SHA256SUMS`);
      return own;
    };
    return { version, tag, asset, sha };
  }
  if (kind === 'wordpress-plugin') {
    const info = await http(`https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=${name}&request%5Bfields%5D%5Bsections%5D=0`);
    if (!info.version) throw new Error(`wordpress.org has no plugin ${name}`);
    const asset = () => http(`https://downloads.wordpress.org/plugin/${name}.${info.version}.zip`, 'bytes');
    return { version: info.version, tag: info.version, asset, sha: async () => sha256(await asset()) };
  }
  if (kind === 'wordpress-core') {
    const offers = (await http('https://api.wordpress.org/core/version-check/1.7/')).offers;
    const version = offers.map((o) => o.version).filter((v) => !pin.line || v === pin.line || v.startsWith(`${pin.line}.`)).sort(newer).at(-1);
    const asset = () => http(`https://wordpress.org/wordpress-${version}.zip`, 'bytes');
    return { version, tag: version, asset, sha: async () => sha256(await asset()) };
  }
  throw new Error(`unknown pin source ${pin.source}`);
}

/** Every place a pin is written: { file, re, text, matches: [{ version, sha, index }] }. */
function places(pin) {
  return pin.places.map(({ file, match }) => {
    const path = resolve(root, file);
    const text = readFileSync(path, 'utf8');
    const re = new RegExp(match, 'gm');
    const matches = [...text.matchAll(re)].map((m) => ({ version: m.groups.version, sha: m.groups?.sha }));
    if (!matches.length) throw new Error(`${pin.name}: ${file} has nothing matching ${match}`);
    return { file, path, re, text, matches };
  });
}

let behindOwn = 0;
let changed = 0;
const summary = [];
for (const pin of config.pins) {
  const found = places(pin);
  const current = [...new Set(found.flatMap((p) => p.matches.map((m) => m.version)))];
  const next = await latest(pin);
  const stale = current.filter((v) => newer(v, next.version) < 0);
  const own = OWN.test(pin.source);
  const line = `${pin.name}: ${current.join(', ')} -> newest ${next.version}`;
  if (!stale.length) {
    console.log(`ok     ${line}`);
    continue;
  }
  summary.push(`- ${pin.name}: ${current.join(', ')} to ${next.version}`);
  if (mode === 'check') {
    if (own) behindOwn++;
    console.log(`${own ? '::error::' : '::warning::'}${line}`);
    continue;
  }
  console.log(`update ${line}`);
  const needsSha = found.some((p) => p.matches.some((m) => m.sha !== undefined));
  const sha = needsSha ? await next.sha() : undefined;
  for (const p of found) {
    // Replace only the named groups, from the end so earlier offsets stay right.
    const spans = [...p.text.matchAll(new RegExp(p.re.source, 'gmd'))].flatMap((m) => [
      [...m.indices.groups.version, next.version],
      ...(m.indices.groups.sha ? [[...m.indices.groups.sha, sha]] : []),
    ]);
    let out = p.text;
    for (const [start, end, value] of spans.sort((a, b) => b[0] - a[0])) out = out.slice(0, start) + value + out.slice(end);
    if (out !== p.text) writeFileSync(p.path, out);
  }
  if (pin.download) {
    const target = resolve(root, pin.download);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, await next.asset());
  }
  for (const cmd of pin.run ?? []) execFileSync('bash', ['-c', cmd], { cwd: root, stdio: 'inherit', env: { ...process.env, PIN_VERSION: next.version, PIN_TAG: next.tag } });
  changed++;
}

if (process.env.GITHUB_OUTPUT && summary.length) {
  writeFileSync(process.env.GITHUB_OUTPUT, `summary<<PINS_EOF\n${summary.join('\n')}\nPINS_EOF\n`, { flag: 'a' });
}
if (mode === 'check' && behindOwn) {
  console.log(`\n${behindOwn} pin(s) are behind an AnyPress release. The Update pins workflow moves them within the hour, or run: node pins.mjs update`);
  process.exit(1);
}
if (mode === 'update') console.log(changed ? `${changed} pin(s) moved` : 'Every pin is on the newest release');
