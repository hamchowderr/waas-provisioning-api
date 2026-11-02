import { createHash, createHmac } from 'node:crypto';

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

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding, as SigV4 wants it; `/` kept in paths. */
const encode = (s: string, keepSlash = false) => {
  const out = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? out.replace(/%2F/g, '/') : out;
};

const unescapeXml = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]!);

/**
 * The few S3 calls the Coolify driver and the database backups need (pre-signed URLs, put, list,
 * copy, head, get, delete), signed with AWS Signature V4. Works with R2, MinIO and AWS. Never logs
 * keys or signatures.
 */
export class S3 {
  private readonly url: URL;

  constructor(
    private readonly config: S3Config,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.url = new URL(config.endpoint);
    if (config.virtualHost) this.url.hostname = `${config.bucket}.${this.url.hostname}`;
  }

  /** Path-style: /<bucket>/<key>, or /<bucket> for bucket-level calls (key ''). Virtual-host: /<key>, or /. */
  private path(key: string) {
    const base = this.url.pathname.replace(/\/$/, '');
    const bucket = this.config.virtualHost ? base : `${base}/${encode(this.config.bucket)}`;
    if (key === '') return bucket || '/';
    return `${bucket}/${encode(key, true)}`;
  }

  private scope(date: string) {
    return `${date}/${this.config.region}/s3/aws4_request`;
  }

  private signingKey(date: string) {
    const kDate = hmac(`AWS4${this.config.secretAccessKey}`, date);
    return hmac(hmac(hmac(kDate, this.config.region), 's3'), 'aws4_request');
  }

  private stamp() {
    const amzDate = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return { amzDate, date: amzDate.slice(0, 8) };
  }

  /** A URL anyone can GET or PUT for `expiresIn` seconds. `extra` adds signed query parameters (a part's partNumber and uploadId). */
  presign(method: 'GET' | 'PUT', key: string, expiresIn = 900, extra: Record<string, string> = {}): string {
    const { amzDate, date } = this.stamp();
    const path = this.path(key);
    const query: Record<string, string> = {
      ...extra,
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKeyId}/${this.scope(date)}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresIn),
      'X-Amz-SignedHeaders': 'host',
    };
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${encode(k)}=${encode(query[k]!)}`)
      .join('&');
    const canonical = [method, path, canonicalQuery, `host:${this.url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', amzDate, this.scope(date), sha256(canonical)].join('\n');
    const signature = createHmac('sha256', this.signingKey(date)).update(toSign).digest('hex');
    return `${this.url.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
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
    const { amzDate, date } = this.stamp();
    const path = this.path(key);
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${encode(k)}=${encode(query[k]!)}`)
      .join('&');
    const all: Record<string, string> = { ...headers, host: this.url.host, 'x-amz-content-sha256': sha256(body ?? ''), 'x-amz-date': amzDate };
    const names = Object.keys(all).map((h) => h.toLowerCase()).sort();
    const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), v.trim()]));
    const signedHeaders = names.join(';');
    const canonical = [method, path, canonicalQuery, names.map((h) => `${h}:${lower[h]}\n`).join(''), signedHeaders, lower['x-amz-content-sha256']].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', amzDate, this.scope(date), sha256(canonical)].join('\n');
    const signature = createHmac('sha256', this.signingKey(date)).update(toSign).digest('hex');
    const { host: _host, ...sent } = lower;
    return this.fetchImpl(`${this.url.origin}${path}${canonicalQuery ? `?${canonicalQuery}` : ''}`, {
      method,
      body: body as BodyInit | undefined,
      headers: {
        ...sent,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${this.scope(date)}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    });
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
