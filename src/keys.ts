import { randomBytes, randomUUID, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { Pool } from './db.ts';

// Secrets are stored as scrypt hashes: "scrypt$N$r$p$<salt b64>$<hash b64>".
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

function scryptAsync(secret: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(secret, salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(secret, salt, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(secret, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Hashed once so an unknown key costs the same time as a wrong secret.
const dummyHash = hashSecret(randomUUID());

/** Creates an API key for a product. The secret is returned once and only its hash is kept. */
export async function createApiKey(pool: Pool, productId: string, label?: string): Promise<{ key: string; secret: string }> {
  const secret = randomBytes(32).toString('base64url');
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO api_keys (product_id, secret_hash, label) VALUES ($1, $2, $3) RETURNING id',
    [productId, await hashSecret(secret), label ?? null],
  );
  return { key: rows[0]!.id, secret };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns the product the key belongs to, or null when the key or secret is wrong. */
export async function authenticate(pool: Pool, key: string, secret: string): Promise<string | null> {
  const { rows } = UUID.test(key)
    ? await pool.query<{ product_id: string; secret_hash: string }>(
        'SELECT product_id, secret_hash FROM api_keys WHERE id = $1 AND revoked_at IS NULL',
        [key],
      )
    : { rows: [] };
  const row = rows[0];
  const ok = await verifySecret(secret, row?.secret_hash ?? (await dummyHash));
  return ok && row ? row.product_id : null;
}
