/** Synthetic transaction fixtures exercise parsing only; they are not finalized chain evidence. */
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { AddressLookupTableAccount, Ed25519Program, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction, type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
import { canonicalSeekerRegistry, encodeSeekerActionPermit, hashSeekerAuctionTerms, hashSeekerRegistry,
  hashSettleSeekerAuctionPayload, seekerAuctionConfigPda, seekerAuctionPda, seekerAuthorityPda, seekerBidPda,
  seekerPermitReceiptPda, seekerRegistryPda, seekerTermPda, type SeekerAuctionTerms } from './seekerAuctionProtocol';
import { seekerSettlementEvidence, type SeekerSettlementExpectation } from './seekerSettlementEvidence';

const program = new PublicKey(idl.address), wallet = Keypair.generate(), policy = Keypair.generate();
const winner = Keypair.generate().publicKey, mint = Keypair.generate().publicKey, prizeOwner = Keypair.generate().publicKey;
const genesis = Keypair.generate().publicKey, config = seekerAuctionConfigPda(program), registry = seekerRegistryPda(program);
const key = () => Keypair.generate().publicKey;
function terms(spotId = 0): SeekerAuctionTerms {
  const auction = seekerAuctionPda(program, config, spotId, 0n);
  return { ...canonicalSeekerRegistry()[spotId]!, config, registry, registryHash: hashSeekerRegistry(canonicalSeekerRegistry()),
    term: seekerTermPda(program, config, 0n), auction, round: 0n, auctionStart: 10n,
    auctionEnd: 10n + BigInt(PHASE_E_POLICY.seekerIsland.overlappingAuctionSec),
    operatingStart: 10n + BigInt(PHASE_E_POLICY.seekerIsland.overlappingAuctionSec),
    operatingEnd: 10n + BigInt(PHASE_E_POLICY.seekerIsland.overlappingAuctionSec + PHASE_E_POLICY.seekerIsland.operatingTermSec),
    mint, tokenProgram: TOKEN_PROGRAM_ID, vault: getAssociatedTokenAddressSync(mint, auction, true),
    prizeOwner, prizeAta: getAssociatedTokenAddressSync(mint, prizeOwner), prizeBps: PHASE_E_SEEKER_AUCTION.prizeBps,
    grace: BigInt(PHASE_E_SEEKER_AUCTION.settlementGraceSec), openingBid: BigInt(PHASE_E_SEEKER_AUCTION.openingBidSkr),
    registryVersion: 1, auctionFormat: 1, termsFormat: 1 };
}
function instruction(e: SeekerSettlementExpectation, permit = false): TransactionInstruction[] {
  const layout = idl.instructions.find(i => i.name === (permit ? 'settle_auction_with_permit' : 'settle_auction'))!;
  const data = Buffer.alloc(permit ? 34 : 8); data.set(layout.discriminator);
  const accounts = [wallet.publicKey, config, e.terms.term, e.terms.auction, mint, e.terms.vault, e.terms.prizeAta,
    e.winner ? seekerBidPda(program, e.terms.auction, e.winner) : program, TOKEN_PROGRAM_ID];
  const before: TransactionInstruction[] = [];
  if (permit) {
    const permitId = Buffer.alloc(16, 7), expiry = e.settledAt + BigInt(PHASE_E_SEEKER_AUCTION.issuedPolicyPermitTtlSec);
    data.set(permitId, 8); data.writeBigInt64LE(expiry, 24); data.writeUInt16LE(0, 32);
    accounts.push(seekerAuthorityPda(program), seekerPermitReceiptPda(program, permitId), SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram.programId);
    before.push(Ed25519Program.createInstructionWithPrivateKey({ privateKey: policy.secretKey,
      message: encodeSeekerActionPermit({ genesisHash: genesis, programId: program, kind: 8, permitId, wallet: wallet.publicKey,
        expiry, payloadHash: hashSettleSeekerAuctionPayload({ auction: e.terms.auction, config, term: e.terms.term,
          termsHash: e.termsHash, highBid: e.highBid, highBidder: e.winner }) }) }));
  }
  return [...before, { programId: program, data, keys: accounts.map((pubkey, i) => {
    const account = layout.accounts[i]!;
    return { pubkey, isSigner: 'signer' in account && account.signer,
      isWritable: 'writable' in account && account.writable && !(i === 7 && e.winner === null) };
  }) }];
}
function fixture(options: { permit?: boolean; legacy?: boolean; lookup?: boolean; unsold?: boolean;
  edit?: (instructions: TransactionInstruction[], e: SeekerSettlementExpectation) => void } = {}) {
  const t = terms();
  const e: SeekerSettlementExpectation = { signature: '', genesisHash: genesis, programId: program, terms: t,
    termsHash: hashSeekerAuctionTerms(t), winner: options.unsold ? null : winner,
    highBid: options.unsold ? 0n : t.openingBid * 2n, settledAt: t.auctionEnd + (options.permit ? 0n : t.grace), settledSlot: 123n };
  const instructions = instruction(e, options.permit); options.edit?.(instructions, e);
  const table = new AddressLookupTableAccount({ key: key(), state: { deactivationSlot: (1n << 64n) - 1n,
    lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [config, t.term, t.auction, mint, t.vault, t.prizeAta] } });
  const builder = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: key().toBase58(), instructions });
  const message = options.legacy ? builder.compileToLegacyMessage() : builder.compileToV0Message(options.lookup ? [table] : []);
  const signed = new VersionedTransaction(message); signed.sign([wallet]);
  const signatures = signed.signatures.map(s => bs58.encode(s));
  const loadedAddresses = message.version === 0 ? message.resolveAddressTableLookups(options.lookup ? [table] : []) : { writable: [], readonly: [] };
  const tx: VersionedTransactionResponse = { slot: 123, blockTime: null, version: message.version,
    transaction: { message, signatures }, meta: { err: null, fee: 1, preBalances: [], postBalances: [],
      innerInstructions: [], loadedAddresses } };
  return { tx, expected: { ...e, signature: signatures[0]! }, instructions };
}
const check = (f: ReturnType<typeof fixture>) => seekerSettlementEvidence(f.tx, f.expected, genesis);

describe('Seeker settlement transaction/account cross-binding (synthetic fixtures, not finality)', () => {
  for (const mode of [{ legacy: true }, {}, { lookup: true }]) for (const permit of [false, true]) {
    it(`accepts exact ${permit ? 'permit' : 'permissionless'} ${mode.legacy ? 'legacy' : mode.lookup ? 'v0 lookup' : 'v0'} evidence`, () => {
      const f = fixture({ ...mode, permit });
      expect(check(f)).toMatchObject({ signature: f.expected.signature, slot: 123n, instructionIndex: permit ? 1 : 0,
        method: permit ? 'permit' : 'permissionless', settler: wallet.publicKey.toBase58(),
        policyKey: permit ? policy.publicKey.toBase58() : null, requiresFinalizedAccountsAndReviewedDeployment: true });
      // Null RPC blockTime is intentional: it must not be equated with account Clock.
    });
  }
  it('accepts unsold program sentinel without inventing a winner or writable program', () => {
    expect(check(fixture({ unsold: true }))).toMatchObject({ method: 'permissionless' });
    expect(check(fixture({ unsold: true, permit: true }))).toMatchObject({ method: 'permit' });
  });
  it('requires actual original first signature, successful metadata and exact safely represented slot', () => {
    const f = fixture();
    expect(() => seekerSettlementEvidence(null, f.expected, genesis)).toThrow();
    for (const update of [{ meta: null }, { slot: 124 }, { slot: Number.MAX_SAFE_INTEGER + 1 },
      { version: 1 }, { meta: { ...f.tx.meta, err: { InstructionError: [0, 'Custom'] } } }]) {
      expect(() => seekerSettlementEvidence({ ...f.tx, ...update } as never, f.expected, genesis)).toThrow();
    }
    for (const signature of ['settled', bs58.encode(Buffer.alloc(64)), bs58.encode(Buffer.alloc(64, 7))]) {
      expect(() => seekerSettlementEvidence(f.tx, { ...f.expected, signature }, genesis)).toThrow();
    }
    f.tx.transaction.signatures.unshift(bs58.encode(Buffer.alloc(64, 9)));
    expect(() => check(f)).toThrow();
  });
  it('requires complete lookup resolution without making unused inner traces an availability gate', () => {
    const f = fixture({ lookup: true }); delete f.tx.meta!.loadedAddresses;
    expect(() => check(f)).toThrow();
    const missing = fixture(); missing.tx.meta!.innerInstructions = null;
    expect(check(missing)).toMatchObject({ method: 'permissionless' });
  });
  it('binds genesis, original terms hash and canonical identities without reconstructing account authority', () => {
    const f = fixture();
    expect(() => seekerSettlementEvidence(f.tx, f.expected, key())).toThrow('genesis');
    for (const field of ['config', 'term', 'auction', 'registry', 'mint', 'vault', 'prizeAta', 'tokenProgram'] as const) {
      const changed = { ...f.expected.terms, [field]: key() };
      expect(() => seekerSettlementEvidence(f.tx, { ...f.expected, terms: changed }, genesis)).toThrow('hash');
      expect(() => seekerSettlementEvidence(f.tx, { ...f.expected, terms: changed, termsHash: hashSeekerAuctionTerms(changed) }, genesis)).toThrow();
    }
    expect(() => seekerSettlementEvidence(f.tx, { ...f.expected, termsHash: Buffer.alloc(32) }, genesis)).toThrow();
  });
  it('refuses wrong account order, substituted token destinations, winner bid or optional sentinel', () => {
    for (const position of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const f = fixture({ edit: instructions => { instructions[0]!.keys[position]!.pubkey = key(); } });
      expect(() => check(f)).toThrow();
    }
    const f = fixture({ unsold: true, edit: instructions => { instructions[0]!.keys[7]!.pubkey = key(); } });
    expect(() => check(f)).toThrow();
  });
  it('requires meaningful writable privileges while accepting Anchor unused suffixes and remaining accounts', () => {
    expect(() => check(fixture({ edit: instructions => {
      instructions[0]!.keys[0] = { pubkey: key(), isSigner: false, isWritable: false };
    } }))).toThrow('settler signature');
    for (const position of [2, 3, 5, 6, 7]) {
      expect(() => check(fixture({ edit: instructions => { instructions[0]!.keys[position]!.isWritable = false; } }))).toThrow('writable');
    }
    for (const permit of [false, true]) {
      expect(check(fixture({ permit, edit: instructions => {
        const ix = instructions.at(-1)!;
        ix.data = Buffer.concat([ix.data, Buffer.from([0, 9])]);
        ix.keys.push({ pubkey: key(), isWritable: false, isSigner: false });
        ix.keys.push({ pubkey: program, isWritable: true, isSigner: false });
      } })).method).toBe(permit ? 'permit' : 'permissionless');
      expect(() => check(fixture({ permit, edit: instructions => {
        const ix = instructions.at(-1)!; ix.data = ix.data.subarray(0, ix.data.length - 1);
      } }))).toThrow();
      expect(() => check(fixture({ permit, edit: instructions => { instructions.at(-1)!.keys.pop(); } }))).toThrow('layout');
    }
  });
  it('allows distinct-auction batching but refuses duplicate settlement ambiguity', () => {
    const f = fixture({ edit: (instructions, expected) => {
      const other = terms(1); instructions.push(...instruction({ ...expected, terms: other, termsHash: hashSeekerAuctionTerms(other) }));
    } });
    expect(check(f).instructionIndex).toBe(0);
    expect(() => check(fixture({ edit: instructions => { instructions.push(instructions[0]!); } }))).toThrow('duplicate');
  });
  it('ignores incidental inner traces beside top-level proof and never accepts CPI-only evidence', () => {
    const f = fixture(), ix = f.tx.transaction.message.compiledInstructions[0]!;
    const transfer = Buffer.alloc(10); transfer[0] = 12; transfer.writeBigUInt64LE(f.expected.highBid, 1);
    f.tx.meta!.innerInstructions = [{ index: 0, instructions: [{
      programIdIndex: f.tx.transaction.message.staticAccountKeys.findIndex(k => k.equals(TOKEN_PROGRAM_ID)),
      accounts: [5, 4, 6, 3].map(position => ix.accountKeyIndexes[position]!), data: bs58.encode(transfer) }] }];
    expect(check(f)).toMatchObject({ method: 'permissionless' });
    f.tx.meta!.innerInstructions = [{ index: 0, instructions: [{ programIdIndex: ix.programIdIndex,
      accounts: [...ix.accountKeyIndexes], data: bs58.encode(ix.data) }] }];
    ix.data.fill(0); // An inner settlement alone is never proof under the pinned entry guard.
    expect(() => check(f)).toThrow('no original');
    const unrelated = fixture({ edit: instructions => { instructions[0]!.data = Buffer.alloc(8); } });
    expect(() => check(unrelated)).toThrow('no original');
  });
  it('enforces end/grace and typed integer bounds from immutable account facts', () => {
    const f = fixture();
    for (const amendment of [{ settledAt: f.expected.settledAt - 1n }, { settledAt: -1n }, { settledAt: 1 },
      { settledAt: 1n << 63n }, { settledSlot: -1n }, { highBid: 1n << 64n }, { highBid: 0n }, { winner: null }]) {
      expect(() => seekerSettlementEvidence(f.tx, { ...f.expected, ...amendment } as never, genesis)).toThrow();
    }
  });
  it('binds permit payload to original amount, winner, terms and identity, not current rotated policy', () => {
    const f = fixture({ permit: true });
    for (const amendment of [{ highBid: f.expected.highBid + 1n }, { winner: key() }, { genesisHash: key() }]) {
      expect(() => seekerSettlementEvidence(f.tx, { ...f.expected, ...amendment }, amendment.genesisHash ?? genesis)).toThrow();
    }
    expect(check(f).policyKey).toBe(policy.publicKey.toBase58()); // No current-key input exists.
  });
  it('requires permit native verification before settlement with exact native program and no accounts', () => {
    for (const edit of [
      (xs: TransactionInstruction[]) => { xs[1]!.data.writeUInt16LE(1, 32); },
      (xs: TransactionInstruction[]) => { xs[0]!.programId = key(); },
      (xs: TransactionInstruction[]) => { xs[0]!.keys.push({ pubkey: key(), isWritable: false, isSigner: false }); },
    ]) expect(() => check(fixture({ permit: true, edit }))).toThrow('native');
  });
  it('rejects malformed native offset tables, overlapping ranges, truncation and changed permit bytes', () => {
    const edits: Array<(b: Buffer) => void> = [b => { b[0] = 2; }, b => { b[1] = 1; },
      ...[4, 8, 14].map(at => (b: Buffer) => b.writeUInt16LE(0, at)), b => b.writeUInt16LE(160, 12),
      b => b.writeUInt16LE(16, 2), b => b.writeUInt16LE(65534, 10),
      b => { b[b.readUInt16LE(10) + 72] = 7; }, b => { b[b.length - 1] = b[b.length - 1]! ^ 1; }];
    for (const edit of edits) expect(() => check(fixture({ permit: true, edit: xs => edit(xs[0]!.data) }))).toThrow('native');
    expect(() => check(fixture({ permit: true, edit: xs => { xs[0]!.data = xs[0]!.data.subarray(0, 120); } }))).toThrow('native');
  });
  it('retains historical expiry bounds rather than accepting current time or a re-signed ceiling', () => {
    for (const delta of [0n, BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec) + 1n]) {
      const f = fixture({ permit: true, edit: (xs, e) => xs[1]!.data.writeBigInt64LE(e.settledAt + delta, 24) });
      expect(() => check(f)).toThrow('expiry');
    }
  });
});
