/** Normal collection keeps the existing client contract. Only new prospective
 * source authority and closed historical repair are prepared outside collection
 * locks; the collector independently validates committed source evidence. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ReviewedSeekerSourcePolicy, SeekerTermRpc } from '@shardkeep/chain/seeker-terms';
import { multiBaseEnabled, phaseEMiningEnabled } from '../config';
import type { Db } from '../db/client';
import { assertFreshLockedBaseAuthority, lockActiveBase, requireFreshBaseAuthority } from '../game/baseOwnership';
import type { FinalizedDeedReader } from '../game/baseOwnership';
import { prefetchCurrentExpeditionTermReader } from '../game/expeditionCurrentTermReader';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { admitPhysicalMineTaxSources, physicalMinesNeedingTaxSource } from './shardsTaxMineSources';
import type { PhysicalMineRecoveryProvider } from './shardsTaxMineRecoveryProvider';

export interface PhysicalMineSourceProvider {
  readonly policy: ReviewedSeekerSourcePolicy;
  readonly connect: (signal: AbortSignal) => SeekerTermRpc;
}
const body = z.object({ baseId: z.uuid().optional() });
export function registerShardsTaxMineGameplay(app: FastifyInstance, db: Db, deps: {
  provider?: PhysicalMineSourceProvider | null;
  recoveryProvider?: PhysicalMineRecoveryProvider | null;
  finalizedDeedReader: () => FinalizedDeedReader | null;
  deedCollection?: string | null;
}): void {
  app.addHook('onRoute', options => {
    if (options.url !== '/mine/collect' || options.method !== 'POST') return;
    const previous = options.preHandler ? (Array.isArray(options.preHandler) ? options.preHandler : [options.preHandler]) : [];
    options.preHandler = [...previous, async req => {
      if (!multiBaseEnabled() || !phaseEMiningEnabled() || (!deps.provider && !deps.recoveryProvider)) return;
      // No boundary installation is implicit in a collect. Without its durable
      // witness the existing explicit prototype admission stays unchanged.
      const [policy] = await db.execute(sql`select id from shards_mine_policy_boundary where id=1`);
      if (!policy) return;
      const command = parse(body, req.body ?? {});
      const baseId = (await db.transaction(tx => lockActiveBase(tx, req.wallet, command.baseId))).base.id;
      // The unchanged handler must consume this same resolved selection after
      // prefetch, including clients that omitted their sole active base ID.
      req.body = { baseId };
      const attempted = new Set<string>();
      const recoverOriginals = async (): Promise<boolean> => {
        if (!deps.recoveryProvider || attempted.size >= 16) return true;
        // A whole interval must be observed before it can be repaired, including
        // the millisecond after its last completion. Custody still decides proof.
        const closedBefore = new Date();
        const candidates = async (connection: Parameters<typeof lockActiveBase>[0] | Db) =>
          connection.execute<{id: string}>(sql`select id from shards_mine_segments
            where base_id=${baseId} and wallet is not null and admission_id is null
              and recovery_parent_id is null and buffer=gross and gross>0
              and reserved=0 and issued=0 and discarded=0 and resolved=0
              and ends_at<${closedBefore.toISOString()}::timestamptz
              ${attempted.size ? sql`and id not in (${sql.join([...attempted].map(id => sql`${id}::uuid`), sql`, `)})` : sql``}
            order by starts_at,id limit ${16 - attempted.size}`);
        if (!(await candidates(db)).length) return true;
        await requireFreshBaseAuthority(db, req.wallet, baseId, deps.finalizedDeedReader(), deps.deedCollection ?? null);
        const originals = await db.transaction(async tx => {
          await lockActiveBase(tx, req.wallet, baseId);
          await assertFreshLockedBaseAuthority(tx, req.wallet, baseId);
          return candidates(tx);
        });
        for (const original of originals) {
          if (!phaseEMiningEnabled()) return false;
          // This is one shared execution bound across both passes, not an
          // earning limit. A later tap can finish any remaining parents.
          attempted.add(original.id);
          try { await deps.recoveryProvider.recover(original.id); }
          catch (error) {
            if (error instanceof HttpError && error.code === 'PHASE_E_DISABLED') return false;
            throw new HttpError(503, 'Original Mine earnings are unavailable; retry collection', 'SHARDS_MINE_RESOLUTION_HELD');
          }
        }
        return true;
      };
      if (!await recoverOriginals()) return;
      const captureOriginals = async (): Promise<void> => {
        const capture = deps.recoveryProvider?.captureOriginal ?? deps.recoveryProvider?.captureFull;
        if (!capture || !phaseEMiningEnabled()) return;
        await requireFreshBaseAuthority(db, req.wallet, baseId, deps.finalizedDeedReader(), deps.deedCollection ?? null);
        try { await capture(req.wallet, baseId); }
        catch (error) {
          if (error instanceof HttpError && error.code === 'PHASE_E_DISABLED') return;
          if (error instanceof HttpError) throw error;
          throw new HttpError(503, 'Original Mine production is unavailable; retry collection', 'SHARDS_MINE_CAPTURE_HELD');
        }
        await recoverOriginals();
      };
      if (!deps.provider) { await captureOriginals(); return; }
      if (!(await physicalMinesNeedingTaxSource(db, req.wallet, baseId, new Date())).length) return;
      await requireFreshBaseAuthority(db, req.wallet, baseId, deps.finalizedDeedReader(), deps.deedCollection ?? null);
      let reader;
      try { reader = await prefetchCurrentExpeditionTermReader(deps.provider.connect, deps.provider.policy); }
      catch {
        // The collector can still pay covered old history. Its durable source
        // guard holds every uncovered whole unit; failure grants no exemption.
        await captureOriginals();
        return;
      }
      // Term verification may outlive the deed proof. Refresh outside gameplay
      // locks, then retain admission's final locked authority check as well.
      await requireFreshBaseAuthority(db, req.wallet, baseId, deps.finalizedDeedReader(), deps.deedCollection ?? null);
      try {
        await admitPhysicalMineTaxSources(db, req.wallet, { idempotencyKey: randomUUID(), baseId }, {
          baseId, assertAuthority: async (tx, wallet, id) => { await assertFreshLockedBaseAuthority(tx, wallet, id); },
        }, { reader, onlyMissing: true });
      } catch (error) {
        if (error instanceof HttpError) {
          if (error.code === 'PHASE_E_DISABLED') return;
          throw error;
        }
        throw new HttpError(503, 'Physical Mine source is unavailable; retry collection', 'SHARDS_SOURCE_UNAVAILABLE');
      }
      // Successful admission already projected only missing Mines once. Repair
      // its newly captured originals before the unchanged collector runs.
      if (!await recoverOriginals()) return;
    }];
  });
}
