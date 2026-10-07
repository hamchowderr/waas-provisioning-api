/**
 * Everything that touches the machines stores run on. The API records state in Postgres and
 * calls this from queue jobs; it never talks to a host directly. Which host runs the stores is
 * not decided yet (docs/hosting.md, waas-api-2hl.4), so the only implementation is the in-memory
 * fake. A host driver implements this interface.
 *
 * Every method must be idempotent: a queue job can run more than once (retries, a worker that
 * looked dead), so calling a method again with the same input must not fail or duplicate work.
 */
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
    source: { snapshotId: string } | { upload: true };
  }): Promise<void>;

  deleteVersion(input: { versionId: string }): Promise<void>;

  // Snapshots: a store's files and database, used to create new stores.

  /** Copies a snapshot so it can be used with another version. */
  copySnapshot(input: { snapshotId: string; newSnapshotId: string; targetVersionId: string }): Promise<void>;

  /** Records the archive a version was built from as a snapshot. */
  snapshotUpload(input: { versionId: string; snapshotId: string }): Promise<void>;

  /** The snapshot as a zip file. */
  downloadSnapshot(input: { snapshotId: string }): Promise<Uint8Array>;

  // Stores (tenants).

  /** Creates a store from a snapshot on a version, with its constants, options and first user. */
  createStore(input: CreateStoreInput): Promise<void>;

  /** Sets the domains a store answers on. The main domain is SiteUrl and Home; the rest redirect to it. */
  setDomains(input: { storeId: string; mainDomain: string; redirectDomains: string[] }): Promise<void>;

  /** Writes wpOptions and phpConstants into a running store. */
  updateStore(input: { storeId: string; wpOptions?: Record<string, string>; phpConstants?: Record<string, PhpConstant> }): Promise<void>;

  /** Moves a store to another version's code. */
  moveStore(input: { storeId: string; targetVersionId: string }): Promise<void>;

  /** Takes a snapshot of a store. */
  snapshotStore(input: { storeId: string; snapshotId: string }): Promise<void>;

  /** Replaces a store's files and database with a snapshot. */
  restoreStore(input: { storeId: string; snapshotId: string }): Promise<void>;

  /** Stops serving a store (it answers 503) while keeping its data and domains; resume undoes it. */
  suspendStore(input: { storeId: string }): Promise<void>;
  resumeStore(input: { storeId: string }): Promise<void>;

  deleteStore(input: { storeId: string }): Promise<void>;
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
