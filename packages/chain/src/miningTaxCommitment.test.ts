import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import { MINING_PROGRAM_ADDRESS, miningConfigPda, miningEpochPda } from './miningProgramProtocol';
import { encodeMiningTaxCommitment, encodeMiningTermTaxIdentity, hashMiningTaxCommitment,
  hashMiningTermTaxIdentity, miningTermTaxPoolPda, miningTaxEpochReceiptPda, miningTaxSpotCursorPda,
  type MiningTaxTermIdentity } from './miningTaxCommitment';
const programId = new PublicKey(MINING_PROGRAM_ADDRESS), key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const pda = (seed: string, ...parts: Buffer[]) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...parts], programId)[0];
function fixture(): MiningTaxTermIdentity {
 const round = 5n, r = Buffer.alloc(8); r.writeBigUInt64LE(round);
 const auctionConfig = pda('auction_config'), term = pda('seeker_term', auctionConfig.toBuffer(), r);
 return { programId, config: miningConfigPda(programId), keepMint: key(3), auctionConfig, term,
  registry: pda('seeker_registry'), registryHash: Buffer.alloc(32, 9), round,
  auctionStart: 22n * 86400n, auctionEnd: 23n * 86400n, operatingStart: 23n * 86400n,
  operatingEnd: 30n * 86400n, winnerCount: 3 };
}
describe('immutable original-term KEEP tax commitment wire', () => {
 it('uses distinct fixed v2 domains for the term pool and exact funded epoch', () => {
  const f = fixture(), day = 24n, epoch = miningEpochPda(programId, day);
  const bytes = encodeMiningTaxCommitment(f, { day, epoch });
  expect(bytes.length).toBe(316); expect(Buffer.from(bytes).subarray(0, 10)).toEqual(Buffer.from([83,75,77,84,65,88,48,50,2,0]));
  expect(Buffer.from(bytes).subarray(106, 138)).toEqual(epoch.toBuffer());
  expect(Buffer.from(bytes).readBigUInt64LE(138)).toBe(day);
  expect(bytes[314]).toBe(3); expect(bytes[315]).toBe(1);
  expect(encodeMiningTermTaxIdentity(f).length).toBe(276);
  expect(Buffer.from(hashMiningTaxCommitment(f, { day, epoch })).equals(Buffer.from(hashMiningTermTaxIdentity(f)))).toBe(false);
 });
 it('matches the program fixed v2 wire vectors', () => {
  const f=fixture();
  expect(Buffer.from(hashMiningTermTaxIdentity(f)).toString('hex')).toBe('6f6996699ff67fca924362b300b054fbcc7d3e5d8b63c798c10b7ff1a415edf8');
  expect(Buffer.from(hashMiningTaxCommitment(f,{day:24n,epoch:miningEpochPda(programId,24n)})).toString('hex')).toBe('8c2333efa488f3f789cf26e7e9d6045863ceef0fdc30a364a955192846ef34cd');
 });
 it('binds each original immutable identity and funded day in the digest', () => {
  const f = fixture(), day = 24n, original = hashMiningTaxCommitment(f, { day, epoch: miningEpochPda(programId, day) });
  for (const patch of [{ keepMint: key(4) }, { registryHash: Buffer.alloc(32, 8) }, { winnerCount: 2 }]) {
   expect(hashMiningTaxCommitment({ ...f, ...patch }, { day, epoch: miningEpochPda(programId, day) })).not.toEqual(original);
  }
  expect(hashMiningTaxCommitment(f, { day: 25n, epoch: miningEpochPda(programId, 25n) })).not.toEqual(original);
 });
 it.each(['programId','config','auctionConfig','term','registry'] as const)('refuses substituted canonical %s', field => {
  const f = fixture(); expect(() => encodeMiningTermTaxIdentity({ ...f, [field]: key(41) })).toThrow();
 });
 it.each([0, -1, PHASE_E_POLICY.seekerIsland.totalSpots + 1, 1.5, NaN])('refuses unusable winner population %s', winnerCount => {
  expect(() => encodeMiningTermTaxIdentity({ ...fixture(), winnerCount })).toThrow();
 });
 it.each([22n, 30n, 0n, -1n, 1n << 64n])('refuses earning day outside the original complete interval %s', day => {
  expect(() => encodeMiningTaxCommitment(fixture(), { day, epoch: key(8) })).toThrow();
 });
 it('rejects wrong epoch, noncanonical calendar, malformed hash and integer types', () => {
  const f = fixture(); expect(() => encodeMiningTaxCommitment(f, { day: 24n, epoch: key(8) })).toThrow();
  for (const patch of [{ registryHash: Buffer.alloc(31) }, { keepMint: PublicKey.default }, { auctionEnd: f.auctionEnd + 1n },
   { operatingEnd: f.operatingEnd - 1n }, { round: -1n }, { round: 1 as unknown as bigint }]) expect(() => encodeMiningTermTaxIdentity({ ...f, ...patch })).toThrow();
 });
 it('derives permanent independent term, epoch and spot cursors without owner or current lease seeds', () => {
  const f = fixture(), epoch = miningEpochPda(programId, 24n), pool = miningTermTaxPoolPda(programId, f.term);
  expect(pool).toEqual(pda('mining_tax_pool', f.config.toBuffer(), f.term.toBuffer()));
  expect(miningTaxEpochReceiptPda(programId, epoch)).toEqual(pda('mining_tax_epoch', f.config.toBuffer(), epoch.toBuffer()));
  expect(miningTaxSpotCursorPda(programId, pool, 2)).toEqual(pda('mining_tax_spot', pool.toBuffer(), Buffer.of(2)));
  expect(miningTaxSpotCursorPda(programId, pool, 3)).not.toEqual(miningTaxSpotCursorPda(programId, pool, 2));
  expect(() => miningTaxSpotCursorPda(programId, pool, PHASE_E_POLICY.seekerIsland.totalSpots)).toThrow();
 });
 it('derives the vector addresses from the current IDL program identity', () => {
  const f = fixture();
  expect(f.config.toBase58()).toBe('7LyC7Nq4C6DcrjJCFsnKs44nWSim8EZPCcPwzHie4fLy');
  expect(f.auctionConfig.toBase58()).toBe('614u1z4LiRPRYSzVNTV2pcNoZq7QXRNw5HPM6aXKGNGa');
  expect(f.registry.toBase58()).toBe('1DxNTYaXyKjmvsAnyFJYfaCrsjWRSpyT4ZmPehW4D4u');
  expect(f.term.toBase58()).toBe('J9UsAB4j7NxmACEgwRWPZgEf8rApjwfFP8oauJnJQszf');
  expect(miningEpochPda(programId,24n).toBase58()).toBe('HDwtQ2r1iRTgv5BgbdVtGhGn3qa6wZxk566UxLptRmPu');
 });
});
