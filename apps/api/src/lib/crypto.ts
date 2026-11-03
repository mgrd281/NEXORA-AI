import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** 256-bit opaque token, URL-safe. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Deterministic JSON serialisation (sorted keys) so that hashes of structurally
 * equal objects are equal. Used for approval action hashes and idempotency.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

export function hashObject(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * AES-256-GCM envelope: [version(1) | iv(12) | tag(16) | ciphertext].
 * Key rotation: the key id is stored next to the ciphertext (connections.secret_key_id).
 */
export class SecretBox {
  private readonly key: Buffer;
  constructor(
    keyBase64: string,
    readonly keyId: string,
  ) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
  }

  seal(plaintext: string, aad: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]);
  }

  open(envelope: Buffer, aad: string): string {
    if (envelope[0] !== 1) throw new Error('Unsupported secret envelope version');
    const iv = envelope.subarray(1, 13);
    const tag = envelope.subarray(13, 29);
    const ct = envelope.subarray(29);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}
