/** Authenticated B4 raw-resource claims. Mount separately behind the existing
 * Phase E ownership fence; historic recovery works while admission is paused. */
import type { FastifyInstance } from 'fastify';
import { TWOFA } from '@shardkeep/shared';
import { z } from 'zod';
import { SeekerResourceEntitlementQuerySchema } from '@shardkeep/shared/seekerResourceClaimsApi';
import { readSeekerResourceEntitlements } from './seekerResourceEntitlements';
import type { Db } from '../db/client';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { assertFreshLockedBaseAuthority, requireFreshBaseAuthority } from './baseOwnership';
import { claimSeekerResourceTax, readSeekerResourceClaim, SeekerResourceClaimRequestSchema, seekerResourceClaimsEnabled } from './seekerResourceClaims';
import type { SeekerResourceClaimProvider } from './seekerResourceClaimProvider';
import type { WorkshopRouteDeps } from './workshopRoutes';

export function registerSeekerResourceClaimRoutes(app: FastifyInstance, db: Db, deps: WorkshopRouteDeps = {}, provider?: SeekerResourceClaimProvider | null) {
 const capability = provider ? Object.freeze({entitlements:provider.entitlements.bind(provider),history:provider.history.bind(provider),claim:provider.claim.bind(provider)}) : null;
 const history = (wallet:string,key:string) => capability ? capability.history(wallet,key) : readSeekerResourceClaim(db,wallet,key);
 const auth = { preHandler: [app.authenticate], onSend: async (_request: unknown, reply: { header: (name: string, value: string) => unknown }, payload: unknown) => {
  reply.header('Cache-Control', 'private, no-store'); return payload;
 } };
 app.get('/seeker/resource-claims', auth, async req =>
  capability ? capability.entitlements(req.wallet, parse(SeekerResourceEntitlementQuerySchema, req.query)) : readSeekerResourceEntitlements(db, req.wallet, parse(SeekerResourceEntitlementQuerySchema, req.query)));
 app.get('/seeker/resource-claims/by-key/:key', auth, async req => {
  const { key } = parse(z.object({ key: z.string().uuid() }).strict(), req.params);
  return { wallet: req.wallet, receipt: await history(req.wallet, key) };
 });
 app.post('/seeker/resource-claims', { ...auth, config: { rateLimit: { max: TWOFA.verifyRateLimitPerMin, timeWindow: 60_000 } } }, async (req, reply) => {
  const body = parse(SeekerResourceClaimRequestSchema, req.body);
  const prior = await history(req.wallet, body.idempotencyKey);
  if (!prior && !capability) {
   if (!seekerResourceClaimsEnabled()) throw new HttpError(503, 'Seeker resource claims are paused', 'PHASE_E_DISABLED');
   await requireFreshBaseAuthority(db, req.wallet, body.baseId, deps.market?.finalizedDeedReader ?? null, deps.market?.deedCollection ?? null);
  }
  const receipt = capability ? await capability.claim(req.wallet,body) : await claimSeekerResourceTax(db, req.wallet, body, { baseId: body.baseId,
   assertAuthority: async (tx, wallet, baseId) => { await assertFreshLockedBaseAuthority(tx, wallet, baseId); } });
  if (receipt.wallet !== req.wallet) throw new HttpError(404, 'claim not found');
  return reply.status(prior ? 200 : 201).send({ wallet: req.wallet, receipt });
 });
}
