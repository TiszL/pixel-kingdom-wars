/** Private composition capability only. No HTTP/AppDeps, signer, scheduler,
 * reset or release. Defining this surface grants no operational abort approval. */
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { abortMiningContributions } from '../game/miningContributions';
import type { MiningPublicationJobResult } from './publicationJob';

const boundedText = z.string().min(8).max(128).refine(value => value.trim() === value);
const commandSchema = z.object({ epochId: z.uuid(), day: z.iso.date(),
  decisionKey: boundedText, reason: boundedText }).strict();
export type MiningPublicationAbortCommand = z.infer<typeof commandSchema>;
export type MiningPublicationAbortAuthorization = Readonly<MiningPublicationAbortCommand & { operator: string }>;
export interface MiningPublicationOperatorOptions {
  readonly enabled?: boolean;
  readonly testerStack?: boolean;
  readonly cluster: 'devnet' | 'mainnet-beta';
  readonly operator: PublicKey;
  readonly job: { getLastResult(): MiningPublicationJobResult | null };
  /** Captured application-owned authorization for this exact command. A public
   * identity in an incoming command can never supply this capability. */
  readonly authorizeAbort?: (command: MiningPublicationAbortAuthorization) => Promise<boolean>;
}
type Code = 'DISABLED' | 'INVALID_INPUT' | 'NOT_ABORT_PROPOSED' | 'AUTHORIZATION_DENIED'
  | 'OWNER_REQUIRED' | 'SOURCE_CONFLICT' | 'ATTEMPT_FENCED';
export class MiningPublicationOperatorError extends Error {
  constructor(readonly code: Code) { super(`Mining publication operator refused: ${code}`); this.name = 'MiningPublicationOperatorError'; }
}
function fail(code: Code): never { throw new MiningPublicationOperatorError(code); }

export function createMiningPublicationOperator(db: Db, options: MiningPublicationOperatorOptions) {
  const enabled = options.enabled === true;
  if (enabled && (options.cluster !== 'devnet' || options.testerStack !== true)) {
    throw Error('Mining publication operator requires an explicit devnet tester stack');
  }
  let operator: string;
  try {
    const key = new PublicKey(options.operator.toBytes());
    if (key.equals(PublicKey.default)) throw Error();
    operator = key.toBase58();
  } catch { throw Error('Mining publication operator requires an explicit public identity'); }
  if (!options.job || typeof options.job.getLastResult !== 'function') throw Error('Mining publication operator requires private job observation');
  const lastResult = options.job.getLastResult.bind(options.job), authorize = options.authorizeAbort;
  if (enabled && typeof authorize !== 'function') throw Error('Mining publication operator requires an application-owned authorization capability');

  function proposed(command: MiningPublicationAbortCommand) {
    const last = lastResult();
    if (last?.status !== 'held' || last.reason !== 'ABORT_PROPOSED'
        || last.epochId !== command.epochId || !('day' in last) || last.day !== command.day) fail('NOT_ABORT_PROPOSED');
  }
  function read() {
    const last = lastResult();
    return Object.freeze({ operator, lastResult: last === null ? null : Object.freeze({ ...last }) });
  }
  async function abortProposed(value: MiningPublicationAbortCommand) {
    if (!enabled) fail('DISABLED');
    const parsed = commandSchema.safeParse(value); if (!parsed.success) fail('INVALID_INPUT');
    const command = Object.freeze(parsed.data); proposed(command);
    let approved: boolean;
    try { approved = await authorize!(Object.freeze({ ...command, operator })); }
    catch { fail('AUTHORIZATION_DENIED'); }
    if (approved !== true) fail('AUTHORIZATION_DENIED');
    proposed(command);
    const [owner] = await db.execute<{ allowed: boolean }>(sql`select current_user=session_user and not exists(
      select 1 from pg_class where oid in ('public.mining_ingot_epochs'::regclass,'public.mining_ingot_aborts'::regclass,
        'public.mining_contribution_receipts'::regclass,'public.mining_contribution_terminals'::regclass,
        'public.mining_publication_attempts'::regclass) and relowner<>current_user::regrole::oid) allowed`);
    if (!owner?.allowed) fail('OWNER_REQUIRED');
    const keys = [`resource-mining-v2:${command.day}`, `resource-mining-v3:${command.day}`];
    const [epoch] = await db.execute<{ epochKey: string; attempted: boolean }>(sql`select e.epoch_key "epochKey",
      exists(select 1 from mining_publication_attempts a where a.epoch_id=e.id) attempted
      from mining_ingot_epochs e where e.id=${command.epochId} and e.epoch_key in (${keys[0]},${keys[1]})`);
    if (!epoch || !keys.includes(epoch.epochKey)) fail('SOURCE_CONFLICT');
    if (epoch.attempted !== false) fail('ATTEMPT_FENCED');
    proposed(command);
    // This preflight is not the race authority. The existing abort transaction
    // locks the epoch, and 0168's aaa_mining_publication_fence rejects any durable
    // attempt atomically. Preserve that refusal; never substitute another path.
    await abortMiningContributions(db, { epochId: command.epochId, decisionKey: command.decisionKey, reason: command.reason });
    return Object.freeze({ status: 'aborted' as const, epochId: command.epochId, day: command.day, decisionKey: command.decisionKey });
  }
  return Object.freeze({ read, abortProposed });
}
