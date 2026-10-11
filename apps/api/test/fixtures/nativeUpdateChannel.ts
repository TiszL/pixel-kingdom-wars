import { sql } from 'drizzle-orm';
import type { Db } from '../../src/db/client';

/** The channel refuses DELETE/TRUNCATE by design. Test isolation disables only
 * the user triggers inside one transaction, so no other session ever observes
 * the table unguarded. */
export async function resetNativeUpdateChannel(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE native_update_channel DISABLE TRIGGER USER`);
    await tx.execute(sql`TRUNCATE native_update_channel`);
    await tx.execute(sql`ALTER TABLE native_update_channel ENABLE TRIGGER USER`);
  });
}

export const hex = (char: string, length: number) => char.repeat(length);
export const SIGNER = hex('5', 64);

/** A valid operator manifest; each code gets a distinct sha256 by default. */
export function manifest(versionCode: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    versionCode, versionName: `0.5.${versionCode}`, sourceCommit: hex('c', 40),
    sha256: versionCode.toString(16).padStart(64, 'a'), sizeBytes: 225_576_834, signerSha256: SIGNER,
    channel: 'tester', createdBy: 'test-operator', ...overrides,
  };
}
