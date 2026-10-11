/** Actual funded original/custody/inventory; synthetic bytes pass through the
 * real ten-account B6m reader. Nothing supplies a verified observation flag. */
import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { expect, vi } from 'vitest';
import { createCharterCreationPolicyAdmission } from '../../src/game/clanCharterCreationPolicyAdmission';
import { charterCreationTerminalFixture, terminalBank, TERMINAL_CLOCK } from './charterCreationTerminal';
import type { CharterCreationPermitInventory } from '../../src/game/clanCharterCreationPermitInventory';
export { postgresLeaf, sha } from './charterPermitInventory';

export const policyRefusal = (suffix: string) => ({ code: 'CLAN_CHARTER_POLICY_' + suffix });
export const noPolicyAuthority = { transactionProofVerified: false, signingAuthorized: false, mintAuthorized: false,
  paymentAuthorized: false, activationAuthorized: false, refundAuthorized: false, reservationReleaseAuthorized: false };
export const outcome = <T>(work: Promise<T>) => work.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
export function policyBank(saved: CharterCreationPermitInventory) {
  const bank = terminalBank(saved), current = Keypair.generate().publicKey, previous = Keypair.generate().publicKey;
  const admin = Keypair.generate().publicKey, guardian = Keypair.generate().publicKey;
  const economy = new PublicKey(saved.reservation.consent.chain.economyProgram);
  const [address, bump] = PublicKey.findProgramAddressSync([Buffer.from('seeker_authority')], economy);
  const row = { address, owner: economy, executable: false, data: Buffer.alloc(213) };
  const offsets: Record<string, number> = {};
  function authority(options: { paused?: boolean; priorGrace?: boolean } = {}) {
    const pieces: Buffer[] = [createHash('sha256').update('account:SeekerAuthority').digest().subarray(0, 8), Buffer.of(1)];
    const put = (name: string, bytes: Buffer) => { offsets[name] = pieces.reduce((sum, item) => sum + item.length, 0); pieces.push(bytes); };
    put('admin', admin.toBuffer()); put('pending', Buffer.of(0)); put('guardian', guardian.toBuffer());
    put('current', current.toBuffer()); put('previousTag', Buffer.of(options.priorGrace ? 1 : 0));
    if (options.priorGrace) put('previous', previous.toBuffer());
    const deadline = Buffer.alloc(8); deadline.writeBigInt64LE(options.priorGrace ? TERMINAL_CLOCK + 100n : 0n);
    put('deadline', deadline); put('genesis', new PublicKey(saved.reservation.consent.chain.genesisHash).toBuffer());
    put('paused', Buffer.of(options.paused ? 1 : 0)); put('bump', Buffer.of(bump));
    row.data.fill(0); Buffer.concat(pieces).copy(row.data);
  }
  authority(); bank.rows.push(row);
  return { ...bank, current, previous, authority, row, offsets,
    chain: { connect: bank.connect, trust: bank.trust, expectedCurrentSigner: current.toBase58() } };
}
export function pausePolicyBank(bank: ReturnType<typeof policyBank>) {
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = bank.rpc.getMultipleAccountsInfoAndContext.bind(bank.rpc);
  bank.rpc.getMultipleAccountsInfoAndContext = vi.fn(async (addresses, options) => { entered(); await gate; return original(addresses, options); });
  return { arrived, release, restore: () => { bank.rpc.getMultipleAccountsInfoAndContext = original; } };
}
export async function charterCreationPolicyFixture() {
  const f = await charterCreationTerminalFixture();
  async function prepared(actor = f.source) {
    const funded = await f.fund(actor), zero = await f.inventory().read(actor.wallet, funded.consent.creationIntentId);
    const bank = policyBank(zero); let tick = 0;
    const monotonicNow = vi.fn(() => tick);
    const service = () => createCharterCreationPolicyAdmission(f.db, { chain: bank.chain, monotonicNow });
    return { ...funded, zero, bank, monotonicNow, setTick: (value: number) => { tick = value; }, service };
  }
  const rows = () => f.sql`select * from charter_creation_policy_admissions order by reservation_id`;
  return { ...f, policyPrepared: prepared, policyRows: rows };
}
export type PolicyFixture = Awaited<ReturnType<typeof charterCreationPolicyFixture>>;
export type PreparedPolicy = Awaited<ReturnType<PolicyFixture['policyPrepared']>>;
export async function waitForPolicyLock<T>(f: PolicyFixture, pid: number, pending: ReturnType<typeof outcome<T>>) {
  let stopped = false;
  const blocked = expect.poll(async () => stopped ? 1 : (await f.sql`select pid from pg_stat_activity where datname=current_database()
    and ${pid}::int=any(pg_blocking_pids(pid))`).length, { timeout: 10_000 }).toBeGreaterThan(0);
  try {
    await Promise.race([blocked,
      pending.then(result => { if (!result.ok) throw result.error; throw Error('Admission returned without reaching the intended locked write'); }),
    ]);
  } finally { stopped = true; await blocked; }
}
