/**
 * Everything that touches the machines stores run on. The API records state in Postgres and
 * calls this from queue jobs; it never talks to a host directly. Which host runs the stores is
 * not decided yet (docs/hosting.md, waas-api-2hl.4), so the only implementation is the in-memory
 * fake. A host driver implements this interface.
 *
 * Every method must be idempotent: a queue job can run more than once (retries, a worker that
 * looked dead), so calling a method again with the same input must not fail or duplicate work.
 */
/** Who the "website unavailable" page credits: the platform, or later a reseller. */
export interface Brand {
  name: string;
  /** http(s) link on the name; others are dropped. */
  url?: string;
}

export interface Provisioner {
  // Versions: the shared WordPress code a set of stores runs on.

  /** An URL the caller PUTs a gzipped tar (or zip) to before the version is built. */
  createUploadUrl(input: { versionId: string; asZip: boolean }): Promise<string>;

  /** Builds a version and serves it on its domain, from a snapshot or from the uploaded archive. */
  buildVersion(input: {
    versionId: string;
    domain: string;
    wordPressVersion: string;
    phpVersion: string;
    source: { snapshotId: string } | { baseSnapshotId: string } | { upload: true };
  }): Promise<void>;

  deleteVersion(input: { versionId: string }): Promise<void>;

  // Snapshots: a store's files and database, used to create new stores.

  /** Copies a snapshot so it can be used with another version. */
  copySnapshot(input: { snapshotId: string; newSnapshotId: string; targetVersionId: string }): Promise<void>;

  /** Copies a base snapshot (template) into a version as one of its snapshots. */
  copyBaseSnapshot(input: { baseSnapshotId: string; newSnapshotId: string; targetVersionId: string }): Promise<void>;

  // Base snapshots (templates) a product uploads.

  /** Where the template archive is PUT, and where it can be read afterwards. */
  createBaseSnapshotUpload(input: { baseSnapshotId: string }): Promise<{ uploadUrl: string; uri: string }>;

  deleteBaseSnapshot(input: { baseSnapshotId: string }): Promise<void>;

  /** Records the archive a version was built from as a snapshot. */
  snapshotUpload(input: { versionId: string; snapshotId: string }): Promise<void>;

  /** The snapshot as a zip file. */
  downloadSnapshot(input: { snapshotId: string }): Promise<Uint8Array>;

  // Stores (tenants).

  /** Creates a store from a snapshot on a version, with its constants, options and first user. */
  createStore(input: CreateStoreInput): Promise<void>;

  /** Sets the domains a store answers on. The main domain is SiteUrl and Home; the rest redirect to it. */
  setDomains(input: { storeId: string; mainDomain: string; redirectDomains: string[] }): Promise<void>;

  /**
   * Writes wpOptions and phpConstants into a running store. wpOptions holds only the options to
   * change; phpConstants, when given, is the store's complete set of constants.
   */
  updateStore(input: { storeId: string; wpOptions?: Record<string, string>; phpConstants?: Record<string, PhpConstant> }): Promise<void>;

  /** Moves a store to another version's code. */
  moveStore(input: { storeId: string; targetVersionId: string }): Promise<void>;

  /** Takes a snapshot of a store. */
  snapshotStore(input: { storeId: string; snapshotId: string }): Promise<void>;

  /** Replaces a store's files and database with a snapshot. */
  restoreStore(input: { storeId: string; snapshotId: string }): Promise<void>;

  /** Takes a full backup (files and database) of a store. Returns its size. */
  backupStore(input: { storeId: string; backupId: string }): Promise<{ sizeBytes: number }>;

  /**
   * Re-creates a deleted store from one of its backups (files and database), on the given version
   * and domains, with the constants and options it had when the backup was taken. Not suspended.
   */
  restoreDeletedStore(input: Omit<CreateStoreInput, 'snapshotId' | 'user'> & { backupId: string }): Promise<void>;

  /** Deletes a backup. Called once a deleted tenant's backups pass their retention. */
  deleteBackup(input: { backupId: string }): Promise<void>;

  /**
   * Stops serving a store while keeping its files, database and domains: every domain answers 503
   * with the shared "website unavailable" page (no redirect), WordPress cron stops, and
   * /wp-json/waas-client/v1/single_login/verify is unreachable. resumeStore undoes it. `brand`
   * names whose platform the page credits; without it the provisioner's default (AnyPress).
   */
  suspendStore(input: { storeId: string; brand?: Brand }): Promise<void>;
  resumeStore(input: { storeId: string }): Promise<void>;

  deleteStore(input: { storeId: string }): Promise<void>;

  /**
   * Makes sure a store's scheduled jobs (WP-cron, Action Scheduler) run on their own, without page
   * traffic. createStore already does this; the API calls it for every live store on startup so
   * stores created before it get it too.
   */
  ensureStoreCron(input: { storeId: string }): Promise<'created' | 'updated' | 'unchanged'>;

  /**
   * Makes sure a store sends email through the platform's mail relay with its current settings.
   * createStore already does this; the API calls it for every live store on startup, so older
   * stores, and every store after the relay's settings change, get it too. With `sender`, the store
   * sends from its own verified domain (src/maildomains.ts) instead of the platform's.
   */
  ensureStoreMail(input: { storeId: string; sender?: StoreSender }): Promise<'created' | 'updated' | 'unchanged'>;
}

/** A store's own sending domain, verified on toSend: it sends from the platform's address name at it. */
export interface StoreSender {
  domain: string;
  /** toSend's id for the domain; the store's key is restricted to it. */
  domainId: string;
}

export interface PhpConstant {
  value: string;
  isPrivate?: boolean;
}

export interface CreateStoreInput {
  storeId: string;
  versionId: string;
  snapshotId: string;
  mainDomain: string;
  redirectDomains: string[];
  /** Written as define() in wp-config, next to WPCS_IS_TENANT=true in the environment. */
  phpConstants: Record<string, PhpConstant>;
  wpOptions: Record<string, string>;
  user?: { name: string; email: string; role: string; password?: string };
}
