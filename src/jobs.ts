import { purgeExpiredSignIns } from './auth.ts';
import { sendWebsiteReady, type AuthMail } from './authmail.ts';
import { brandedMail } from './branding.ts';
import { maintainDashboardDomains } from './dashboarddomains.ts';
import { withTransaction, type Pool } from './db.ts';
import { planFor, step, withProgress } from './progress.ts';
import { promoteVersion } from './promote.ts';
import type { PgBoss } from 'pg-boss';
import { BRAND_OPTION, CLEAN_DASHBOARD_OPTION, type Brand, type Provisioner, type VersionPlugin } from './provisioner/provisioner.ts';
import { storeJobWaiting, type JobData, type JobHandlers } from './queue.ts';
import { failHostUpdate, forgetHostUpdate, pushHostUpdate } from './hostupdates.ts';
import type { SiteRequest, SiteResponse } from './sitekeys.ts';
import { applyDemoDraft, purgeExpiredDemoDrafts } from './demodrafts.ts';
import { holdAllowList, purgeExpiredImports, recordImportBuilt, recordImportFailure, reprintSource } from './imports.ts';
import { failMailbox, pushMailbox } from './outreach.ts';
import { failAutomations, pushAutomations } from './outreachautomation.ts';
import { failCrmProspects, pushCrmProspects } from './prospectcrm.ts';
import { STORAGE_PACK_GB, type Size } from './plans.ts';
import { recordMailSender, storeMailbox, type MailboxDomains } from './mailcount.ts';
import { storeSenders } from './maildomains.ts';
import { pruneRequestLog } from './requestlog.ts';
import type { ReleaseStore } from './releases.ts';
import type { Secrets } from './secrets.ts';
import { failDownload, makeDownload, purgeExpiredDownloads } from './sitedownloads.ts';
import { Status } from './status.ts';
import { decodePhpConstants, emailPacksBought, TENANT_SELECT } from './tenants.ts';
import type { DashboardHost } from './vercel.ts';

/**
 * `mailboxDomains` names each store's mailbox at the platform's sending domain (src/mailcount.ts); without
 * them stores send from the platform's address.
 */
/** A request to a store's site routes (src/sitekeys.ts callSite), signed with that store's key. */
export type SiteCall = (storeId: string, domain: string, request: SiteRequest) => Promise<SiteResponse>;

export function createJobHandlers(
  pool: Pool,
  provisioner: Provisioner,
  secrets: Secrets,
  backupRetentionDays: number,
  requestLogDays = 30,
  mailboxDomains?: MailboxDomains,
  /** Sellers' own dashboard addresses, checked nightly (src/dashboarddomains.ts). */
  dashboardHost: () => DashboardHost | undefined = () => undefined,
  /** Sends the "your website is ready" email a create can ask for (notifyOwner); without it none is sent. */
  ownerMail: () => AuthMail | undefined = () => undefined,
  /** Plugin releases, for pushing AnyPress Host to storefronts (src/hostupdates.ts). */
  releases?: ReleaseStore,
  /** For a follower's copied version that takes over once built (promote_when_done, src/promote.ts). */
  boss?: PgBoss,
  /** Calls a store's site routes, signed with its key: a new store made from a demo gets the demo's content. */
  siteCall?: SiteCall,
): JobHandlers {
  const mailbox = (tenantId: string) => (mailboxDomains ? storeMailbox(pool, provisioner, mailboxDomains, tenantId) : Promise.resolve(undefined));

  const setTenantStatus = (tenantId: string, status: number, onlyFrom?: number) =>
    pool.query(
      `UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1 ${onlyFrom === undefined ? '' : 'AND status = $3'}`,
      onlyFrom === undefined ? [tenantId, status] : [tenantId, status, onlyFrom],
    );

  /**
   * Marks a store Done when its job is finished, unless another job that changes it is still waiting: the store
   * isn't what its record says until that one runs too, so it stays Pending and the last job sets it Done.
   */
  const finishTenant = (tenantId: string) => finishStore(pool, boss, tenantId);

  /** Puts a store whose automatic move failed back on the version it was on. False when that fails too. */
  const moveBack = async (tenantId: string, versionId: string) => {
    try {
      const { rows } = await pool.query('SELECT own_code FROM tenants WHERE id = $1', [tenantId]);
      if (!rows[0]) return false;
      await provisioner.moveStore({ storeId: tenantId, targetVersionId: versionId, ownCode: rows[0].own_code === true });
      await finishTenant(tenantId);
      return true;
    } catch (err) {
      console.error(`store ${tenantId} could not be moved back to version ${versionId}: ${(err as Error).message}`);
      return false;
    }
  };

  /** The steps a store job will show on the dashboard's progress bar (src/progress.ts). */
  const progressPlan = async (data: JobData & { tenantId: string }) => {
    if (data.type !== 'tenant.create') {
      const safetyBackup = data.type === 'tenant.rollback' ? !!data.safetyBackupId : data.type === 'tenant.suspend' ? !!data.backupId : false;
      return planFor(data.type, { safetyBackup });
    }
    const { rows } = await pool.query('SELECT snapshot_id FROM tenants WHERE id = $1', [data.tenantId]);
    return planFor(data.type, { imported: rows[0] ? rows[0].snapshot_id === null : false });
  };

  async function runJob(data: JobData) {
    switch (data.type) {
      case 'version.create':
        return createVersion(pool, provisioner, secrets, data, boss);
      case 'basesnapshot.delete':
        await provisioner.deleteBaseSnapshot({ baseSnapshotId: data.baseSnapshotId });
        return;
      case 'version.delete':
        await provisioner.deleteVersion({ versionId: data.versionId });
        await pool.query('DELETE FROM versions WHERE id = $1', [data.versionId]);
        return;
      case 'tenant.create':
        return createTenant(pool, provisioner, secrets, data, await mailbox(data.tenantId), ownerMail(), boss, siteCall);
      case 'tenant.update': {
        const { rows } = await pool.query('SELECT php_constants, size FROM tenants WHERE id = $1', [data.tenantId]);
        if (!rows[0]) return;
        await provisioner.updateStore({
          storeId: data.tenantId,
          wpOptions: data.wpOptions,
          // The full set whenever any constant changed: a host may have to rewrite them all at once.
          phpConstants: data.phpConstantNames?.length ? decodePhpConstants(secrets, rows[0].php_constants) : undefined,
          // The size on record, not the job's: a later PUT may have changed it again before this ran.
          size: data.size ? rows[0].size : undefined,
        });
        // A move or delete queued meanwhile has set its own status; only finish a Pending one.
        await finishTenant(data.tenantId);
        return;
      }
      case 'tenant.move': {
        // A move queued behind another job (src/promote.ts) starts once that job has set the store Done: show it
        // as busy again. A store that failed or is being deleted meanwhile stays where it is.
        const { rows } = await pool.query(
          'UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1 AND status IN ($2, $3) RETURNING own_code, size',
          [data.tenantId, Status.Pending, Status.Done],
        );
        if (!rows[0]) return;
        await provisioner.moveStore({ storeId: data.tenantId, targetVersionId: data.targetVersionId, ownCode: rows[0]?.own_code === true });
        await pool.query('UPDATE tenants SET version_id = $2, date_changed = now() WHERE id = $1', [data.tenantId, data.targetVersionId]);
        // A store moving while a new store setup rolled out was skipped (maintainStores takes only ready stores):
        // it gets the setup now. The move stands either way; the next start tries again.
        await provisioner.ensureStoreSetup({ storeId: data.tenantId, size: rows[0].size }).catch((err: Error) => {
          console.error(`Store ${data.tenantId}: store setup not ensured after its move: ${err.message}`);
        });
        await forgetHostUpdate(pool, data.tenantId);
        await finishTenant(data.tenantId);
        return;
      }
      case 'tenant.domains': {
        const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.id = $1`, [data.tenantId]);
        if (!rows[0]) return;
        // The store's mailbox follows its main domain; a store sending from its own domain keeps it.
        const sender = (await storeSenders(pool, data.tenantId)).get(data.tenantId);
        const mail = mailboxDomains && (sender ? { sender } : { mailbox: await mailbox(data.tenantId) });
        await provisioner.setDomains({ storeId: data.tenantId, mainDomain: rows[0].main_domain, redirectDomains: rows[0].redirect_domains, mail });
        if (mail) await recordMailSender(pool, provisioner, data.tenantId, mail);
        await finishTenant(data.tenantId);
        return;
      }
      case 'tenant.delete': {
        await provisioner.deleteStore({ storeId: data.tenantId });
        // A site that was being moved in leaves no upload behind.
        await provisioner.deleteImport({ storeId: data.tenantId });
        // Keep what a restore needs on the backups, which outlive the tenant.
        step('keep');
        const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.id = $1`, [data.tenantId]);
        const { rows: domains } = await pool.query(
          'SELECT domain_name, is_main, is_base FROM tenant_domains WHERE tenant_id = $1 ORDER BY date_created',
          [data.tenantId],
        );
        const record = rows[0] && {
          name: rows[0].name,
          versionId: rows[0].version_id,
          snapshotId: rows[0].snapshot_id,
          snapshotName: rows[0].snapshot_name,
          snapshotGroupName: rows[0].snapshot_group_name,
          size: rows[0].size,
          ownCode: rows[0].own_code,
          onHold: rows[0].on_hold,
          domains: domains.map((d) => ({ domainName: d.domain_name, isMain: d.is_main, isBase: d.is_base })),
        };
        await pool.query(
          'UPDATE tenant_backups SET tenant_deleted_at = now(), tenant_record = COALESCE($2, tenant_record) WHERE tenant_id = $1 AND tenant_deleted_at IS NULL',
          [data.tenantId, record ?? null],
        );
        await pool.query('DELETE FROM tenants WHERE id = $1', [data.tenantId]);
        return;
      }
      case 'tenant.restore': {
        const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.id = $1`, [data.tenantId]);
        const tenant = rows[0];
        if (!tenant) return;
        const restoredMailbox = await mailbox(tenant.id);
        await provisioner.restoreDeletedStore({
          storeId: tenant.id,
          backupId: data.backupId,
          versionId: tenant.version_id,
          mainDomain: tenant.main_domain,
          redirectDomains: tenant.redirect_domains,
          phpConstants: decodePhpConstants(secrets, tenant.php_constants),
          wpOptions: { ...tenant.wp_options, ...(await brandOptions(pool, tenant.id)) },
          size: tenant.size,
          ownCode: tenant.own_code,
          mailbox: restoredMailbox,
          // A site moved in that was still held comes back held.
          ...(tenant.on_hold && { hold: true, holdAllow: await holdAllowList(pool, tenant.id) }),
        });
        await recordMailSender(pool, provisioner, tenant.id, { mailbox: restoredMailbox });
        await forgetHostUpdate(pool, tenant.id);
        await finishTenant(tenant.id);
        return;
      }
      case 'tenant.rollback': {
        if (data.safetyBackupId) await backUp(pool, provisioner, data.tenantId, data.safetyBackupId);
        const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.id = $1`, [data.tenantId]);
        if (!rows[0]) return;
        await provisioner.rollbackStore({
          storeId: data.tenantId,
          backupId: data.backupId,
          wpOptions: { ...rows[0].wp_options, ...(await brandOptions(pool, data.tenantId)) },
          mainDomain: rows[0].main_domain,
          ownCode: rows[0].own_code,
        });
        // The backup's database holds the pack total of its day; tell the store the one on record again.
        const purchased = await emailPacksBought(pool, data.tenantId);
        if (purchased) await provisioner.setEmailPacks({ storeId: data.tenantId, purchased });
        // And the storage packs on record (the backup holds those of its day).
        if (rows[0].storage_packs) await provisioner.setStoragePacks({ storeId: data.tenantId, gb: rows[0].storage_packs * STORAGE_PACK_GB });
        // Its platform email count is an older one too: the next count tells the store again.
        await pool.query('DELETE FROM tenant_mail_usage WHERE tenant_id = $1', [data.tenantId]);
        await forgetHostUpdate(pool, data.tenantId);
        await finishTenant(data.tenantId);
        return;
      }
      case 'tenant.suspend':
        if (data.backupId) await backUp(pool, provisioner, data.tenantId, data.backupId);
        await provisioner.suspendStore({ storeId: data.tenantId, brand: await resellerBrand(pool, data.tenantId) });
        await finishTenant(data.tenantId);
        return;
      case 'tenant.resume':
        await provisioner.resumeStore({ storeId: data.tenantId });
        await finishTenant(data.tenantId);
        return;
      case 'tenant.go-live':
        await provisioner.goLive({ storeId: data.tenantId });
        await finishTenant(data.tenantId);
        return;
      case 'tenant.backup':
        await backUp(pool, provisioner, data.tenantId, data.backupId);
        return;
      case 'tenant.download':
        await makeDownload(pool, provisioner, data.tenantId, data.downloadId);
        return;
      case 'storefront.update-host':
        await pushHostUpdate(pool, provisioner, releases, data.tenantId, data.version);
        return;
      case 'storefront.crm-prospects': {
        const { rows } = await pool.query<{ size: Size }>('SELECT size FROM tenants WHERE id = $1', [data.tenantId]);
        if (!rows[0]) return failCrmProspects(pool, data.productId, 'The storefront is gone');
        // The current store agent first: one from before crm-prospects doesn't have it.
        await provisioner.ensureStoreSetup({ storeId: data.tenantId, size: rows[0].size });
        await pushCrmProspects(pool, (contacts) => provisioner.addCrmProspects({ storeId: data.tenantId, contacts }), data.productId);
        return;
      }
      case 'storefront.outreach-mailbox': {
        const { rows } = await pool.query<{ size: Size }>('SELECT size FROM tenants WHERE id = $1', [data.tenantId]);
        if (!rows[0]) return failMailbox(pool, data.productId, 'The storefront is gone');
        // The current store agent first: one from before outreach-mailbox doesn't have it, nor the guard.
        await provisioner.ensureStoreSetup({ storeId: data.tenantId, size: rows[0].size });
        await pushMailbox(pool, secrets, (mailbox) => provisioner.setOutreachMailbox({ storeId: data.tenantId, mailbox }), data.productId);
        return;
      }
      case 'storefront.outreach-automation': {
        const { rows } = await pool.query<{ size: Size }>('SELECT size FROM tenants WHERE id = $1', [data.tenantId]);
        if (!rows[0]) return failAutomations(pool, data.productId, 'The storefront is gone');
        // The current store agent first: one from before crm-automation doesn't have it, nor the outreach queue.
        await provisioner.ensureStoreSetup({ storeId: data.tenantId, size: rows[0].size });
        await pushAutomations(pool, (automation) => provisioner.addOutreachAutomation({ storeId: data.tenantId, automation }), data.productId);
        return;
      }
      case 'tenant.email-packs': {
        const { rowCount } = await pool.query('SELECT 1 FROM tenants WHERE id = $1', [data.tenantId]);
        if (!rowCount) return;
        // The total on record when the job runs, not when it was queued: packs bought meanwhile are included.
        await provisioner.setEmailPacks({ storeId: data.tenantId, purchased: await emailPacksBought(pool, data.tenantId) });
        return;
      }
      case 'tenant.storage-packs': {
        const { rows } = await pool.query<{ storage_packs: number }>('SELECT storage_packs FROM tenants WHERE id = $1', [data.tenantId]);
        if (!rows[0]) return;
        // The count on record when the job runs, not when it was queued: a change meanwhile is included.
        await provisioner.setStoragePacks({ storeId: data.tenantId, gb: rows[0].storage_packs * STORAGE_PACK_GB });
        return;
      }
    }
  }

  return {
    async run(data: JobData) {
      if (!data.type.startsWith('tenant.') || !('tenantId' in data)) return runJob(data);
      return withProgress(pool, data.tenantId, data.type, await progressPlan(data), () => runJob(data));
    },

    async maintenance() {
      await purgeExpiredBackups(pool, provisioner, backupRetentionDays);
      await purgeExpiredDownloads(pool, provisioner);
      await purgeExpiredImports(pool, provisioner);
      await purgeExpiredDemoDrafts(pool, provisioner);
      await pruneRequestLog(pool, requestLogDays);
      await purgeExpiredSignIns(pool);
      await maintainDashboardDomains(pool, dashboardHost());
      await stopBuiltVersions(pool, provisioner);
    },

    async fail(data: JobData, error: unknown, job: { id: string; attempts: number }) {
      await pool.query(
        `INSERT INTO job_failures (job_id, job_type, job_data, tenant_id, version_id, error_message, attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          job.id,
          data.type,
          data,
          'tenantId' in data ? data.tenantId : null,
          'versionId' in data ? data.versionId : null,
          error instanceof Error ? error.message : String(error),
          job.attempts,
        ],
      );
      switch (data.type) {
        case 'version.create':
          await pool.query('UPDATE versions SET status = $2, date_changed = now() WHERE id = $1 AND status = $3', [data.versionId, Status.Failed, Status.Pending]);
          await pool.query('UPDATE snapshots SET status = $2 WHERE version_id = $1 AND status = $3', [data.versionId, Status.Failed, Status.Pending]);
          return;
        case 'basesnapshot.delete':
          return; // the row is gone already; the job error is logged
        case 'version.delete':
          await pool.query('UPDATE versions SET status = $2, date_changed = now() WHERE id = $1', [data.versionId, Status.Failed]);
          await pool.query('UPDATE snapshots SET status = $2 WHERE version_id = $1 AND status = $3', [data.versionId, Status.Failed, Status.Removing]);
          return;
        case 'tenant.create': {
          // A site being moved in: why, in words its owner can act on (/imports/status).
          const message = error instanceof Error ? error.message : String(error);
          await recordImportFailure(pool, data.tenantId, message);
          // A copy again with Reprint that could not fetch the site changed nothing: the store built before stays as it was.
          if (/\breprint[ :]/.test(message)) {
            const { rowCount } = await pool.query('UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1 AND status = $3 AND on_hold', [data.tenantId, Status.Done, Status.Pending]);
            if (rowCount) return;
          }
          await setTenantStatus(data.tenantId, Status.Failed, Status.Pending);
          return;
        }
        case 'tenant.move':
          if (data.rollbackVersionId && (await moveBack(data.tenantId, data.rollbackVersionId))) return;
          await setTenantStatus(data.tenantId, Status.Failed, Status.Pending);
          return;
        case 'tenant.update':
        case 'tenant.domains':
          await setTenantStatus(data.tenantId, Status.Failed, Status.Pending);
          return;
        case 'storefront.crm-prospects':
          // The businesses can be sent again from the finder.
          await failCrmProspects(pool, data.productId, error);
          return;
        case 'storefront.outreach-mailbox':
          await failMailbox(pool, data.productId, error);
          return;
        case 'storefront.outreach-automation':
          await failAutomations(pool, data.productId, error);
          return;
        case 'storefront.update-host':
          // The store still works, on the copy it had; the row says why, and POST /admin/host-updates tries again.
          await failHostUpdate(pool, data.tenantId, data.version, error);
          return;
        case 'tenant.email-packs':
          // The store still works; it just doesn't have its new pack emails yet. The shop's retry sends them again.
          return;
        case 'tenant.storage-packs':
          // The store still works with the storage it had; the shop's retry sends the count again.
          return;
        case 'tenant.delete':
          await setTenantStatus(data.tenantId, Status.Failed);
          return;
        case 'tenant.suspend':
        case 'tenant.resume':
        case 'tenant.go-live':
          if ('backupId' in data && data.backupId) await failBackup(pool, data.backupId);
          await setTenantStatus(data.tenantId, Status.Failed, Status.Pending);
          return;
        case 'tenant.backup':
          await failBackup(pool, data.backupId);
          return;
        case 'tenant.download':
          // The store still works; the person sees the copy failed and can ask again.
          await failDownload(pool, data.downloadId);
          return;
        case 'tenant.restore':
          await setTenantStatus(data.tenantId, Status.Failed, Status.Pending);
          return;
        case 'tenant.rollback': {
          // The backup taken first never finished: the store was not touched and still works.
          const untouched = data.safetyBackupId && (await failBackup(pool, data.safetyBackupId)).rowCount;
          if (untouched) await finishTenant(data.tenantId);
          else await setTenantStatus(data.tenantId, Status.Failed, Status.Pending);
          return;
        }
      }
    },
  };
}

/** The brand of the reseller a store's storefront belongs to, when it set one: its stores' "unavailable" page shows it. */
async function resellerBrand(pool: Pool, tenantId: string): Promise<Brand | undefined> {
  const { rows } = await pool.query(
    `SELECT r.brand_name, r.brand_url FROM tenants t JOIN products p ON p.id = t.product_id JOIN resellers r ON r.id = p.reseller_id
      WHERE t.id = $1 AND r.brand_name IS NOT NULL`,
    [tenantId],
  );
  return rows[0] ? { name: rows[0].brand_name, url: rows[0].brand_url ?? undefined } : undefined;
}

/**
 * The options AnyPress Client reads that its storefront decides, set whenever the store's database is written from
 * elsewhere (built, restored, rolled back): on a reseller's stores the reseller's brand instead of AnyPress
 * (BRAND_OPTION, 2.13.0+), and the clean Dashboard home on or off (CLEAN_DASHBOARD_OPTION, 2.28.0+).
 */
async function brandOptions(pool: Pool, tenantId: string): Promise<Record<string, string>> {
  const brand = await resellerBrand(pool, tenantId);
  const { rows } = await pool.query<{ clean_dashboard: boolean }>(
    'SELECT p.clean_dashboard FROM tenants t JOIN products p ON p.id = t.product_id WHERE t.id = $1',
    [tenantId],
  );
  return {
    ...(brand ? { [BRAND_OPTION]: brand.name } : {}),
    ...(rows[0] ? { [CLEAN_DASHBOARD_OPTION]: rows[0].clean_dashboard ? 'on' : 'off' } : {}),
  };
}

async function createVersion(pool: Pool, provisioner: Provisioner, secrets: Secrets, data: Extract<JobData, { type: 'version.create' }>, boss?: PgBoss) {
  const { rows } = await pool.query('SELECT * FROM versions WHERE id = $1', [data.versionId]);
  const version = rows[0];
  if (!version) return; // removed before the build ran

  // Plugin choices (docs/plugin-choices.md) as they were when the version was made; each added plugin's file is kept.
  // Licence constants stay encrypted in the row and are only opened here, for the build.
  const plugins: (VersionPlugin & { name?: string; file?: string; licence?: string })[] = version.plugin_choices ?? [];
  const { pluginFiles } = await provisioner.buildVersion({
    versionId: version.id,
    domain: version.domain,
    wordPressVersion: version.wordpress_version,
    phpVersion: version.php_version,
    source: data.source,
    plugins: plugins.map(({ name: _name, file: _file, licence, ...p }) => (licence ? { ...p, constants: JSON.parse(secrets.decrypt(licence)) } : p)),
  });
  if (plugins.length) {
    const withFiles = plugins.map((p) => (pluginFiles[p.slug] ? { ...p, file: pluginFiles[p.slug] } : p));
    await pool.query('UPDATE versions SET plugin_choices = $2 WHERE id = $1', [version.id, JSON.stringify(withFiles)]);
  }

  const snapshots = await pool.query('SELECT id, source_snapshot_id, source_base_snapshot_id FROM snapshots WHERE version_id = $1 AND status = $2', [
    version.id,
    Status.Pending,
  ]);
  for (const snapshot of snapshots.rows) {
    if (snapshot.source_base_snapshot_id) {
      await provisioner.copyBaseSnapshot({ baseSnapshotId: snapshot.source_base_snapshot_id, newSnapshotId: snapshot.id, targetVersionId: version.id });
    } else if (snapshot.source_snapshot_id) {
      await provisioner.copySnapshot({ snapshotId: snapshot.source_snapshot_id, newSnapshotId: snapshot.id, targetVersionId: version.id });
    } else {
      await provisioner.snapshotUpload({ versionId: version.id, snapshotId: snapshot.id });
    }
    await pool.query('UPDATE snapshots SET status = $2 WHERE id = $1 AND status = $3', [snapshot.id, Status.Done, Status.Pending]);
  }

  // A delete queued meanwhile has already set Removing; leave that alone.
  // roles: a rebuilt version is read again from its new code.
  const { rowCount: built } = await pool.query('UPDATE versions SET status = $2, roles = NULL, date_changed = now() WHERE id = $1 AND status = $3', [
    version.id,
    Status.Done,
    Status.Pending,
  ]);

  // A copy for a storefront that follows another (src/routes/versions.ts) takes over now, with the storefront's stores.
  if (built && boss) {
    await withTransaction(pool, async (client) => {
      const { rows: promote } = await client.query('SELECT 1 FROM versions WHERE id = $1 AND promote_when_done FOR UPDATE', [version.id]);
      if (promote.length) await promoteVersion(client, boss, version.product_id, version.id);
    });
  }

  // Its snapshots are taken, so the site isn't needed any more: 18 idle version sites once loaded the server.
  // The version is built either way, so a failed stop is only logged.
  await provisioner.stopVersion({ versionId: version.id }).catch((err: unknown) => console.error(`Version ${version.id}: stop failed: ${(err as Error).message}`));
}

/**
 * Sets a Pending store Done, unless a job that changes it is still waiting (storeJobWaiting). The row lock makes
 * this and a request queuing a job for the store take turns: that request updates the same row in its transaction,
 * so either it waits for this one, or this one waits for it and then sees its job.
 */
async function finishStore(pool: Pool, boss: PgBoss | undefined, tenantId: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
    if (boss && (await storeJobWaiting(boss, client, tenantId))) return;
    await client.query('UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1 AND status = $3', [tenantId, Status.Done, Status.Pending]);
  });
}

async function createTenant(
  pool: Pool,
  provisioner: Provisioner,
  secrets: Secrets,
  data: Extract<JobData, { type: 'tenant.create' }>,
  mailbox?: string,
  ownerMail?: AuthMail,
  boss?: PgBoss,
  siteCall?: SiteCall,
) {
  const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.id = $1`, [data.tenantId]);
  const tenant = rows[0];
  if (!tenant) return; // removed before it was built

  const user = data.user && {
    name: data.user.name,
    email: data.user.email,
    role: data.user.role,
    password: data.user.encryptedPassword ? secrets.decrypt(data.user.encryptedPassword) : undefined,
  };
  // A site moved in is held until its owner makes it live; its owner's team still gets its email meanwhile.
  const imported = tenant.snapshot_id === null;
  const built = await provisioner.createStore({
    storeId: tenant.id,
    versionId: tenant.version_id,
    snapshotId: tenant.snapshot_id,
    mainDomain: tenant.main_domain,
    redirectDomains: tenant.redirect_domains,
    phpConstants: decodePhpConstants(secrets, tenant.php_constants),
    wpOptions: { ...tenant.wp_options, ...(await brandOptions(pool, tenant.id)) },
    size: tenant.size,
    ownCode: tenant.own_code,
    mailbox,
    user,
    ...(imported && { hold: true, holdAllow: await holdAllowList(pool, tenant.id) }),
    // Copied from its host with Reprint, rather than built from an uploaded archive.
    ...(imported && { reprint: (await reprintSource(pool, secrets, tenant.id)) ?? undefined }),
  });
  await recordMailSender(pool, provisioner, tenant.id, { mailbox });
  if (imported) await recordImportBuilt(pool, tenant.id, built?.check, built?.moved);
  if (imported) await pool.query('UPDATE tenants SET on_hold = true, date_held = COALESCE(date_held, now()) WHERE id = $1', [tenant.id]);
  // Made from a demo someone built on Playground: the demo's pages, styles and photos (src/demodrafts.ts).
  if (!imported && siteCall) await applyDemoDraft(pool, provisioner, tenant.id, (request) => siteCall(tenant.id, tenant.main_domain, request));
  await finishStore(pool, boss, tenant.id);
  // A site moved in is built: its upload is no longer needed.
  if (imported) await provisioner.deleteImport({ storeId: tenant.id });  if (data.notifyOwner && user && !imported) await notifyOwner(pool, provisioner, ownerMail, tenant, user);
}

/**
 * The email whoever made the store asked to send its owner: it is ready, and a link to set their password. In the
 * storefront's brand, without a "Powered by" line, so a reseller's client sees only the reseller. The store is
 * built either way, so a failure is only logged.
 */
async function notifyOwner(
  pool: Pool,
  provisioner: Provisioner,
  ownerMail: AuthMail | undefined,
  tenant: { id: string; product_id: string; name: string; main_domain: string },
  user: { name: string; email: string },
) {
  if (!ownerMail) return console.error(`Store ${tenant.id}: no email set up, so its owner was not told it is ready`);
  try {
    await emailWebsiteReady(pool, provisioner, ownerMail, tenant, user.email);
  } catch (err) {
    console.error(`Store ${tenant.id}: the email to its owner failed: ${(err as Error).message}`);
  }
}

/**
 * The "your website is ready" email with a fresh set-password link, to the store's WordPress user with `email`:
 * after a create that asked for it, or later from the dashboard (POST /admin/tenants/:id/notify-owner). Throws
 * when the store has no such user or the email can't be sent. The username is the one in WordPress's link.
 * Records when and to whom it went (ownerNotifiedAt and ownerNotifiedTo on the admin store detail).
 */
export async function emailWebsiteReady(
  pool: Pool,
  provisioner: Provisioner,
  ownerMail: AuthMail,
  tenant: { id: string; product_id: string; name: string; main_domain: string },
  email: string,
) {
  const passwordLink = await provisioner.passwordLink({ storeId: tenant.id, email });
  const username = new URL(passwordLink).searchParams.get('login') || email;
  const mail = await brandedMail(pool, ownerMail, tenant.product_id);
  await sendWebsiteReady({ ...mail, poweredBy: undefined }, email, {
    site: tenant.name,
    url: `https://${tenant.main_domain}/`,
    username,
    passwordLink,
  });
  await pool.query('UPDATE tenants SET owner_notified_at = now(), owner_notified_to = $2 WHERE id = $1', [tenant.id, email]);
}

async function backUp(pool: Pool, provisioner: Provisioner, tenantId: string, backupId: string) {
  const { rows } = await pool.query('SELECT status FROM tenant_backups WHERE id = $1', [backupId]);
  if (rows[0]?.status !== Status.Pending) return; // already taken on an earlier attempt
  const { sizeBytes } = await provisioner.backupStore({ storeId: tenantId, backupId });
  // The constants and options a restore from this backup brings back.
  await pool.query(
    `UPDATE tenant_backups b SET status = $2, size_bytes = $3, wp_options = t.wp_options, php_constants = t.php_constants
       FROM tenants t WHERE b.id = $1 AND t.id = b.tenant_id`,
    [backupId, Status.Done, sizeBytes],
  );
}

const failBackup = (pool: Pool, backupId: string) =>
  pool.query('UPDATE tenant_backups SET status = $2 WHERE id = $1 AND status = $3', [backupId, Status.Failed, Status.Pending]);

/** Deletes the backups of tenants deleted more than `retentionDays` ago. Safe to re-run. */
export async function purgeExpiredBackups(pool: Pool, provisioner: Provisioner, retentionDays: number): Promise<number> {
  const { rows } = await pool.query('SELECT id FROM tenant_backups WHERE tenant_deleted_at < now() - make_interval(days => $1)', [retentionDays]);
  for (const { id } of rows) {
    await provisioner.deleteBackup({ backupId: id });
    await pool.query('DELETE FROM tenant_backups WHERE id = $1', [id]);
  }
  return rows.length;
}

/**
 * Stops the site of every built version. A version's site is only needed while it is built (stores start from its
 * code and snapshots in storage), and the build stops it (createVersion), but one started again by hand, or built
 * before that, kept running a full WordPress and MariaDB for nothing: on 2026-10-24 a template a day out of
 * production still ran on a CPU-limited server.
 */
export async function stopBuiltVersions(pool: Pool, provisioner: Provisioner) {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM versions WHERE status = $1', [Status.Done]);
  for (const { id } of rows) {
    await provisioner.stopVersion({ versionId: id }).catch((err: unknown) => console.error(`Version ${id}: stop failed: ${(err as Error).message}`));
  }
}
