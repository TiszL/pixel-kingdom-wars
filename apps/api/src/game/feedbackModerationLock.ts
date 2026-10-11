import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';

/** Link, issue and reward writers serialize before locking individual rows. */
export async function lockFeedbackModeration(tx: DbOrTx) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('feedback-moderation', 0))`);
}
