import type { CreateStoreInput, PhpConstant, Provisioner, StoreSender } from './provisioner.ts';

interface FakeStore extends CreateStoreInput {
  suspended: boolean;
}

/**
 * Keeps everything in memory and succeeds at once. For local runs and tests until a host
 * driver exists. `failNext(method)` makes the next call to that method throw, to exercise the
 * Failed status.
 */
export class FakeProvisioner implements Provisioner {
  readonly versions = new Map<string, { domain: string; wordPressVersion: string; phpVersion: string }>();
  readonly snapshots = new Map<string, { versionId: string; sourceSnapshotId?: string }>();
  readonly stores = new Map<string, FakeStore>();
  readonly backups = new Map<string, { storeId: string; sizeBytes: number }>();
  private failures = new Map<keyof Provisioner, number>();

  failNext(method: keyof Provisioner, times = 1): void {
    this.failures.set(method, times);
  }

  private check(method: keyof Provisioner): void {
    const left = this.failures.get(method) ?? 0;
    if (left > 0) {
      this.failures.set(method, left - 1);
      throw new Error(`FakeProvisioner: ${method} failed (injected)`);
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
  }

  async deleteVersion({ versionId }: { versionId: string }) {
    this.check('deleteVersion');
    this.versions.delete(versionId);
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
    this.stores.set(input.storeId, { ...input, suspended: false });
  }

  async setDomains({ storeId, mainDomain, redirectDomains }: Parameters<Provisioner['setDomains']>[0]) {
    this.check('setDomains');
    Object.assign(this.store(storeId), { mainDomain, redirectDomains });
  }

  async updateStore({ storeId, wpOptions, phpConstants }: { storeId: string; wpOptions?: Record<string, string>; phpConstants?: Record<string, PhpConstant> }) {
    this.check('updateStore');
    const store = this.store(storeId);
    Object.assign(store.wpOptions, wpOptions);
    Object.assign(store.phpConstants, phpConstants);
  }

  async moveStore({ storeId, targetVersionId }: { storeId: string; targetVersionId: string }) {
    this.check('moveStore');
    this.store(storeId).versionId = targetVersionId;
  }

  async snapshotStore({ storeId, snapshotId }: { storeId: string; snapshotId: string }) {
    this.check('snapshotStore');
    this.snapshots.set(snapshotId, { versionId: this.store(storeId).versionId });
  }

  async restoreStore({ storeId, snapshotId }: { storeId: string; snapshotId: string }) {
    this.check('restoreStore');
    this.store(storeId).snapshotId = snapshotId;
  }

  async backupStore({ storeId, backupId }: { storeId: string; backupId: string }) {
    this.check('backupStore');
    this.store(storeId);
    const sizeBytes = 1024 * 1024;
    this.backups.set(backupId, { storeId, sizeBytes });
    return { sizeBytes };
  }

  async restoreDeletedStore(input: Parameters<Provisioner['restoreDeletedStore']>[0]) {
    this.check('restoreDeletedStore');
    const backup = this.backups.get(input.backupId);
    if (!backup || backup.storeId !== input.storeId) throw new Error(`FakeProvisioner: no backup ${input.backupId} of ${input.storeId}`);
    const { backupId, ...store } = input;
    this.stores.set(input.storeId, { ...store, snapshotId: backupId, suspended: false });
  }

  async deleteBackup({ backupId }: { backupId: string }) {
    this.check('deleteBackup');
    this.backups.delete(backupId);
  }

  async suspendStore({ storeId }: { storeId: string }) {
    this.check('suspendStore');
    this.store(storeId).suspended = true;
  }

  async resumeStore({ storeId }: { storeId: string }) {
    this.check('resumeStore');
    this.store(storeId).suspended = false;
  }

  async deleteStore({ storeId }: { storeId: string }) {
    this.check('deleteStore');
    this.stores.delete(storeId);
  }

  async ensureStoreCron(_input: { storeId: string }): Promise<'created' | 'updated' | 'unchanged'> {
    this.check('ensureStoreCron');
    return 'unchanged';
  }

  async ensureStoreMail(_input: { storeId: string; sender?: StoreSender }): Promise<'created' | 'updated' | 'unchanged'> {
    this.check('ensureStoreMail');
    return 'unchanged';
  }
}
