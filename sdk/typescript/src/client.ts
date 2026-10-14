import type { components, operations as provisioningOperations } from './generated/provisioning.js';
import type { components as mailComponents, operations as mailOperations } from './generated/store-mail.js';

type Operations = provisioningOperations & mailOperations;
type OperationId = keyof Operations;

/** The query parameters an operation takes, from the OpenAPI contract. */
export type QueryOf<K extends OperationId> = Operations[K] extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;

/** The JSON body an operation takes, from the OpenAPI contract (`undefined` when it takes none). */
export type BodyOf<K extends OperationId> = [NonNullable<Operations[K]['requestBody']>] extends [never]
  ? undefined
  : NonNullable<Operations[K]['requestBody']> extends { content: { 'application/json': infer B } }
    ? B
    : undefined;

/** What an operation answers with on success (`void` when the body is empty). */
export type ResultOf<K extends OperationId> = Operations[K] extends { responses: { 200: { content: { 'application/json': infer R } } } }
  ? R
  : void;

type Schemas = components['schemas'];
export type Tenant = Schemas['GetTenantQueryResult'];
export type TenantBackup = Schemas['GetTenantBackupQueryResult'];
export type TenantDomain = Schemas['GetTenantDomainsQueryResult'];
export type Version = Schemas['GetVersionQueryResult'];
export type Snapshot = Schemas['GetSnapshotQueryResult'];
export type Template = Schemas['GetBaseSnapshotsQueryResult'];
export type CreateTenantParams = Schemas['CreateTenantParams'];
export type UpdateTenantParams = Schemas['UpdateTenantParams'];
export type MailDomain = mailComponents['schemas']['MailDomain'];
export type DomainConnectLink = mailComponents['schemas']['DomainConnectLink'];

/** Picks a tenant: by your own `externalId` (what the WaaS Host plugin uses) or by the API's `tenantId`. */
export type TenantRef = { externalId: string; tenantId?: never } | { tenantId: string; externalId?: never };

/** Every write is asynchronous: poll the matching list call until `statusCode` leaves Pending. */
export const StatusCode = { Pending: 0, Done: 1, Failed: 2, Removing: 3 } as const;

export interface WaasClientOptions {
  /** The API's base URL, e.g. https://api.example.com (no trailing /v1). */
  baseUrl: string;
  /** Your product API key (the Basic auth username). */
  apiKey: string;
  /** Your product API secret (the Basic auth password). Keep it server-side. */
  apiSecret: string;
  /** A fetch implementation; defaults to the global one (Node 18+, Deno, Bun, workers). */
  fetch?: typeof fetch;
}

/** A non-2xx answer. `message` is the API's own explanation when it sent one. */
export class WaasApiError extends Error {
  constructor(
    readonly status: number,
    readonly operationId: string,
    readonly apiMessage: string | null,
  ) {
    super(apiMessage ? `${operationId}: ${apiMessage} (${status})` : `${operationId} failed with HTTP ${status}`);
    this.name = 'WaasApiError';
  }
}

/** A tenant reached Failed while waitForTenant was waiting for it. */
export class TenantFailedError extends Error {
  constructor(readonly tenant: Tenant) {
    super(`Tenant ${tenant.externalId ?? tenant.id} failed to provision`);
    this.name = 'TenantFailedError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Query = Record<string, string | number | boolean | undefined | null>;

/**
 * A typed client for the WaaS provisioning API (the WPCS v1 compatible /v1 API, plus store
 * sending domains and Domain Connect). Request and response types come from openapi/*.yaml.
 */
export class WaasClient {
  readonly #baseUrl: string;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;

  constructor(options: WaasClientOptions) {
    if (!options.baseUrl) throw new TypeError('baseUrl is required');
    if (!options.apiKey || !options.apiSecret) throw new TypeError('apiKey and apiSecret are required');
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#authorization = `Basic ${btoa(`${options.apiKey}:${options.apiSecret}`)}`;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  readonly tenants = {
    /** Tenants of your product; pass a ref to get just that one (an empty list when it doesn't exist). */
    list: (ref?: TenantRef) => this.#call('listTenants', 'GET', '/v1/tenants', ref),
    /** The tenant, or null when there is none with that id. */
    get: async (ref: TenantRef): Promise<Tenant | null> => (await this.tenants.list(ref))[0] ?? null,
    /** Schedules a new store. Poll with waitForTenant. Repeating a create with the same externalId answers with the store it already made. */
    create: (params: BodyOf<'createTenant'>) => this.#call('createTenant', 'POST', '/v1/tenants', undefined, params),
    /** Sets wpOptions and phpConstants. */
    update: (ref: TenantRef, params: BodyOf<'updateTenantOptionsAndConstants'>) =>
      this.#call('updateTenantOptionsAndConstants', 'PUT', '/v1/tenants', ref, params),
    /** Schedules the deletion. Its backups are kept for the retention period, so restore can bring it back. */
    delete: (ref: TenantRef) => this.#call('deleteTenant', 'DELETE', '/v1/tenants', ref),
    /** Moves the tenant to another version of your product. */
    moveToVersion: (ref: TenantRef, targetVersionId: string) =>
      this.#call('moveTenantToAVersion', 'POST', '/v1/tenants/version', ref, { targetVersionId }),
    /** Takes the store offline (backing it up first unless takeBackup is false). */
    suspend: (ref: TenantRef, params: BodyOf<'suspendTenant'> = {}) => this.#call('suspendTenant', 'POST', '/v1/tenants/suspend', ref, params),
    resume: (ref: TenantRef) => this.#call('resumeTenant', 'POST', '/v1/tenants/resume', ref),
    /** Re-creates a deleted tenant, or rolls a live one back, from a backup (the newest finished one when backupId is omitted). */
    restore: (ref: TenantRef, params: BodyOf<'restoreTenant'> = {}) => this.#call('restoreTenant', 'POST', '/v1/tenants/restore', ref, params),
    listBackups: (ref: TenantRef) => this.#call('listTenantBackups', 'GET', '/v1/tenants/backups', ref),
    createBackup: (ref: TenantRef) => this.#call('createTenantBackup', 'POST', '/v1/tenants/backups', ref),
  };

  readonly domains = {
    list: (ref: TenantRef) => this.#call('listTenantDomains', 'GET', '/v1/tenants/domains', ref),
    add: (ref: TenantRef, params: BodyOf<'addTenantDomain'>) => this.#call('addTenantDomain', 'POST', '/v1/tenants/domains', ref, params),
    /** Removes a domain by name or by its id. */
    remove: (ref: TenantRef, domain: { domainName: string } | { domainId: string }) =>
      this.#call('removeTenantDomain', 'DELETE', '/v1/tenants/domains', { ...ref, ...domain }),
    setMain: (ref: TenantRef, domain: BodyOf<'setMainDomain'>) => this.#call('setMainDomain', 'PUT', '/v1/tenants/domains/main', ref, domain),
    /** Whether a domain is free to use as a store domain. */
    checkAvailability: (domain: string) => this.#call('checkDomainAvailability', 'GET', '/v1/tenants/domains/available', { domain }),
  };

  /** The store's own sending domain for email (not part of the WPCS contract). */
  readonly mailDomain = {
    /** The sending domain with the DNS records to add, or null when the store sends from the platform's address. */
    get: async (ref: TenantRef): Promise<MailDomain | null> =>
      (await this.#call('getTenantMailDomain', 'GET', '/v1/tenants/mail-domain', ref)).mailDomain ?? null,
    set: async (ref: TenantRef, domainName: string): Promise<MailDomain> =>
      (await this.#call('setTenantMailDomain', 'PUT', '/v1/tenants/mail-domain', ref, { domainName })).mailDomain,
    remove: (ref: TenantRef) => this.#call('removeTenantMailDomain', 'DELETE', '/v1/tenants/mail-domain', ref),
  };

  /** A link that adds a store's DNS records at the domain's DNS host, when it supports Domain Connect. */
  domainConnect(ref: TenantRef, domainName: string, service: 'website' | 'email'): Promise<DomainConnectLink> {
    return this.#call('getTenantDomainConnect', 'GET', '/v1/tenants/domain-connect', { ...ref, domainName, service });
  }

  readonly versions = {
    list: (query: QueryOf<'listVersions'> = {}) => this.#call('listVersions', 'GET', '/v1/versions', query),
    create: (params: BodyOf<'createVersion'>) => this.#call('createVersion', 'POST', '/v1/versions', undefined, params),
    delete: (versionId: string) => this.#call('deleteVersion', 'DELETE', '/v1/versions', { versionId }),
    /** New tenants are created on the production version unless they name another. */
    setProduction: (versionId: string) => this.#call('setProductionVersion', 'PUT', '/v1/versions/production', undefined, { versionId }),
  };

  readonly snapshots = {
    list: (query: QueryOf<'listSnapshots'> = {}) => this.#call('listSnapshots', 'GET', '/v1/snapshots', query),
    /** The snapshot's zip. */
    download: async (snapshotId: string): Promise<Blob> => {
      const response = await this.#send('downloadSnapshot', 'GET', '/v1/snapshots/download', { snapshotId });
      return response.blob();
    },
  };

  /** Base snapshots: templates new versions can start from. */
  readonly templates = {
    list: (query: QueryOf<'listBaseSnapshotsTemplates'> = {}) => this.#call('listBaseSnapshotsTemplates', 'GET', '/v1/basesnapshots', query),
    /** Registers a template and answers with a URL to upload its zip to. */
    create: (params: BodyOf<'createBaseSnapshotTemplateUpload'>) =>
      this.#call('createBaseSnapshotTemplateUpload', 'POST', '/v1/basesnapshots', undefined, params),
    delete: (id: string) => this.#call('deleteBaseSnapshot', 'DELETE', '/v1/basesnapshots', { id }),
  };

  /**
   * Polls the tenant until it is Done (resolves with it) or Failed (throws TenantFailedError).
   * Use after create, restore, moveToVersion and domain changes, which all return while the work is still scheduled.
   */
  async waitForTenant(
    ref: TenantRef,
    { intervalMs = 5_000, timeoutMs = 15 * 60_000, signal }: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Tenant> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const tenant = await this.tenants.get(ref);
      if (tenant?.statusCode === StatusCode.Done) return tenant;
      if (tenant?.statusCode === StatusCode.Failed) throw new TenantFailedError(tenant);
      if (Date.now() + intervalMs > deadline) throw new Error(`Timed out waiting for tenant ${ref.externalId ?? ref.tenantId}`);
      await sleep(intervalMs, signal);
    }
  }

  async #call<K extends OperationId>(operationId: K, method: Method, path: string, query?: Query, body?: unknown): Promise<ResultOf<K>> {
    const response = await this.#send(operationId, method, path, query, body);
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as ResultOf<K>;
  }

  async #send(operationId: string, method: Method, path: string, query?: Query, body?: unknown): Promise<Response> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) params.set(name, String(value));
    }
    const search = params.size ? `?${params}` : '';
    const headers: Record<string, string> = { Authorization: this.#authorization, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.#fetch(`${this.#baseUrl}${path}${search}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new WaasApiError(response.status, operationId, await errorMessage(response));
    return response;
  }
}

async function errorMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : null;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
