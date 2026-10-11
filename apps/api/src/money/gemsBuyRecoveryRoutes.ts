import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import { deposits } from '../db/schema';
import { parse } from '../lib/validation';
import { gemsBuyDisclosure, originalGemsBuyIntent } from './gemsBuyReceipt';

/** Recover a lost intent response by its original key, including during a
 * feature pause. This read never admits a payment or consults live reserve config. */
export function registerGemsBuyRecoveryRoutes(app: FastifyInstance, db: Db): void {
  app.get('/gems/buy/by-key/:key', {
    preHandler: app.authenticate,
    onSend: async (_req, reply, payload) => { reply.header('Cache-Control', 'private, no-store'); return payload; },
  }, async (req) => {
    const { key } = parse(z.object({ key: z.string().min(8).max(128) }), req.params);
    const envelope = { version: 1 as const, wallet: req.wallet, idempotencyKey: key,
      recoveryOnly: true as const, expiredPaymentRecovery: 1 as const, serverNow: new Date().toISOString() };
    const [row] = await db.select().from(deposits).where(and(eq(deposits.playerWallet, req.wallet),
      eq(deposits.kind, 'gems_buy'), sql`${deposits.payload}->>'idempotencyKey' = ${key}`));
    if (!row) return { ...envelope, status: 'unknown' as const, deposit: null };
    return { ...envelope, status: 'known' as const, deposit: {
      originalIntent: originalGemsBuyIntent(row), status: row.status,
      txSignature: row.txSignature, paymentSignature: row.paymentSignature,
      amount: row.amount?.toString() ?? null, createdAt: row.createdAt.toISOString(),
      finalizedAt: row.finalizedAt?.toISOString() ?? null, ...await gemsBuyDisclosure(db, row),
    } };
  });
}
