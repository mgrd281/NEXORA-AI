import { hash, verify } from '@node-rs/argon2';

// OWASP Password Storage Cheat Sheet (2025): argon2id, m=19 MiB, t=2, p=1 minimum.
// algorithm 2 = Argon2id (const enum in @node-rs/argon2 typings; inlined for verbatimModuleSyntax).
const OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const MIN_PASSWORD_LENGTH = 12;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// A real hash of a random string, verified when the email is unknown so that
// response time does not reveal whether an account exists.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(`dummy-${Math.random()}`);
  await verifyPassword(await dummyHash, password);
}
