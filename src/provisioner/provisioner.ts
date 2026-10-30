import type { Size } from '../plans.ts';
import type { SiteInventory } from '../sitereport.ts';

/**
 * Everything that touches the machines stores run on. The API records state in Postgres and
 * calls this from queue jobs; it never talks to a host directly. Two implementations: the in-memory
 * fake and Coolify (docs/coolify.md). A driver for another host implements this interface.
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

/**
 * A plugin choice applied while a version builds (docs/plugin-choices.md): a wordpress.org plugin added
 * (its zip as stored with storePluginPackage) or one switched off, for some or all of the site types in
 * the version's roles.json.
 */
export interface VersionPlugin {
  slug: string;
  action: 'add' | 'off';
  version?: string;
  sha256?: string;
  /** roles.json keys; empty: all. */
  siteTypes: string[];
  /** An added plugin from a seller's upload (storePluginPackage keeps wordpress.org ones). */
  uploadId?: string;
  /** Licence constants its stores define, e.g. a premium plugin's licence key. */
  constants?: Record<string, string>;
}

export interface Provisioner {
  // Versions: the shared WordPress code a set of stores runs on.

  /** An URL the caller PUTs a gzipped tar (or zip) to before the version is built. */
  createUploadUrl(input: { versionId: string; asZip: boolean }): Promise<string>;

  /**
   * Builds a version and serves it on its domain, from a snapshot or from the uploaded archive, with its
   * plugin choices applied to its code. Returns the plugin file (as in active_plugins) of each added plugin.
   */
  buildVersion(input: {
    versionId: string;
    domain: string;
    wordPressVersion: string;
    phpVersion: string;
    source: { snapshotId: string } | { baseSnapshotId: string } | { upload: true };
    plugins?: VersionPlugin[];
  }): Promise<{ pluginFiles: Record<string, string> }>;

  /** Keeps a wordpress.org plugin's zip for versions to install; the same slug and version is the same zip. */
  storePluginPackage(input: { slug: string; version: string; body: Uint8Array }): Promise<void>;

  /** Where a seller PUTs a plugin zip they upload (a premium plugin), for an hour. */
  createPluginUpload(input: { uploadId: string }): Promise<{ uploadUrl: string }>;

  /** The uploaded zip, or null when nothing was uploaded; larger than maxBytes is refused with an error. */
  readPluginUpload(input: { uploadId: string; maxBytes: number }): Promise<Uint8Array | null>;

  deletePluginUpload(input: { uploadId: string }): Promise<void>;

  deleteVersion(input: { versionId: string }): Promise<void>;

  /**
   * Stops a built version's site to free the server. Stores are built from the version's saved code,
   * not from its site, and building the version again starts the site again.
   */
  stopVersion(input: { versionId: string }): Promise<void>;

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

  /**
   * Creates a store from a snapshot on a version, with its constants, options and first user. A site moved in
   * (snapshotId null) is built from its upload, held until it goes live (goLive), and then checked: the answer
   * says whether it serves with its plugins loaded.
   */
  createStore(input: CreateStoreInput): Promise<{ check?: SiteCheck } | void>;

  /**
   * Sets the domains a store answers on. The main domain is SiteUrl and Home; the rest redirect to it.
   * `mail`, when given, is who the store's email is from afterwards (its mailbox follows its main
   * domain), applied as ensureStoreMail would but with the same restart.
   */
  setDomains(input: { storeId: string; mainDomain: string; redirectDomains: string[]; mail?: StoreMailFrom }): Promise<void>;

  /**
   * Writes wpOptions and phpConstants into a running store. wpOptions holds only the options to
   * change; phpConstants, when given, is the store's complete set of constants. `size`, when given,
   * moves the store to that size (its resources and quotas), restarting it.
   */
  updateStore(input: { storeId: string; wpOptions?: Record<string, string>; phpConstants?: Record<string, PhpConstant>; size?: Size }): Promise<void>;

  /**
   * Tells a store the total of the email packs bought for it (`purchased`, in emails), on top of its plan's monthly
   * emails. The store keeps its own count of the pack emails it has used; packs never expire.
   */
  setEmailPacks(input: { storeId: string; purchased: number }): Promise<void>;

  /**
   * Tells a store how many emails it sent in `month` (UTC, YYYY-MM) as the platform counted them on the relay
   * (src/mailcount.ts). The store keeps its own count too and goes by the higher of the two.
   */
  setMailCount(input: { storeId: string; month: string; sent: number }): Promise<void>;

  /**
   * Moves a store to another version: its WordPress and PHP, and its code unless the store keeps its
   * own (`ownCode`, a site moved in from another host).
   */
  moveStore(input: { storeId: string; targetVersionId: string; ownCode?: boolean }): Promise<void>;

  /** Takes a snapshot of a store. */
  snapshotStore(input: { storeId: string; snapshotId: string }): Promise<void>;

  /** Replaces a store's files and database with a snapshot. */
  restoreStore(input: { storeId: string; snapshotId: string; ownCode?: boolean }): Promise<void>;

  /** Takes a full backup (files and database) of a store. Returns its size. */
  backupStore(input: { storeId: string; backupId: string }): Promise<{ sizeBytes: number }>;

  /**
   * Re-creates a deleted store from one of its backups (files and database), on the given version
   * and domains, with the constants and options it had when the backup was taken. Not suspended.
   */
  restoreDeletedStore(input: Omit<CreateStoreInput, 'snapshotId' | 'user'> & { backupId: string }): Promise<void>;

  /**
   * Replaces a live store's files and database with one of its backups, in place. The store keeps
   * its current domains, version code, constants and suspension; `wpOptions` (the tenant's current
   * options) are written again afterwards, so the options the API set stay as the API records them.
   */
  rollbackStore(input: { storeId: string; backupId: string; wpOptions: Record<string, string>; mainDomain?: string; ownCode?: boolean }): Promise<void>;

  // Sites moved in from another host (src/imports.ts).

  /** Where the site's archive (database.sql and wp-content, zip or gzipped tar) is PUT, valid for `expiresInSeconds`. */
  createImportUpload(input: { storeId: string; expiresInSeconds: number }): Promise<string>;

  /** The size of the uploaded archive in bytes, or null when nothing was uploaded yet. */
  importSize(input: { storeId: string }): Promise<number | null>;

  /** Deletes the uploaded archive, once the store is built from it or the import is given up. */
  deleteImport(input: { storeId: string }): Promise<void>;

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

  /**
   * Ends the hold of a site moved in (createStore with snapshotId null): its scheduled jobs start, it emails
   * everyone again and search engines may index it. Nothing changes for a store that isn't held.
   */
  goLive(input: { storeId: string }): Promise<void>;

  /**
   * A one-time link for the store's user with this email to set their password (WordPress's reset link), for the
   * email that tells a store's owner their website is ready.
   */
  passwordLink(input: { storeId: string; email: string }): Promise<string>;

  deleteStore(input: { storeId: string }): Promise<void>;

  /**
   * Restores a store's backup into a throwaway test store, checks that WordPress opens it, and deletes
   * the test store again, pass or fail (src/restoretests.ts). The test store never serves visitors, sends
   * email or runs cron, and the real store is not touched. Returns what the restored copy holds; throws
   * when the backup cannot be restored.
   */
  testRestore(input: { testId: string; backupId: string; versionId: string; size: Size }): Promise<RestoreTestResult>;

  /** Deletes a test store testRestore left behind (the API stopped mid-test); nothing when there is none. */
  deleteRestoreTest(input: { testId: string }): Promise<void>;

  /**
   * Brings a store created under an older store setup (its compose file and the files the agent
   * installs, such as the page cache), or running at another size than `size`, to the current setup
   * at `size`, restarting it once. createStore already gives new stores the current setup; the API
   * calls it for every live store on startup, with the size it has on record.
   */
  ensureStoreSetup(input: { storeId: string; size: Size }): Promise<'updated' | 'unchanged'>;

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
   * sends from its own verified domain (src/maildomains.ts) instead of the platform's; with `mailbox`,
   * from that name at the platform's sending domain.
   */
  ensureStoreMail(input: { storeId: string } & StoreMailFrom): Promise<'created' | 'updated' | 'unchanged'>;

  /** The address a store with these settings sends from (storeFromAddress), or null when stores send no email. */
  mailFrom(input: StoreMailFrom): string | null;
}

/** A store's own sending domain, verified on toSend: it sends from the platform's address name at it. */
export interface StoreSender {
  domain: string;
  /** toSend's id for the domain; the store's key is restricted to it. */
  domainId: string;
}

/** Who a store's email is from: its own verified domain, else its own mailbox at the platform's sending domain. */
export interface StoreMailFrom {
  sender?: StoreSender;
  /** A name at the platform's sending domain (src/mailcount.ts); unset: the platform's address itself. */
  mailbox?: string;
}

/**
 * The address a store sends from, given the platform's (STORE_MAIL_FROM, e.g. no-reply@anypress.io): its
 * name at the store's own domain (no-reply@shop.example), or the store's mailbox at the platform's domain
 * (acme@anypress.io), or the platform's address itself.
 */
export function storeFromAddress(platformFrom: string, { sender, mailbox }: StoreMailFrom): string {
  const [name, domain] = platformFrom.split('@') as [string, string];
  if (sender) return `${name}@${sender.domain}`;
  return mailbox ? `${mailbox}@${domain}` : platformFrom;
}

/** A site moved in, checked once built: its home and login pages' HTTP status, and the first PHP fatal error. */
export interface SiteCheck {
  ok: boolean;
  home?: number;
  login?: number;
  /** WordPress loaded with every plugin and the theme. */
  loaded?: boolean;
  fatal?: string | null;
  /** The check itself could not run. */
  error?: string;
  /** What the moved site runs and holds (agent.php site_inventory), for the report after the move (src/sitereport.ts). */
  inventory?: SiteInventory;
}

/** What a restored backup holds, as testRestore found it. */
export interface RestoreTestResult {
  /** The site's title and address in the restored database. */
  name: string | null;
  home: string | null;
  tables: number;
  posts: number;
}

export interface PhpConstant {
  value: string;
  isPrivate?: boolean;
}

export interface CreateStoreInput {
  storeId: string;
  versionId: string;
  /** Null for a site moved in from another host: the store is built from its uploaded archive. */
  snapshotId: string | null;
  /**
   * The store keeps its own plugins and themes (a site moved in from another host): they are never
   * replaced with the version's code.
   */
  ownCode?: boolean;
  mainDomain: string;
  redirectDomains: string[];
  /** Written as define() in wp-config. */
  phpConstants: Record<string, PhpConstant>;
  wpOptions: Record<string, string>;
  /** Its resources and quotas (src/plans.ts). */
  size: Size;
  /** The store's mailbox at the platform's sending domain (StoreMailFrom); unset: the platform's address. */
  mailbox?: string;
  user?: { name: string; email: string; role: string; password?: string };
  /**
   * Holds the store until goLive: no cron, email only to its administrator and `holdAllow`, not indexed. A site
   * moved in is always held; a held store restored after deletion is held again.
   */
  hold?: boolean;
  /** Who else gets email while the store is held: its owner's addresses. */
  holdAllow?: string[];
}
