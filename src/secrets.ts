import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Values the store needs back in plain form (the first user's password, private PHP constants)
 * cannot be hashed, so they are encrypted at rest with AES-256-GCM under SECRETS_KEY.
 * Format: "v1:<iv b64>:<tag b64>:<ciphertext b64>".
 */
export class Secrets {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64-encoded');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
  }

  decrypt(stored: string): string {
    const [version, iv, tag, ciphertext] = stored.split(':');
    if (version !== 'v1' || !iv || !tag || ciphertext === undefined) throw new Error('Not an encrypted value');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
}
