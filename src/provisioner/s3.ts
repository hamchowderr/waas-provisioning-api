import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';

export interface S3Config {
  /** e.g. https://<account>.r2.cloudflarestorage.com or a MinIO URL. Path-style addressing unless virtualHost. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Address the bucket as a subdomain of the endpoint (<bucket>.<host>/<key>). R2 answers
   * AccessDenied to a bucket-scoped token on path-style requests, so the releases bucket uses this.
   */
  virtualHost?: boolean;
}

/** RFC 3986 encoding for keys in URLs; `/` kept in paths. */
const encode = (s: string, keepSlash = false) => {
  const out = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? out.replace(/%2F/g, '/') : out;
};

const unescapeXml = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]!);

/**
 * The few S3 calls the Coolify driver and the database backups need (pre-signed URLs, put, list,
 * copy, head, get, delete). aws4fetch (the signer Cloudflare's R2 docs use) does the AWS Signature V4
 * signing. Works with R2, MinIO and AWS. Never logs keys or signatures.
 */
export class S3 {
  private readonly url: URL;
  private readonly client: AwsClient;

  constructor(
    private readonly config: S3Config,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.url = new URL(config.endpoint);
    if (config.virtualHost) this.url.hostname = `${config.bucket}.${this.url.hostname}`;
    this.client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: 's3', region: config.region, retries: 0 });
  }

  /** Path-style: /<bucket>/<key>, or /<bucket> for bucket-level calls (key ''). Virtual-host: /<key>, or /. */
  private path(key: string) {
    const base = this.url.pathname.replace(/\/$/, '');
    const bucket = this.config.virtualHost ? base : `${base}/${encode(this.config.bucket)}`;
    if (key === '') return bucket || '/';
    return `${bucket}/${encode(key, true)}`;
  }

  /** The signing time, as SigV4 writes it (20260107T010203Z). */
  private datetime() {
    return this.now().toISOString().replace(/[-:]|\.\d{3}/g, '');
  }

  private target(key: string, query: Record<string, string>) {
    const url = new URL(`${this.url.origin}${this.path(key)}`);
    for (const k of Object.keys(query).sort()) url.searchParams.set(k, query[k]!);
    return url.toString();
  }

  /** A URL anyone can GET or PUT for `expiresIn` seconds. `extra` adds signed query parameters (a part's partNumber and uploadId). */
  async presign(method: 'GET' | 'PUT', key: string, expiresIn = 900, extra: Record<string, string> = {}): Promise<string> {
    const signed = await this.client.sign(this.target(key, { ...extra, 'X-Amz-Expires': String(expiresIn) }), {
      method,
      aws: { signQuery: true, datetime: this.datetime() },
    });
    return signed.url;
  }

  /** A public-looking reference to an object, for `uri` fields. Not fetchable without signing. */
  objectUrl(key: string): string {
    return `${this.url.origin}${this.path(key)}`;
  }

  private async request(
    method: string,
    key: string,
    headers: Record<string, string> = {},
    { body, query = {} }: { body?: Uint8Array; query?: Record<string, string> } = {},
  ): Promise<Response> {
    // The body's hash is signed too (aws4fetch would send UNSIGNED-PAYLOAD), so the bucket rejects a changed body.
    const payloadHash = createHash('sha256').update(body ?? '').digest('hex');
    const signed = await this.client.sign(this.target(key, query), {
      method,
      headers: { ...headers, 'x-amz-content-sha256': payloadHash },
      body: body as BodyInit | undefined,
      aws: { datetime: this.datetime() },
    });
    return this.fetchImpl(signed.url, { method, body: body as BodyInit | undefined, headers: Object.fromEntries(signed.headers) });
  }

  private static async check(res: Response, what: string) {
    if (res.ok) return;
    // The error's <Code> (AccessDenied, SignatureDoesNotMatch, InvalidAccessKeyId, ...) says which
    // setting is wrong. Only the code: other fields of the body can echo the request.
    const code = /<Code>([A-Za-z]{1,64})<\/Code>/.exec(await res.text().catch(() => ''))?.[1];
    throw new Error(`S3 ${what} failed: HTTP ${res.status}${code ? ` ${code}` : ''}`);
  }

  /** Size in bytes, or null when the object does not exist. */
  async head(key: string): Promise<number | null> {
    const res = await this.request('HEAD', key);
    if (res.status === 404) return null;
    await S3.check(res, `HEAD ${key}`);
    return Number(res.headers.get('content-length') ?? 0);
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.request('GET', key);
    await S3.check(res, `GET ${key}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Bytes start..end (inclusive) of the object. */
  async getRange(key: string, start: number, end: number): Promise<Uint8Array> {
    const res = await this.request('GET', key, { range: `bytes=${start}-${end}` });
    await S3.check(res, `GET ${key}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** The object's bytes, or null when it does not exist. */
  async getIfExists(key: string): Promise<Uint8Array | null> {
    const res = await this.request('GET', key);
    if (res.status === 404) return null;
    await S3.check(res, `GET ${key}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async put(key: string, body: Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    const res = await this.request('PUT', key, { 'content-type': contentType }, { body });
    await S3.check(res, `PUT ${key}`);
  }

  /** Every object under `prefix` (ListObjectsV2, all pages). */
  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const objects: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
      const res = await this.request('GET', '', {}, { query });
      await S3.check(res, `list ${prefix}`);
      const xml = await res.text();
      for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(entry!)?.[1];
        if (key !== undefined) objects.push({ key: unescapeXml(key), size: Number(/<Size>(\d+)<\/Size>/.exec(entry!)?.[1] ?? 0) });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unescapeXml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') || undefined : undefined;
    } while (token);
    return objects;
  }

  async copy(sourceKey: string, targetKey: string): Promise<void> {
    const res = await this.request('PUT', targetKey, { 'x-amz-copy-source': `/${encode(this.config.bucket)}/${encode(sourceKey, true)}` });
    await S3.check(res, `copy to ${targetKey}`);
  }

  /** Starts a multipart upload to `key`; answers its upload id. Parts are PUT to presign('PUT', key, s, { partNumber, uploadId }). */
  async createMultipart(key: string, contentType = 'application/octet-stream'): Promise<string> {
    const res = await this.request('POST', key, { 'content-type': contentType }, { query: { uploads: '' } });
    await S3.check(res, `start upload of ${key}`);
    const id = /<UploadId>([\s\S]*?)<\/UploadId>/.exec(await res.text())?.[1];
    if (!id) throw new Error(`S3 start upload of ${key} failed: no UploadId`);
    return unescapeXml(id);
  }

  /** The parts uploaded so far, in order, or null when the upload is unknown (finished, aborted or never started). */
  async listParts(key: string, uploadId: string): Promise<{ number: number; size: number; etag: string }[] | null> {
    const parts: { number: number; size: number; etag: string }[] = [];
    let marker: string | undefined;
    do {
      const res = await this.request('GET', key, {}, { query: { uploadId, ...(marker ? { 'part-number-marker': marker } : {}) } });
      if (res.status === 404) return null;
      await S3.check(res, `list parts of ${key}`);
      const xml = await res.text();
      for (const [, part] of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
        parts.push({
          number: Number(/<PartNumber>(\d+)<\/PartNumber>/.exec(part!)?.[1] ?? 0),
          size: Number(/<Size>(\d+)<\/Size>/.exec(part!)?.[1] ?? 0),
          etag: unescapeXml(/<ETag>([\s\S]*?)<\/ETag>/.exec(part!)?.[1] ?? ''),
        });
      }
      marker = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextPartNumberMarker>(\d+)<\/NextPartNumberMarker>/.exec(xml)?.[1] : undefined;
    } while (marker);
    return parts.sort((a, b) => a.number - b.number);
  }

  /** Joins the parts into the object at `key`. */
  async completeMultipart(key: string, uploadId: string, parts: { number: number; etag: string }[]): Promise<void> {
    const xml = `<CompleteMultipartUpload>${parts
      .map((p) => `<Part><PartNumber>${p.number}</PartNumber><ETag>${p.etag.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</ETag></Part>`)
      .join('')}</CompleteMultipartUpload>`;
    const res = await this.request('POST', key, { 'content-type': 'application/xml' }, { body: new TextEncoder().encode(xml), query: { uploadId } });
    await S3.check(res, `finish upload of ${key}`);
    // S3 can answer 200 with an error in the body when joining fails late.
    const code = /<Error>[\s\S]*?<Code>([A-Za-z]{1,64})<\/Code>/.exec(await res.text())?.[1];
    if (code) throw new Error(`S3 finish upload of ${key} failed: ${code}`);
  }

  /** Throws away an unfinished multipart upload and its parts. An unknown upload succeeds. */
  async abortMultipart(key: string, uploadId: string): Promise<void> {
    const res = await this.request('DELETE', key, {}, { query: { uploadId } });
    if (res.status === 404) return;
    await S3.check(res, `abort upload of ${key}`);
  }

  /** Creates the bucket (for MinIO and tests; R2 buckets are made in the dashboard). Succeeds if it exists. */
  async createBucket(): Promise<void> {
    const res = await this.request('PUT', '');
    if (res.status === 409) return; // BucketAlreadyOwnedByYou
    await S3.check(res, 'create bucket');
  }

  /** Deleting a missing object succeeds, as in S3. */
  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', key);
    if (res.status === 404) return;
    await S3.check(res, `DELETE ${key}`);
  }
}
