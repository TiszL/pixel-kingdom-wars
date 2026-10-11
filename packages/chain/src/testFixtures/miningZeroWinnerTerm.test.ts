import { PHASE_E_POLICY } from '@shardkeep/shared';
import idl from '../idl/shardkeep_economy.json' with { type: 'json' };
import { Keypair, TransactionMessage } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { readFinalizedSeekerTerm } from '../seekerTerms';
import { createMiningZeroWinnerTermFixture, createMiningTermFixture } from './miningZeroWinnerTerm';

describe('mining zero-winner injected finality fixture with real ABI/proof readers', () => {
  it('authenticates all100 settlements and refuses if one original transaction fails', async () => {
    const f = await createMiningZeroWinnerTermFixture({ day: '2026-09-24', genesisHash: Keypair.generate().publicKey, programId: Keypair.generate().publicKey });
    const result = await readFinalizedSeekerTerm(f.connect, f.policy);
    expect(result.winnerCount).toBe(0); expect(result.auctions).toHaveLength(100);
    expect(result.auctions.every(a => a.winner === null && a.settlement.method === 'permissionless')).toBe(true);
    f.bodies.values().next().value!.meta!.err = { InstructionError: [0, 'InvalidArgument'] };
    await expect(readFinalizedSeekerTerm(f.connect, f.policy)).rejects.toThrow('unavailable');
  });
  it.each([false, true])('retains exact settlement account privileges with winner=%s', async hasWinner => {
    const programId = Keypair.generate().publicKey, wallet = Keypair.generate().publicKey;
    const f = await createMiningTermFixture({ day: '2026-09-24', genesisHash: Keypair.generate().publicKey, programId,
      winners: hasWinner ? [{ spotId: 0, wallet }] : [] });
    const layout = idl.instructions.find(i => i.name === 'settle_auction')!;
    expect(f.bodies.size).toBe(PHASE_E_POLICY.seekerIsland.totalSpots);
    for (const [index, body] of [...f.bodies.values()].entries()) {
      const instructions = TransactionMessage.decompile(body.transaction.message).instructions;
      expect(instructions).toHaveLength(1);
      const instruction = instructions[0]!;
      expect(instruction.programId.equals(programId)).toBe(true);
      expect(instruction.keys.map(k => k.isSigner)).toEqual(layout.accounts.map(a => 'signer' in a && a.signer === true));
      // Compiling the transaction promotes its fee payer (account 0) to writable.
      expect(instruction.keys.map(k => k.isWritable)).toEqual(layout.accounts.map((a, i) =>
        i === 0 || ((i !== 7 || (hasWinner && index === 0)) && 'writable' in a && a.writable === true)));
      expect(instruction.keys[7]!.pubkey.equals(programId)).toBe(!(hasWinner && index === 0));
    }
  });
});
