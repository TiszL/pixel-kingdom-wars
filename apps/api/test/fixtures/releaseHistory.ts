import { sql } from 'drizzle-orm';
import type { Db } from '../../src/db/client';

/** Release history refuses UPDATE/DELETE/TRUNCATE by design. Test isolation
 * disables only the user triggers inside one transaction, so no other session
 * ever observes the tables unguarded. */
export async function resetReleaseHistory(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE release_fragment_claims DISABLE TRIGGER USER`);
    await tx.execute(sql`ALTER TABLE release_history DISABLE TRIGGER USER`);
    await tx.execute(sql`TRUNCATE release_fragment_claims, release_history`);
    await tx.execute(sql`ALTER TABLE release_history ENABLE TRIGGER USER`);
    await tx.execute(sql`ALTER TABLE release_fragment_claims ENABLE TRIGGER USER`);
  });
}

export const sha = (char: string) => char.repeat(40);

export function fragment(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, category: 'new', platforms: 'all', title: `Title for ${id}`,
    body: 'A plain player-facing sentence about what changed.', ...overrides,
  };
}

export function identity(gitSha: string, overrides: Record<string, unknown> = {}) {
  return { gitSha, version: '0.5.8', simVersion: 17, builtAt: '2026-09-27T10:00:00Z', ...overrides } as {
    gitSha: string; version: string; simVersion: number; builtAt: string | null;
  };
}
