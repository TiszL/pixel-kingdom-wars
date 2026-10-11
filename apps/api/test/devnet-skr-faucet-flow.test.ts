/** Offline service/worker tests use actual message parsing/signing and a transactional
 * memory seam. PostgreSQL uniqueness/locking remains covered separately, never inferred here. */
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { SKR_FAUCET } from '@shardkeep/shared';
import { makeSkrFaucetService, processSkrFaucetGrant } from '../src/devnet-only/skrFaucet';
import { faucet, otherPlayer, player, policy, signPrepared, testRpc, testStore, wallet } from './skr-faucet-fixtures';

function fixture(time = '2026-10-02T23:59:59.000Z') {
  let at = new Date(time); const now = () => new Date(at);
  const db = testStore(at), chain = testRpc(), grant = db.makeGrant();
  const enqueue = vi.fn(async () => {}), eligibility = vi.fn(async () => ({ reason: 'ok', deed: grant.deedAssetId }));
  const service = makeSkrFaucetService(policy, db.store, chain.rpc, { now, reference: db.reference,
    eligibility, refreshDeed: async () => grant.deedAssetId, enqueue });
  const prepare = async () => {
    const prepared = await service.prepare(wallet, grant.id);
    if (!prepared.grant.attempt) throw new Error('missing prepared attempt');
    return { ...prepared, attemptId: prepared.grant.attempt.id };
  };
  const signed = async () => {
    const prepared = await prepare(); const playerWire = signPrepared(prepared.unsignedTransaction);
    await service.submit(wallet, prepared.attemptId, playerWire); return { ...prepared, playerWire };
  };
  const work = () => processSkrFaucetGrant(policy, db.store, chain.rpc, faucet, grant.id, now);
  return { db, chain, grant, now, setTime: (time: string) => { at = new Date(time); }, enqueue, eligibility, service, prepare, signed, work };
}
function finalized(f: ReturnType<typeof fixture>, err: null | { InstructionError: [number, string] } = null) {
  f.chain.methods.getSignatureStatuses.mockResolvedValue({ context: { slot: 105 },
    value: [{ slot: 101, confirmations: null, err, confirmationStatus: 'finalized' }] });
}

describe('Amendment 1 UTC boundary (review 91c9ab0d)', () => {
  it('co-sign is refused at day+1 even when the player signed before midnight', async () => {
    const f = fixture(); const prepared = await f.signed(); f.setTime('2026-10-03T00:00:00.000Z');
    f.chain.methods.getGenesisHash.mockClear(); await f.work();
    expect(f.db.attempts.get(prepared.attemptId)).toMatchObject({ phase: 'abandoned', faucetWire: null });
    expect(f.db.grants.get(f.grant.id)).toMatchObject({ status: 'failed', error: 'day_changed', day: '2026-10-02' });
    expect(f.chain.methods.getGenesisHash).not.toHaveBeenCalled(); expect(f.chain.methods.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('a pre-midnight signed wire finalized after midnight settles the reserved day', async () => {
    const f = fixture(); const prepared = await f.signed(); await f.work();
    const wire = f.db.attempts.get(prepared.attemptId)!.faucetWire!; expect(wire).toBeInstanceOf(Buffer);
    f.setTime('2026-10-03T00:00:00.000Z'); finalized(f); await f.work();
    expect(f.db.grants.get(f.grant.id)).toMatchObject({ status: 'sent', day: '2026-10-02', sentAt: f.now() });
    expect(f.db.attempts.get(prepared.attemptId)).toMatchObject({ phase: 'finalized', faucetWire: wire });
    expect(f.chain.methods.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect((await f.service.claim(wallet, f.grant.baseId)).grant.id).not.toBe(f.grant.id);
    expect([...f.db.grants.values()].map((row) => row.day).sort()).toEqual(['2026-10-02', '2026-10-03']);
  });
  it('an unsigned attempt is abandoned at the boundary and a next-day claim creates a new grant', async () => {
    const f = fixture(); const prepared = await f.prepare(); f.setTime('2026-10-03T00:00:00.000Z');
    await expect(f.service.submit(wallet, prepared.attemptId, signPrepared(prepared.unsignedTransaction)))
      .rejects.toMatchObject({ statusCode: 409, code: 'SKR_FAUCET_DAY_CHANGED' });
    expect(f.db.attempts.get(prepared.attemptId)).toMatchObject({ phase: 'abandoned', playerWire: null, faucetWire: null });
    const next = await f.service.claim(wallet, f.grant.baseId); expect(next.grant.id).not.toBe(f.grant.id);
    expect(f.db.grants.get(next.grant.id)?.day).toBe('2026-10-03'); expect(f.chain.methods.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('refuses signing if a fee or treasury RPC crosses midnight after admission', async () => {
    const f = fixture(); const prepared = await f.signed();
    f.chain.methods.getBalance.mockImplementation(async () => { f.setTime('2026-10-03T00:00:00.000Z'); return 10_000_000; });
    await f.work(); expect(f.db.attempts.get(prepared.attemptId)).toMatchObject({ phase: 'abandoned', faucetWire: null });
    expect(f.chain.methods.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe('unsigned preparation and player submission', () => {
  it('returns an identical unsigned attempt until its block height expires, then retains the abandoned original', async () => {
    const f = fixture(); const first = await f.prepare(); const repeated = await f.prepare();
    expect(repeated).toEqual(first); expect(f.db.attempts.size).toBe(1);
    f.chain.state.height = 201; f.chain.state.latestHeight = 301; const next = await f.prepare();
    expect(next.attemptId).not.toBe(first.attemptId); expect(next.unsignedTransaction).not.toBe(first.unsignedTransaction);
    expect(f.db.attempts.get(first.attemptId)).toMatchObject({ phase: 'abandoned', faucetWire: null });
    expect(f.db.attempts.get(next.attemptId)).toMatchObject({ phase: 'prepared', faucetWire: null });
  });
  it('idempotently accepts twenty identical submissions with one attempt and one queue wake', async () => {
    const f = fixture(); const p = await f.prepare(), wire = signPrepared(p.unsignedTransaction);
    const results = await Promise.all(Array.from({ length: 20 }, () => f.service.submit(wallet, p.attemptId, wire)));
    expect(new Set(results.map((row) => row.grant.attempt?.id))).toEqual(new Set([p.attemptId]));
    expect(f.db.attempts.size).toBe(1); expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.db.attempts.get(p.attemptId)).toMatchObject({ phase: 'player_signed', playerWire: Buffer.from(wire, 'base64'), faucetWire: null });
    expect(f.chain.methods.sendRawTransaction).not.toHaveBeenCalled();
    await expect(f.service.submit(wallet, p.attemptId, p.unsignedTransaction)).rejects.toMatchObject({ code: 'SKR_FAUCET_ATTEMPT_CONFLICT' });
    await expect(f.prepare()).rejects.toMatchObject({ code: 'SKR_FAUCET_ATTEMPT_LIVE' });
  });
  it('rejects another wallet and an old wire replayed against a newly prepared reference', async () => {
    const f = fixture(); const p = await f.prepare(), wire = signPrepared(p.unsignedTransaction);
    await expect(f.service.submit(otherPlayer.publicKey.toBase58(), p.attemptId, wire)).rejects.toMatchObject({ statusCode: 404 });
    f.chain.state.height = 201; f.chain.state.latestHeight = 301; const next = await f.prepare();
    await expect(f.service.submit(wallet, next.attemptId, wire)).rejects.toMatchObject({ code: 'SKR_FAUCET_INVALID_TRANSACTION' });
    expect(f.db.attempts.get(next.attemptId)?.playerWire).toBeNull(); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('does not reserve a signed attempt for insufficient player SOL or a self-paid faucet authority', async () => {
    const f = fixture(); f.chain.state.playerSol = 2_049_279;
    await expect(f.prepare()).rejects.toMatchObject({ code: 'SKR_FAUCET_SOL_FOR_FEE' }); expect(f.db.attempts.size).toBe(0);
    await expect(f.service.prepare(faucet.publicKey.toBase58(), f.grant.id)).rejects.toMatchObject({ code: 'SKR_FAUCET_AUTHORITY_IS_PLAYER' });
    f.chain.state.playerSol++; expect((await f.prepare()).accountRentLamports).toBe('2039280');
  });
  it('keeps status DB-only after a one-time cached finalized mint probe', async () => {
    const f = fixture(); await f.service.prime();
    for (const method of Object.values(f.chain.methods)) method.mockClear();
    const dto = await f.service.status(wallet, f.grant.baseId);
    expect(dto).toMatchObject({ isTestToken: true, mint: policy.identity!.mint, decimals: 6, grantRaw: '1000000000' });
    for (const method of Object.values(f.chain.methods)) expect(method).not.toHaveBeenCalled();
    expect(JSON.stringify(dto)).not.toMatch(/message|playerWire|faucetWire|recentBlockhash|deedAssetId/);
  });
  it('retains the committed player signature when queue delivery fails', async () => {
    const f = fixture(); f.enqueue.mockRejectedValue(new Error('private redis details'));
    const p = await f.signed(); expect(f.db.attempts.get(p.attemptId)?.phase).toBe('player_signed');
    await f.work(); expect(f.db.attempts.get(p.attemptId)?.phase).toBe('submitted');
  });
});

describe('faucet-last durable worker', () => {
  it('commits submitted bytes before broadcast and recovers an ambiguous send using the same wire', async () => {
    const f = fixture(); const p = await f.signed();
    const committedAtSend: boolean[] = [];
    f.chain.methods.sendRawTransaction.mockImplementation(async (wire) => {
      const row = f.db.attempts.get(p.attemptId);
      committedAtSend.push(f.db.events.at(-1) === 'commit' && row?.phase === 'submitted' && row.faucetWire?.equals(Buffer.from(wire)) === true);
      f.db.events.push('broadcast'); throw new Error('private upstream reset');
    });
    await f.work(); const first = f.db.attempts.get(p.attemptId)!.faucetWire!;
    const originalMessage = VersionedTransaction.deserialize(Buffer.from(p.playerWire, 'base64')).message.serialize();
    expect(VersionedTransaction.deserialize(first).message.serialize()).toEqual(originalMessage);
    await f.work(); expect(f.chain.methods.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(committedAtSend).toEqual([true, true]);
    for (const [wire, options] of f.chain.methods.sendRawTransaction.mock.calls) {
      expect(Buffer.from(wire)).toEqual(first); expect(options).toMatchObject({ maxRetries: 0, skipPreflight: false });
    }
    expect(f.db.attempts.size).toBe(1); expect(f.db.attempts.get(p.attemptId)?.phase).toBe('submitted');
  });
  it('does not create a new signature after unknown or thrown reconciliation reads', async () => {
    const f = fixture(); const p = await f.signed(); await f.work();
    const before = Buffer.from(f.db.attempts.get(p.attemptId)!.faucetWire!);
    f.chain.methods.getSignatureStatuses.mockRejectedValue(new Error('private rpc text')); f.chain.state.height = 201;
    await f.work(); expect(f.db.attempts.get(p.attemptId)?.faucetWire).toEqual(before);
    expect(f.chain.methods.sendRawTransaction).toHaveBeenCalledTimes(1);
    await expect(f.prepare()).rejects.toMatchObject({ code: 'SKR_FAUCET_ATTEMPT_LIVE' });
  });
  it('requires strict finalized expiry plus complete reference absence before a new attempt', async () => {
    // M1 requires a due observation after a pending check; keep every original expiry/retry assertion.
    const f = fixture('2026-10-02T12:00:00Z'); const p = await f.signed(); await f.work(); f.chain.state.height = 200;
    await f.work(); expect(f.db.attempts.get(p.attemptId)?.phase).toBe('submitted');
    f.setTime('2026-10-02T12:15:00Z'); // beyond the proposed bounded backoff, same reserved day
    f.chain.state.height = 201; await f.work(); expect(f.db.attempts.get(p.attemptId)?.phase).toBe('expired');
    expect(f.db.grants.get(f.grant.id)?.status).toBe('requested'); expect(f.chain.methods.getSignaturesForAddress).toHaveBeenCalled();
    f.chain.state.latestHeight = 301; const next = await f.prepare(); expect(next.attemptId).not.toBe(p.attemptId);
  });
  it('allows retry after a finalized chain error but counts only faucet-signed attempts toward the cap', async () => {
    const f = fixture();
    // An unsigned expiration must not consume the cap.
    const abandoned = await f.prepare(); f.chain.state.height = 201; f.chain.state.latestHeight = 301;
    await f.prepare(); expect(f.db.attempts.get(abandoned.attemptId)?.phase).toBe('abandoned');
    for (let i = 0; i < SKR_FAUCET.devnet.maxAttempts; i++) {
      await f.signed(); await f.work(); finalized(f, { InstructionError: [1, 'InsufficientFunds'] }); await f.work();
    }
    expect([...f.db.attempts.values()].filter((row) => row.faucetWire !== null)).toHaveLength(SKR_FAUCET.devnet.maxAttempts);
    expect(f.db.grants.get(f.grant.id)).toMatchObject({ status: 'failed', error: 'max_attempts' });
    expect(f.chain.methods.sendRawTransaction).toHaveBeenCalledTimes(SKR_FAUCET.devnet.maxAttempts);
  });
  it('abandons near-expiry and short-SOL player signatures without consuming faucet attempt budget', async () => {
    const f = fixture(); const p = await f.signed(); f.chain.state.height = 200 - SKR_FAUCET.devnet.submitHeightMargin + 1;
    await f.work(); expect(f.db.attempts.get(p.attemptId)).toMatchObject({ phase: 'abandoned', faucetWire: null });
    f.chain.state.latestHeight = 400; const next = await f.signed(); f.chain.state.playerSol = 0;
    await f.work(); expect(f.db.attempts.get(next.attemptId)).toMatchObject({ phase: 'abandoned', faucetWire: null });
    expect(f.chain.methods.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('serializes twenty worker calls to one faucet-signed attempt and one retained message', async () => {
    const f = fixture(); const p = await f.signed(); await Promise.all(Array.from({ length: 20 }, () => f.work()));
    const wire = f.db.attempts.get(p.attemptId)!.faucetWire!;
    expect([...f.db.attempts.values()].filter((row) => row.faucetWire !== null)).toHaveLength(1);
    expect(new Set(f.chain.methods.sendRawTransaction.mock.calls.map(([bytes]) => Buffer.from(bytes).toString('base64')))).toEqual(new Set([wire.toString('base64')]));
  });
  it('holds wrong mint, wrong decimals, wrong signer, missing inventory and a disabled flag without co-signing', async () => {
    for (const change of [{ enabled: false }, { cluster: 'mainnet-beta' as const }, { floorSkr: null }, { dailyBudgetSkr: null }, { authority: otherPlayer.publicKey.toBase58() }]) {
      const f = fixture(); const p = await f.signed(); await processSkrFaucetGrant({ ...policy, ...change }, f.db.store, f.chain.rpc, faucet, f.grant.id, f.now);
      expect(f.db.attempts.get(p.attemptId)?.faucetWire).toBeNull(); expect(f.chain.methods.sendRawTransaction).not.toHaveBeenCalled();
    }
    const f = fixture(); const p = await f.signed(); f.chain.state.mintData[44] = 9; await f.work();
    expect(f.db.grants.get(f.grant.id)?.error).toBe('mint_changed'); expect(f.db.attempts.get(p.attemptId)?.faucetWire).toBeNull();
  });
  it('refuses wrong genesis and preserves player-signed bytes through a failed transaction', async () => {
    const f = fixture(); const p = await f.signed(); f.chain.methods.getGenesisHash.mockResolvedValue('wrong-genesis');
    await expect(f.work()).rejects.toThrow(/GENESIS/);
    expect(f.db.attempts.get(p.attemptId)).toMatchObject({ phase: 'player_signed', faucetWire: null });
    expect(f.chain.methods.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('includes committed submitted reservations in floor and daily-budget decisions', async () => {
    const f = fixture(); const p = await f.signed();
    f.chain.state.treasury.writeBigUInt64LE(1_999_999_999n, 64); await f.work();
    expect(f.db.grants.get(f.grant.id)?.error).toBe('treasury_low'); expect(f.db.attempts.get(p.attemptId)?.faucetWire).toBeNull();
    f.chain.state.treasury.writeBigUInt64LE(100_000_000_000n, 64);
    await processSkrFaucetGrant({ ...policy, dailyBudgetSkr: 1000 }, f.db.store, f.chain.rpc, faucet, f.grant.id, f.now);
    const nextGrant = f.db.makeGrant(otherPlayer.publicKey.toBase58(), '2026-10-02', 'other-deed');
    const nextService = makeSkrFaucetService(policy, f.db.store, f.chain.rpc, { now: f.now, reference: f.db.reference,
      eligibility: async () => ({ reason: 'ok', deed: nextGrant.deedAssetId }), refreshDeed: async () => nextGrant.deedAssetId });
    const next = await nextService.prepare(otherPlayer.publicKey.toBase58(), nextGrant.id);
    await nextService.submit(otherPlayer.publicKey.toBase58(), next.grant.attempt!.id, signPrepared(next.unsignedTransaction, otherPlayer));
    await processSkrFaucetGrant({ ...policy, dailyBudgetSkr: 1000 }, f.db.store, f.chain.rpc, faucet, nextGrant.id, f.now);
    expect(f.db.grants.get(nextGrant.id)?.error).toBe('daily_budget'); expect(f.db.attempts.get(next.grant.attempt!.id)?.faucetWire).toBeNull();
  });
});

describe('retained player-wire retry is a read, not a second submission', () => {
  it('returns the exact same attempt after finalization without broadcasting or enqueueing again', async () => {
    const f = fixture(); const p = await f.signed(); await f.work(); finalized(f); await f.work();
    const repeated = await f.service.submit(wallet, p.attemptId, p.playerWire);
    expect(repeated.grant).toMatchObject({ status: 'sent', attempt: { id: p.attemptId, phase: 'finalized' } });
    expect(f.enqueue).toHaveBeenCalledTimes(1); expect(f.chain.methods.sendRawTransaction).toHaveBeenCalledTimes(1);
    await expect(f.service.submit(wallet, p.attemptId, p.unsignedTransaction)).rejects.toMatchObject({ code: 'SKR_FAUCET_TERMINAL' });
  });
  it('returns the retained submitted attempt after midnight while rejecting every new wire', async () => {
    const f = fixture(); const p = await f.signed(); await f.work(); f.setTime('2026-10-03T00:00:00Z');
    const repeated = await f.service.submit(wallet, p.attemptId, p.playerWire);
    expect(repeated.grant.attempt).toMatchObject({ id: p.attemptId, phase: 'submitted' });
    await expect(f.service.submit(wallet, p.attemptId, p.unsignedTransaction)).rejects.toMatchObject({ code: 'SKR_FAUCET_DAY_CHANGED' });
    expect(f.db.attempts.get(p.attemptId)?.phase).toBe('submitted'); expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it('returns a retained failed attempt even after max-attempts makes its grant terminal', async () => {
    const f = fixture(); let last: Awaited<ReturnType<typeof f.signed>> | undefined;
    for (let index = 0; index < SKR_FAUCET.devnet.maxAttempts; index++) {
      last = await f.signed(); await f.work(); finalized(f, { InstructionError: [1, 'InsufficientFunds'] }); await f.work();
    }
    if (!last) throw new Error('missing fixture attempt');
    expect((await f.service.submit(wallet, last.attemptId, last.playerWire)).grant).toMatchObject({ status: 'failed', attempt: { phase: 'failed' } });
    expect(f.enqueue).toHaveBeenCalledTimes(SKR_FAUCET.devnet.maxAttempts);
  });
});

describe('worker defense in depth under a corrupt persistence seam', () => {
  it('does not faucet-sign a player wire while another submitted attempt exists', async () => {
    const f = fixture(), signed = await f.signed();
    const other = fixture(), retained = await other.signed(); await other.work();
    const submitted = other.db.attempts.get(retained.attemptId)!;
    // Intentionally impossible under the partial unique index. This isolates
    // the worker guard so removing it is detected independently of SQL safety.
    f.db.attempts.set(submitted.id, { ...submitted, grantId: f.grant.id, attemptNo: 2 });
    await f.work(); expect(f.db.attempts.get(signed.attemptId)?.faucetWire).toBeNull();
    expect(f.chain.methods.sendRawTransaction).not.toHaveBeenCalled();
  });
});


describe('P5 cross-wallet daily conflict privacy', () => {
  it('returns only status and next eligible time for a transferred deed in status and claim conflicts', async () => {
    const f = fixture(); const signed = await f.signed(); await f.service.prime();
    const stranger = otherPlayer.publicKey.toBase58();
    const expected = { status: 'requested', nextEligibleAt: '2026-10-03T00:00:00.000Z' };
    const status = await f.service.status(stranger, f.grant.baseId); expect(status.today).toEqual(expected);
    await expect(f.service.claim(stranger, f.grant.baseId)).rejects.toMatchObject({ statusCode: 429,
      details: { today: expected, nextEligibleAt: expected.nextEligibleAt } });
    try { await f.service.claim(stranger, f.grant.baseId); } catch (error) {
      const details = (error as { details: unknown }).details; expect(JSON.stringify(details)).not.toContain(f.grant.id);
      expect(JSON.stringify(details)).not.toContain(signed.attemptId);
      expect(JSON.stringify(details)).not.toContain(f.db.attempts.get(signed.attemptId)!.signature!);
    }
    const owner = await f.service.status(wallet, f.grant.baseId);
    expect(owner.today).toMatchObject({ id: f.grant.id, attempt: { id: signed.attemptId } });
  });
});
