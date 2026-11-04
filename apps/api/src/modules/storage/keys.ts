/**
 * Key validation shared by the storage drivers. A driver only ever accepts the
 * key shapes the database allows:
 *   tenants/<uuid>/users/<uuid>/attachments/<uuid>   (attachments_storage_key_format)
 *   tenants/<uuid>/users/<uuid>/evidence/<uuid>      (evidence_artifacts_storage_key_format, 0005)
 * so a key can never be absolute, contain "..", or point outside the tenant's
 * prefix, whatever a caller passes.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY = new RegExp(`^tenants/${UUID}/users/${UUID}/(?:attachments|evidence)/${UUID}$`);

export function isValidStorageKey(key: string): boolean {
  return KEY.test(key);
}

/** Throws (a programming error, not a storage failure) for a key outside the allowed shape. */
export function assertStorageKey(key: string): void {
  if (!isValidStorageKey(key)) throw new Error('Invalid storage key');
}

/** Hex SHA-256 → base64 (S3 ChecksumSHA256 wants base64). */
export function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}
