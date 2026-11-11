import type { Size } from '../plans.ts';
import type { OutreachMailbox } from '../outreach.ts';
import type { OutreachAutomation } from '../outreachautomation.ts';
import type { CrmContact } from '../prospectcrm.ts';
import { ImportPartsError, storeFromAddress, type Brand, type CreateStoreInput, type MoveReport, type PhpConstant, type Provisioner, type RestoreTestResult, type SiteCheck, type StoreMailFrom, type VersionPlugin } from './provisioner.ts';

interface FakeStore extends CreateStoreInput {
  suspended: boolean;
  /** Held until goLive: a site moved in, or a held store restored. */
  held?: boolean;
  /** The brand its "unavailable" page was given when suspended; none is the platform's. */
  suspendedBrand?: Brand;
  /** The pack emails the store was told it has bought (setEmailPacks). */
  emailPacks?: number;
  /** The storage its packs add, in GB, as the store was told (setStoragePacks). */
  storagePacksGb?: number;
  /** The address it sends from (ensureStoreMail, setDomains with `mail`), when stores send email. */
  mailFrom?: string;
  /** This month's count the platform told it (setMailCount). */
  mailCount?: { month: string; sent: number };
  /** Plugin versions installed by updatePlugin, by slug. */
  plugins?: Record<string, string>;
  /** FluentCRM contacts written by addCrmProspects, by email. */
  crm?: Record<string, CrmContact>;
  /** The seller's mailbox for prospect emails (setOutreachMailbox). */
  outreachMailbox?: OutreachMailbox;
  /** Draft FluentCRM automations made by addOutreachAutomation, by title. */
  automations?: Record<string, OutreachAutomation & { id: number }>;
}

/**
 * Keeps everything in memory and succeeds at once. For local runs and tests until a host
 * driver exists. `failNext(method)` makes the next call to that method throw, to exercise the
 * Failed status.
 */
export class FakeProvisioner implements Provisioner {
  readonly versions = new Map<string, { domain: string; wordPressVersion: string; phpVersion: string; plugins?: VersionPlugin[] }>();
  readonly snapshots = new Map<string, { versionId: string; sourceSnapshotId?: string }>();
  readonly stores = new Map<string, FakeStore>();
  readonly backups = new Map<string, { storeId: string; sizeBytes: number }>();
  /** Uploaded archives of sites being moved in, by store: their size. Tests "upload" by setting one. */
  readonly imports = new Map<string, number>();
  /** Every store whose plugins and themes were replaced with its version's code, in order. */
  readonly codeReplaced: string[] = [];
  /** What the check after a move answers (createStore of a site moved in). */
  importCheck: SiteCheck = { ok: true, home: 200, login: 200, loaded: true, fatal: null };
  /** What the agent's restore reports about a move (rows short, the export's notes); none by default. */
  importMoved: MoveReport | undefined;
  /** Every restore test run (testRestore), in order. */
  readonly restoreTests: { testId: string; backupId: string }[] = [];
  /** The platform's STORE_MAIL_FROM, as if stores sent email. Unset: they send none, as without a relay. */
  platformMailFrom?: string;
  private failures = new Map<keyof Provisioner, { left: number; message?: string }>();

  /** Makes the next `times` calls of `method` throw, with `message` when given (as a store agent's error would read). */
  failNext(method: keyof Provisioner, times = 1, message?: string): void {
    this.failures.set(method, { left: times, message });
  }

  private check(method: keyof Provisioner): void {
    const failure = this.failures.get(method);
    if (failure && failure.left > 0) {
      failure.left--;
      throw new Error(failure.message ?? `FakeProvisioner: ${method} failed (injected)`);
    }
  }

  private store(storeId: string): FakeStore {
    const store = this.stores.get(storeId);
    if (!store) throw new Error(`FakeProvisioner: no store ${storeId}`);
    return store;
  }

  async createUploadUrl({ versionId, asZip }: { versionId: string; asZip: boolean }) {
    this.check('createUploadUrl');
    return `https://uploads.waas.example/${versionId}.${asZip ? 'zip' : 'tgz'}`;
  }

  async buildVersion(input: Parameters<Provisioner['buildVersion']>[0]) {
    this.check('buildVersion');
    this.versions.set(input.versionId, input);
    const pluginFiles: Record<string, string> = {};
    for (const p of input.plugins ?? []) {
      if (p.action !== 'add') continue;
      if (p.uploadId ? !this.pluginUploads.has(p.uploadId) : !this.pluginPackages.has(`${p.slug}@${p.version}`)) {
        throw new Error(`FakeProvisioner: no package for ${p.slug} ${p.version}`);
      }
      pluginFiles[p.slug] = `${p.slug}/${p.slug}.php`;
    }
    return { pluginFiles };
  }

  /** Stored plugin zips, by "slug@version": their size. */
  readonly pluginPackages = new Map<string, number>();

  async storePluginPackage({ slug, version, body }: { slug: string; version: string; body: Uint8Array }) {
    this.check('storePluginPackage');
    this.pluginPackages.set(`${slug}@${version}`, body.length);
  }

  /** Uploaded plugin zips by upload id. Tests "upload" by setting one. */
  readonly pluginUploads = new Map<string, Uint8Array>();

  async createPluginUpload({ uploadId }: { uploadId: string }) {
    this.check('createPluginUpload');
    return { uploadUrl: `https://uploads.waas.example/plugins/${uploadId}.zip` };
  }

  async readPluginUpload({ uploadId, maxBytes }: { uploadId: string; maxBytes: number }) {
    this.check('readPluginUpload');
    const zip = this.pluginUploads.get(uploadId);
    if (zip && zip.length > maxBytes) throw new Error(`The upload is larger than ${maxBytes} bytes`);
    return zip ?? null;
  }

  async deletePluginUpload({ uploadId }: { uploadId: string }) {
    this.check('deletePluginUpload');
    this.pluginUploads.delete(uploadId);
  }

  /** Demo draft photos: "<draftId>/<name>" -> size. Tests "upload" one with uploadDemoImage. */
  readonly demoImages = new Map<string, number>();

  uploadDemoImage(draftId: string, name: string, bytes: number) {
    this.demoImages.set(`${draftId}/${name}`, bytes);
  }

  async createDemoImageUpload({ draftId, name }: { draftId: string; name: string; expiresInSeconds: number }) {
    this.check('createDemoImageUpload');
    return `https://uploads.waas.example/demos/${draftId}/${name}?put`;
  }

  async demoImageSize({ draftId, name }: { draftId: string; name: string }) {
    return this.demoImages.get(`${draftId}/${name}`) ?? null;
  }

  async demoImageUrl({ draftId, name }: { draftId: string; name: string; expiresInSeconds: number }) {
    return `https://uploads.waas.example/demos/${draftId}/${name}?get`;
  }

  async deleteDemoDraft({ draftId, names }: { draftId: string; names: string[] }) {
    for (const name of names) this.demoImages.delete(`${draftId}/${name}`);
  }

  async deleteVersion({ versionId }: { versionId: string }) {
    this.check('deleteVersion');
    this.versions.delete(versionId);
  }

  /** Each version's roles.json, as a test sets it. */
  readonly versionRoles = new Map<string, unknown>();

  async readVersionRoles({ versionId }: { versionId: string }) {
    this.check('readVersionRoles');
    return this.versionRoles.get(versionId) ?? null;
  }

  async stopVersion(_input: { versionId: string }) {
    this.check('stopVersion');
  }

  async copySnapshot({ snapshotId, newSnapshotId, targetVersionId }: Parameters<Provisioner['copySnapshot']>[0]) {
    this.check('copySnapshot');
    this.snapshots.set(newSnapshotId, { versionId: targetVersionId, sourceSnapshotId: snapshotId });
  }

  readonly baseSnapshots = new Set<string>();

  async copyBaseSnapshot({ baseSnapshotId, newSnapshotId, targetVersionId }: Parameters<Provisioner['copyBaseSnapshot']>[0]) {
    this.check('copyBaseSnapshot');
    if (!this.baseSnapshots.has(baseSnapshotId)) throw new Error(`FakeProvisioner: no base snapshot ${baseSnapshotId}`);
    this.snapshots.set(newSnapshotId, { versionId: targetVersionId, sourceSnapshotId: baseSnapshotId });
  }

  async createBaseSnapshotUpload({ baseSnapshotId }: { baseSnapshotId: string }) {
    this.check('createBaseSnapshotUpload');
    // The fake treats the template as uploaded at once.
    this.baseSnapshots.add(baseSnapshotId);
    return { uploadUrl: `https://uploads.waas.example/base/${baseSnapshotId}.tgz`, uri: `https://templates.waas.example/${baseSnapshotId}.tgz` };
  }

  async putBaseSnapshot({ baseSnapshotId }: { baseSnapshotId: string; body: Uint8Array }) {
    this.check('putBaseSnapshot');
    this.baseSnapshots.add(baseSnapshotId);
  }

  async deleteBaseSnapshot({ baseSnapshotId }: { baseSnapshotId: string }) {
    this.check('deleteBaseSnapshot');
    this.baseSnapshots.delete(baseSnapshotId);
  }

  async snapshotUpload({ versionId, snapshotId }: { versionId: string; snapshotId: string }) {
    this.check('snapshotUpload');
    this.snapshots.set(snapshotId, { versionId });
  }

  async downloadSnapshot({ snapshotId }: { snapshotId: string }) {
    this.check('downloadSnapshot');
    // An empty zip archive (end-of-central-directory record only), tagged with the id in its comment.
    const comment = Buffer.from(snapshotId);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(comment.length, 20);
    return new Uint8Array(Buffer.concat([eocd, comment]));
  }

  async createStore(input: CreateStoreInput) {
    this.check('createStore');
    if (input.snapshotId === null && !input.reprint && !this.imports.has(input.storeId)) throw new Error(`FakeProvisioner: no import uploaded for ${input.storeId}`);
    const imported = input.snapshotId === null;
    this.stores.set(input.storeId, {
      ...input,
      // A site moved in comes with its own options (createStore writes none over them).
      wpOptions: imported ? {} : input.wpOptions,
      suspended: false,
      held: imported || !!input.hold,
      mailFrom: this.mailFrom({ mailbox: input.mailbox }) ?? undefined,
    });
    if (!input.ownCode) this.codeReplaced.push(input.storeId);
    return imported ? { check: { ...this.importCheck }, ...(this.importMoved && { moved: this.importMoved }) } : undefined;
  }

  async setDomains({ storeId, mainDomain, redirectDomains, mail }: Parameters<Provisioner['setDomains']>[0]) {
    this.check('setDomains');
    const store = this.store(storeId);
    Object.assign(store, { mainDomain, redirectDomains });
    if (mail) store.mailFrom = this.mailFrom(mail) ?? undefined;
  }

  async updateStore({ storeId, wpOptions, phpConstants, size }: { storeId: string; wpOptions?: Record<string, string>; phpConstants?: Record<string, PhpConstant>; size?: Size }) {
    this.check('updateStore');
    const store = this.store(storeId);
    Object.assign(store.wpOptions, wpOptions);
    Object.assign(store.phpConstants, phpConstants);
    if (size) store.size = size;
  }

  async setEmailPacks({ storeId, purchased }: { storeId: string; purchased: number }) {
    this.check('setEmailPacks');
    this.store(storeId).emailPacks = purchased;
  }

  async setStoragePacks({ storeId, gb }: { storeId: string; gb: number }) {
    this.check('setStoragePacks');
    this.store(storeId).storagePacksGb = gb;
  }

  async setMailCount({ storeId, month, sent }: { storeId: string; month: string; sent: number }) {
    this.check('setMailCount');
    this.store(storeId).mailCount = { month, sent };
  }

  async moveStore({ storeId, targetVersionId, ownCode }: Parameters<Provisioner['moveStore']>[0]) {
    this.check('moveStore');
    this.store(storeId).versionId = targetVersionId;
    if (!ownCode) this.codeReplaced.push(storeId);
  }

  async snapshotStore({ storeId, snapshotId }: { storeId: string; snapshotId: string }) {
    this.check('snapshotStore');
    this.snapshots.set(snapshotId, { versionId: this.store(storeId).versionId });
  }

  async restoreStore({ storeId, snapshotId, ownCode }: Parameters<Provisioner['restoreStore']>[0]) {
    this.check('restoreStore');
    this.store(storeId).snapshotId = snapshotId;
    if (!ownCode) this.codeReplaced.push(storeId);
  }

  async backupStore({ storeId, backupId }: { storeId: string; backupId: string }) {
    this.check('backupStore');
    this.store(storeId);
    const sizeBytes = 1024 * 1024;
    this.backups.set(backupId, { storeId, sizeBytes });
    return { sizeBytes };
  }

  /** Site downloads: download id -> store id. */
  readonly downloads = new Map<string, string>();

  async downloadStore({ storeId, downloadId }: { storeId: string; downloadId: string }) {
    this.check('downloadStore');
    this.store(storeId);
    this.downloads.set(downloadId, storeId);
    return { sizeBytes: 3 * 1024 * 1024 };
  }

  async downloadUrl({ downloadId, fileName }: { downloadId: string; fileName: string; expiresInSeconds: number }) {
    return `https://uploads.waas.example/downloads/${downloadId}.zip?get&name=${encodeURIComponent(fileName)}`;
  }

  async deleteDownload({ downloadId }: { downloadId: string }) {
    this.downloads.delete(downloadId);
  }

  async restoreDeletedStore(input: Parameters<Provisioner['restoreDeletedStore']>[0]) {
    this.check('restoreDeletedStore');
    const backup = this.backups.get(input.backupId);
    if (!backup || backup.storeId !== input.storeId) throw new Error(`FakeProvisioner: no backup ${input.backupId} of ${input.storeId}`);
    const { backupId, ...store } = input;
    this.stores.set(input.storeId, { ...store, snapshotId: backupId, suspended: false, held: !!input.hold, mailFrom: this.mailFrom({ mailbox: input.mailbox }) ?? undefined });
    if (!input.ownCode) this.codeReplaced.push(input.storeId);
  }

  async rollbackStore({ storeId, backupId, wpOptions, ownCode }: Parameters<Provisioner['rollbackStore']>[0]) {
    this.check('rollbackStore');
    const store = this.store(storeId);
    const backup = this.backups.get(backupId);
    if (!backup || backup.storeId !== storeId) throw new Error(`FakeProvisioner: no backup ${backupId} of ${storeId}`);
    store.snapshotId = backupId;
    Object.assign(store.wpOptions, wpOptions);
    if (!ownCode) this.codeReplaced.push(storeId);
  }

  async createImportUpload({ storeId }: { storeId: string; expiresInSeconds: number }) {
    this.check('createImportUpload');
    return `https://uploads.waas.example/imports/${storeId}`;
  }

  /** Multipart uploads of moved-in sites: id -> store and the parts' sizes. Tests "upload" a part with uploadPart. */
  readonly importUploads = new Map<string, { storeId: string; parts: Map<number, number> }>();

  uploadPart(uploadId: string, number: number, bytes: number) {
    this.importUploads.get(uploadId)!.parts.set(number, bytes);
  }

  async startImportParts({ storeId }: { storeId: string }) {
    this.check('startImportParts');
    const id = `upload-${this.importUploads.size + 1}`;
    this.importUploads.set(id, { storeId, parts: new Map() });
    return id;
  }

  async importPartUrls({ storeId, uploadId, parts }: { storeId: string; uploadId: string; parts: number[]; expiresInSeconds: number }) {
    this.check('importPartUrls');
    return Object.fromEntries(parts.map((n) => [n, `https://uploads.waas.example/imports/${storeId}?partNumber=${n}&uploadId=${uploadId}`]));
  }

  async importParts({ storeId, uploadId }: { storeId: string; uploadId: string }) {
    this.check('importParts');
    const upload = this.importUploads.get(uploadId);
    if (!upload || upload.storeId !== storeId) return null;
    return [...upload.parts].sort(([a], [b]) => a - b).map(([number, size]) => ({ number, size }));
  }

  async finishImportParts({ storeId, uploadId }: { storeId: string; uploadId: string }) {
    this.check('finishImportParts');
    const parts = await this.importParts({ storeId, uploadId });
    if (!parts) throw new ImportPartsError('This upload is no longer known. Upload the export again.');
    if (parts.length === 0 || parts.some((p, i) => p.number !== i + 1)) throw new ImportPartsError('Some parts of the export are missing. Upload them, then finish.');
    this.imports.set(storeId, parts.reduce((sum, p) => sum + p.size, 0));
    this.importUploads.delete(uploadId);
  }

  async importSize({ storeId }: { storeId: string }) {
    this.check('importSize');
    return this.imports.get(storeId) ?? null;
  }

  async deleteImport({ storeId }: { storeId: string }) {
    this.check('deleteImport');
    this.imports.delete(storeId);
  }

  async deleteBackup({ backupId }: { backupId: string }) {
    this.check('deleteBackup');
    this.backups.delete(backupId);
  }

  async suspendStore({ storeId, brand }: { storeId: string; brand?: Brand }) {
    this.check('suspendStore');
    const store = this.store(storeId);
    store.suspended = true;
    store.suspendedBrand = brand;
  }

  async resumeStore({ storeId }: { storeId: string }) {
    this.check('resumeStore');
    this.store(storeId).suspended = false;
  }

  async goLive({ storeId }: { storeId: string }) {
    this.check('goLive');
    this.store(storeId).held = false;
  }

  async updatePlugin({ storeId, slug, version, replaces = [] }: Parameters<Provisioner['updatePlugin']>[0]) {
    this.check('updatePlugin');
    const store = this.store(storeId);
    const plugins = (store.plugins ??= {});
    const from = plugins[slug] ?? replaces.map((old) => plugins[old]).find(Boolean) ?? null;
    const unchanged = plugins[slug] === version && !replaces.some((old) => old in plugins);
    for (const old of replaces) delete plugins[old];
    plugins[slug] = version;
    return { from, unchanged };
  }

  async passwordLink({ storeId, email }: { storeId: string; email: string }) {
    this.check('passwordLink');
    const store = this.store(storeId);
    if (store.user?.email !== email) throw new Error(`FakeProvisioner: store ${storeId} has no user ${email}`);
    return `https://${store.mainDomain}/wp-login.php?action=rp&key=fake-key&login=${encodeURIComponent(store.user.name)}`;
  }

  async addCrmProspects({ storeId, contacts }: Parameters<Provisioner['addCrmProspects']>[0]) {
    this.check('addCrmProspects');
    const store = this.store(storeId);
    const crm = (store.crm ??= {});
    let added = 0;
    let updated = 0;
    for (const c of contacts) {
      if (crm[c.email]) updated++;
      else added++;
      crm[c.email] = { ...c, tags: [...new Set([...(crm[c.email]?.tags ?? []), ...c.tags])] };
    }
    return { added, updated, failed: {} };
  }

  /** Mail servers whose sign-in the fake refuses, as a real store's check would. */
  readonly refusedMailHosts = new Set<string>();

  async setOutreachMailbox({ storeId, mailbox }: Parameters<Provisioner['setOutreachMailbox']>[0]) {
    this.check('setOutreachMailbox');
    const store = this.store(storeId);
    if (!mailbox) {
      delete store.outreachMailbox;
      return { ok: true };
    }
    if (this.refusedMailHosts.has(mailbox.host)) return { ok: false, error: '535 5.7.8 Username and Password not accepted' };
    store.outreachMailbox = mailbox;
    return { ok: true };
  }

  async addOutreachAutomation({ storeId, automation }: Parameters<Provisioner['addOutreachAutomation']>[0]) {
    this.check('addOutreachAutomation');
    const store = this.store(storeId);
    const made = (store.automations ??= {});
    const found = made[automation.title];
    if (found) return { id: found.id, created: false };
    const id = Object.keys(made).length + 1;
    made[automation.title] = { ...automation, id };
    return { id, created: true };
  }

  async deleteStore({ storeId }: { storeId: string }) {
    this.check('deleteStore');
    this.stores.delete(storeId);
  }

  async testRestore({ testId, backupId }: Parameters<Provisioner['testRestore']>[0]): Promise<RestoreTestResult> {
    this.check('testRestore');
    this.restoreTests.push({ testId, backupId });
    const backup = this.backups.get(backupId);
    if (!backup) throw new Error(`FakeProvisioner: no backup ${backupId}`);
    const store = this.stores.get(backup.storeId);
    return { name: store?.wpOptions.blogname ?? null, home: `https://restore-test-${testId}.invalid`, tables: 12, posts: 3 };
  }

  async deleteRestoreTest(_input: { testId: string }) {
    this.check('deleteRestoreTest');
  }

  async ensureStoreSetup({ storeId, size }: { storeId: string; size: Size }): Promise<'updated' | 'unchanged'> {
    this.check('ensureStoreSetup');
    const store = this.stores.get(storeId);
    if (!store || store.size === size) return 'unchanged';
    store.size = size;
    return 'updated';
  }

  async ensureStoreCron(_input: { storeId: string }): Promise<'created' | 'updated' | 'unchanged'> {
    this.check('ensureStoreCron');
    return 'unchanged';
  }

  async ensureStoreMail({ storeId, ...from }: { storeId: string } & StoreMailFrom): Promise<'created' | 'updated' | 'unchanged'> {
    this.check('ensureStoreMail');
    const address = this.mailFrom(from);
    const store = this.stores.get(storeId);
    if (!address || !store || store.mailFrom === address) return 'unchanged';
    store.mailFrom = address;
    return 'updated';
  }

  mailFrom(from: StoreMailFrom): string | null {
    return this.platformMailFrom ? storeFromAddress(this.platformMailFrom, from) : null;
  }
}
