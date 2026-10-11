/**
 * DEVNET PLAYTEST ONLY — in-game devnet SOL faucet routes (owner 2026-08-22).
 *   GET  /devnet-faucet/status   eligibility + last grant for the signed-in wallet
 *   POST /devnet-faucet/claim    record a grant request (the worker pays it)
 * Both sit behind the normal session + playtest gate. The API holds no key: it
 * only reads the wallet's balance and writes the request row. See
 * money/devnetFaucet.ts for the removal checklist.
 */
import type { FastifyInstance } from 'fastify';
import { Connection } from '@solana/web3.js';
import type { Config } from './config';
import type { Db } from './db/client';
import { devnetFaucetStatus, requestDevnetFaucetGrant, type FaucetPolicy } from './money/devnetFaucet';

export function registerDevnetFaucetRoutes(
  app: FastifyInstance, config: Config, db: Db,
  deps: { connection?: Connection | null } = {},
): void {
  const policy: FaucetPolicy = { enabled: config.DEVNET_FAUCET_ENABLED === 'true', cluster: config.SOLANA_CLUSTER };
  // Balance reads only; no key. Tests inject null (no RPC) or a fake connection.
  const connection = deps.connection === undefined
    ? (policy.enabled && config.NODE_ENV !== 'test' ? new Connection(config.SOLANA_RPC_URL, 'confirmed') : null)
    : deps.connection;
  const claimLimit = { config: { rateLimit: { max: 6, timeWindow: 60_000 } } };

  app.get('/devnet-faucet/status', { preHandler: app.authenticate }, async (req) =>
    devnetFaucetStatus(db, policy, connection, req.wallet));

  app.post('/devnet-faucet/claim', { preHandler: app.authenticate, ...claimLimit }, async (req) =>
    requestDevnetFaucetGrant(db, policy, connection, req.wallet));
}
