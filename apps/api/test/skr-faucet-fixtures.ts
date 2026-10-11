/** Offline fixture. Never substitutes for the separate real-Postgres lock/index tests. */
import { randomUUID } from 'node:crypto';
import { Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { vi } from 'vitest';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { SKR_FAUCET } from '@shardkeep/shared';
import { buildDevnetSkrClaimMessage, type SkrFaucetRpc } from '@shardkeep/chain/devnet-skr-faucet-transfer';
import { HttpError } from '../src/lib/errors';
import { utcWindow, type SkrFaucetPolicy } from '../src/devnet-only/skrFaucet';
import type { SkrGrant, SkrAttempt, SkrGrantUnit, SkrFaucetStore } from '../src/devnet-only/skrFaucetStore';

const key = (value: number) => Keypair.fromSeed(new Uint8Array(32).fill(value));
export const player = key(81), faucet = key(82), otherPlayer = key(83);
export const mint = key(84).publicKey.toBase58(), blockhash = key(85).publicKey.toBase58();
export const wallet = player.publicKey.toBase58();
export const policy: SkrFaucetPolicy = { enabled: true, cluster: 'devnet', identity: { mint, decimals: 6 },
  authority: faucet.publicKey.toBase58(), floorSkr: 1_000, dailyBudgetSkr: 100_000 };
const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export function testRpc() {
  const mintData = Buffer.alloc(82); mintData.writeBigUInt64LE(100_000_000_000n, 36); mintData[44] = 6; mintData[45] = 1;
  const treasury = Buffer.alloc(165); new PublicKey(mint).toBuffer().copy(treasury, 0);
  faucet.publicKey.toBuffer().copy(treasury, 32); treasury.writeBigUInt64LE(100_000_000_000n, 64); treasury[108] = 1;
  const account = (data: Buffer) => ({ executable: false, lamports: 1, rentEpoch: 0, owner: tokenProgram, data });
  const state = { height: 100, latestHeight: 200, playerSol: 10_000_000, mintData, treasury };
  const methods = {
    getGenesisHash: vi.fn<SkrFaucetRpc['getGenesisHash']>(async () => SOLANA_GENESIS_HASH.devnet),
    getAccountInfoAndContext: vi.fn(async (address: PublicKey, config?: unknown) => ({ context: { slot: 100 },
      value: address.toBase58() === mint ? account(state.mintData)
        : typeof config === 'object' && config !== null && 'commitment' in config && config.commitment === 'finalized'
          ? account(state.treasury) : null })),
    getLatestBlockhash: vi.fn(async () => ({ blockhash, lastValidBlockHeight: state.latestHeight })),
    getBalance: vi.fn(async () => state.playerSol),
    getFeeForMessage: vi.fn(async () => ({ context: { slot: 100 }, value: 10_000 })),
    getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
    getSignatureStatuses: vi.fn<SkrFaucetRpc['getSignatureStatuses']>(async () => ({ context: { slot: 100 }, value: [null] })),
    getBlockHeight: vi.fn(async () => state.height),
    getSignaturesForAddress: vi.fn<SkrFaucetRpc['getSignaturesForAddress']>(async () => []),
    getTransaction: vi.fn<SkrFaucetRpc['getTransaction']>(async () => null),
    sendRawTransaction: vi.fn<SkrFaucetRpc['sendRawTransaction']>(async (bytes) => bs58.encode(VersionedTransaction.deserialize(Buffer.from(bytes)).signatures[0]!)),
  };
  return { state, methods, rpc: methods as unknown as SkrFaucetRpc };
}
export function testStore(at = new Date('2026-10-02T12:00:00Z')) {
  const grants = new Map<string, SkrGrant>(), attempts = new Map<string, SkrAttempt>(), events: string[] = [];
  let sequence = 90, tail: Promise<void> = Promise.resolve();
  const makeGrant = (owner = wallet, day = utcWindow(at).day, deed = 'fixture-deed'): SkrGrant => {
    const row: SkrGrant = { id: randomUUID(), wallet: owner, baseId: randomUUID(), deedAssetId: deed, day, mint,
      decimals: 6, amountRaw: '1000000000', status: 'requested', error: null,
      requestedAt: new Date(`${day}T12:00:00.000Z`), sentAt: null };
    grants.set(row.id, row); return row;
  };
  const rows = (id: string) => [...attempts.values()].filter((row) => row.grantId === id).sort((a, b) => b.attemptNo - a.attemptNo);
  const owned = (id: string, owner: string | null) => {
    const row = grants.get(id); if (!row || owner !== null && row.wallet !== owner) throw new HttpError(404, 'grant not owned', 'SKR_FAUCET_NOT_OWNED'); return row;
  };
  const reference = () => key(++sequence).publicKey.toBase58();
  const store: SkrFaucetStore = {
    readReconciliation: async (id) => grants.has(id) ? ({ grant: { ...owned(id, null) }, attempts: rows(id).map((row) => ({ ...row })) }) : null,
    readGrant: async (id, owner) => ({ grant: { ...owned(id, owner) }, attempts: rows(id).map((row) => ({ ...row })) }),
    readAttemptOwner: async (id, owner) => { const row = attempts.get(id); if (!row) throw new HttpError(404, 'attempt not owned', 'SKR_FAUCET_NOT_OWNED'); return { grant: owned(row.grantId, owner), attempt: row }; },
    ownedRequested: async (owner, after) => {
      // (requested_at, id) descending, code-unit id order like Postgres uuid and the native String compare.
      const older = (a: SkrGrant, b: SkrGrant) => a.requestedAt.getTime() < b.requestedAt.getTime()
        || a.requestedAt.getTime() === b.requestedAt.getTime() && a.id < b.id;
      const cursor = after === undefined ? null : owned(after, owner);
      const list = [...grants.values()].filter((row) => row.wallet === owner && row.status === 'requested' && (!cursor || older(row, cursor)))
        .sort((a, b) => older(a, b) ? 1 : older(b, a) ? -1 : 0);
      const size = SKR_FAUCET.devnet.grantReadPageSize;
      return { rows: list.slice(0, size).map((grant) => ({ grant: { ...grant }, attempt: rows(grant.id)[0] ?? null })), more: list.length > size };
    },
    findToday: async (owner, deed, day) => {
      const grant = [...grants.values()].find((row) => row.day === day && (row.wallet === owner || row.deedAssetId === deed));
      return grant ? { grant, attempt: rows(grant.id)[0] ?? null } : null;
    },
    reserve: async (input, clock) => {
      const day = utcWindow(clock()).day;
      if (day !== utcWindow(input.enteredAt).day) throw new HttpError(409, 'day_changed', 'SKR_FAUCET_DAY_CHANGED');
      const existing = [...grants.values()].find((row) => row.day === day && (row.wallet === input.wallet || row.deedAssetId === input.refreshedDeed));
      if (existing) return { grant: existing, conflict: true };
      const grant = makeGrant(input.wallet, day, input.refreshedDeed); Object.assign(grant, { baseId: input.baseId, requestedAt: clock() }); return { grant, conflict: false };
    },
    pending: async (limit, after, date = at) => [...grants.values()].filter((row) => row.status === 'requested'
      && (row.day < utcWindow(date).day || rows(row.id).some((attempt) => ['prepared', 'player_signed', 'submitted'].includes(attempt.phase)))
      && (!after || row.requestedAt > after.requestedAt || row.requestedAt.getTime() === after.requestedAt.getTime() && row.id > after.id))
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime() || a.id.localeCompare(b.id)).slice(0, limit).map(({ id, requestedAt }) => ({ id, requestedAt })),
    withGrant: async <T>(id: string, owner: string | null, run: (unit: SkrGrantUnit) => Promise<T>, _treasuryMint?: string): Promise<T> => {
      const prior = tail; let release!: () => void; tail = new Promise<void>((resolve) => { release = resolve; }); await prior;
      const beforeGrants = new Map([...grants].map(([key, value]) => [key, { ...value }]));
      const beforeAttempts = new Map([...attempts].map(([key, value]) => [key, { ...value }]));
      try {
        const grant = owned(id, owner), held = rows(id); events.push('begin');
        const unit: SkrGrantUnit = {
          grant, attempts: held,
          addAttempt: async (input) => {
            if (held.some((row) => ['prepared', 'player_signed', 'submitted'].includes(row.phase))) throw new Error('live attempt');
            const row: SkrAttempt = { id: randomUUID(), grantId: id, attemptNo: input.attemptNo, phase: 'prepared', message: Buffer.from(input.message), reference: input.reference,
              recentBlockhash: input.recentBlockhash, lastValidBlockHeight: input.lastValidBlockHeight,
              playerWire: null, signature: null, mutation: null, faucetWire: null, landedSignature: null,
              createdAt: input.createdAt ?? at, settledAt: null };
            attempts.set(row.id, row); held.unshift(row); events.push('prepared'); return row;
          },
          updateAttempt: async (attemptId, update) => {
            const index = held.findIndex((row) => row.id === attemptId); if (index < 0) throw new Error('attempt not held');
            const row = { ...held[index]!, ...update }; held[index] = row; attempts.set(row.id, row); events.push(row.phase); return row;
          },
          updateGrant: async (update) => { Object.assign(grant, update); },
          tallies: async (selectedMint, day) => ({
            reservedAllRaw: [...attempts.values()].filter((row) => row.phase === 'submitted').reduce((sum, row) => {
              const g = grants.get(row.grantId)!; return sum + (g.mint === selectedMint ? BigInt(g.amountRaw) : 0n);
            }, 0n),
            reservedDayRaw: [...attempts.values()].filter((row) => row.phase === 'submitted').reduce((sum, row) => {
              const g = grants.get(row.grantId)!; return sum + (g.mint === selectedMint && g.day === day ? BigInt(g.amountRaw) : 0n);
            }, 0n),
            sentTodayRaw: [...grants.values()].filter((row) => row.mint === selectedMint && row.day === day && row.status === 'sent').reduce((sum, row) => sum + BigInt(row.amountRaw), 0n),
          }),
        };
        const result = await run(unit); events.push('commit'); return result;
      } catch (error) {
        grants.clear(); for (const [key, value] of beforeGrants) grants.set(key, value);
        attempts.clear(); for (const [key, value] of beforeAttempts) attempts.set(key, value);
        events.push('rollback'); throw error;
      } finally { release(); }
    },
  };
  return { store, grants, attempts, makeGrant, reference, rows, events };
}
export function signPrepared(unsignedWire: string, signer = player) {
  const tx = Transaction.from(Buffer.from(unsignedWire, 'base64')); tx.partialSign(signer);
  return tx.serialize({ requireAllSignatures: false }).toString('base64');
}
export function referenceMessage(grant: SkrGrant, reference: string) {
  return buildDevnetSkrClaimMessage({ wallet: grant.wallet, authority: faucet.publicKey.toBase58(), mint: grant.mint,
    decimals: grant.decimals, amountRaw: grant.amountRaw, reference, recentBlockhash: blockhash, lastValidBlockHeight: 200 });
}
