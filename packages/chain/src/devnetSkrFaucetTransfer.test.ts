import { createHash } from 'node:crypto';
import { ComputeBudgetProgram, Keypair, Message, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { SKR_FAUCET } from '@shardkeep/shared';
import { ACCOUNT_SIZE, AccountLayout, MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { describe, expect, it, vi } from 'vitest';
import { SOLANA_GENESIS_HASH } from './cluster';
import { assertPlayerSignedFaucetTransfer, buildDevnetSkrClaimMessage, faucetCosign,
  readDevnetSkrMint, readDevnetSkrTreasury, skrClaimOutcome, skrGrantAmount, skrPlayerCost,
  SkrFaucetTransferError, type SkrClaimTerms, type SkrFaucetRpc } from './devnetSkrFaucetTransfer';

const key = (byte: number) => Keypair.fromSeed(new Uint8Array(32).fill(byte));
const player = key(11), authority = key(12), mint = key(13).publicKey.toBase58();
const terms: SkrClaimTerms = { wallet: player.publicKey.toBase58(), authority: authority.publicKey.toBase58(), mint,
  decimals: 6, amountRaw: '1000000000', reference: key(14).publicKey.toBase58(),
  recentBlockhash: key(15).publicKey.toBase58(), lastValidBlockHeight: 50 };
const original = () => buildDevnetSkrClaimMessage(terms);
function signed(change: (tx: Transaction) => void = () => {}) {
  const tx = Transaction.from(Buffer.from(original().unsignedWire, 'base64')); change(tx); tx.partialSign(player);
  return tx.serialize({ requireAllSignatures: false }).toString('base64');
}
const check = (wire: string) => assertPlayerSignedFaucetTransfer(terms, original().message, wire);
function cb(limit: number, price: bigint) {
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: limit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price })];
}
function fixtureRpc(overrides: Partial<SkrFaucetRpc> = {}): SkrFaucetRpc {
  return { getGenesisHash: async () => SOLANA_GENESIS_HASH.devnet,
    getSignatureStatuses: async () => ({ context: { slot: 100 }, value: [null] }),
    getBlockHeight: async () => 51, getSignaturesForAddress: async () => [], ...overrides } as SkrFaucetRpc;
}
const mintBytes = () => {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 100_000_000_000n,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data); return data;
};
const treasuryBytes = (extra = {}) => {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({ mint: new PublicKey(mint), owner: authority.publicKey, amount: 10_000_000_000n,
    delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default, ...extra }, data); return data;
};
function accountRpc(data: Buffer, extra = {}) {
  return fixtureRpc({ getAccountInfoAndContext: async () => ({ context: { slot: 100 }, value: {
    owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0, data, ...extra,
  } }) });
}

describe('faucet-last unsigned claim', () => {
  it.each([[0, '1000'], [6, '1000000000'], [9, '1000000000000'], [16, '10000000000000000000']])(
    'encodes an exact player-paid two-signer transfer at decimals %i', (decimals, amountRaw) => {
      const result = buildDevnetSkrClaimMessage({ ...terms, decimals: Number(decimals), amountRaw: String(amountRaw) });
      const tx = VersionedTransaction.deserialize(Buffer.from(result.unsignedWire, 'base64'));
      expect(tx.message.header).toMatchObject({ numRequiredSignatures: 2, numReadonlySignedAccounts: 1 });
      expect(tx.signatures).toHaveLength(2); expect(tx.signatures.every((sig) => sig.every((byte) => byte === 0))).toBe(true);
      expect(tx.message.staticAccountKeys.slice(0, 2).map((item) => item.toBase58())).toEqual([terms.wallet, terms.authority]);
      expect(tx.message.isAccountWritable(1)).toBe(false);
      const instructions = TransactionMessage.decompile(tx.message).instructions;
      expect(instructions).toHaveLength(2); expect(instructions[0]!.keys[0]!.pubkey.toBase58()).toBe(terms.wallet);
      expect(instructions[1]!.data.readBigUInt64LE(1)).toBe(BigInt(amountRaw));
      expect(instructions[1]!.keys.at(-1)).toMatchObject({ isSigner: false, isWritable: false });
      expect(instructions[1]!.keys.at(-1)!.pubkey.toBase58()).toBe(terms.reference);
      expect(skrGrantAmount(Number(decimals))).toBe(BigInt(amountRaw));
    },
  );
  it.each([-1, 1.5, 17, 20, NaN])('refuses invalid/overflowing decimals %s', (decimals) => {
    expect(() => buildDevnetSkrClaimMessage({ ...terms, decimals })).toThrow(SkrFaucetTransferError);
  });
  it('accepts the original and the recorded D141 wallet rewrite without per-instruction privilege mistakes', () => {
    expect(check(signed())).toMatchObject({ mutation: 'none', priorityFeeLamports: 0n });
    expect(check(signed((tx) => { tx.instructions.unshift(...cb(200_000, 375_000n)); })))
      .toMatchObject({ mutation: 'compute_budget_added', priorityFeeLamports: 75_000n });
  });
  it('accepts exactly the fee cap and refuses the first lamport above it', () => {
    const cap = BigInt(SKR_FAUCET.devnet.maxWalletAddedPriorityFeeLamports);
    expect(check(signed((tx) => { tx.instructions.unshift(...cb(1_000_000, cap)); })).priorityFeeLamports).toBe(cap);
    expect(() => check(signed((tx) => { tx.instructions.unshift(...cb(1_000_000, cap + 1n)); }))).toThrow(SkrFaucetTransferError);
  });
  it.each([
    ['blockhash', (tx: Transaction) => { tx.recentBlockhash = key(19).publicKey.toBase58(); }],
    ['fee payer', (tx: Transaction) => { tx.feePayer = authority.publicKey; }],
    ['writable faucet', (tx: Transaction) => { tx.instructions[1]!.keys[3]!.isWritable = true; }],
    ['reference changed', (tx: Transaction) => { tx.instructions[1]!.keys.at(-1)!.pubkey = key(20).publicKey; }],
    ['reference removed', (tx: Transaction) => { tx.instructions[1]!.keys.pop(); }],
    ['recipient changed', (tx: Transaction) => { tx.instructions[1]!.keys[2]!.pubkey = key(21).publicKey; }],
    ['mint changed', (tx: Transaction) => { tx.instructions[1]!.keys[1]!.pubkey = key(22).publicKey; }],
    ['amount changed', (tx: Transaction) => { tx.instructions[1]!.data.writeBigUInt64LE(999n, 1); }],
    ['decimals changed', (tx: Transaction) => { tx.instructions[1]!.data[9] = 9; }],
    ['reordered originals', (tx: Transaction) => { tx.instructions.reverse(); }],
    ['second transfer', (tx: Transaction) => { tx.add(tx.instructions[1]!); }],
    ['System transfer', (tx: Transaction) => { tx.add(SystemProgram.transfer({ fromPubkey: player.publicKey, toPubkey: key(23).publicKey, lamports: 1 })); }],
    ['memo', (tx: Transaction) => { tx.add(new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from('tip') })); }],
    ['advance nonce', (tx: Transaction) => { tx.add(SystemProgram.nonceAdvance({ noncePubkey: key(24).publicKey, authorizedPubkey: player.publicKey })); }],
    ['duplicate CB limit', (tx: Transaction) => { tx.instructions.unshift(...cb(200_000, 1n), ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })); }],
    ['CB account', (tx: Transaction) => { const extra = cb(200_000, 1n)[0]!; extra.keys.push({ pubkey: player.publicKey, isSigner: true, isWritable: true }); tx.add(extra); }],
    ['CB data wrong program', (tx: Transaction) => { const extra = cb(200_000, 1n)[0]!; extra.programId = SystemProgram.programId; tx.add(extra); }],
    ['CB tag zero', (tx: Transaction) => { tx.add(new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0]) })); }],
    ['CB tag one', (tx: Transaction) => { tx.add(new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([1, 0, 0, 0, 0]) })); }],
  ] as const)('refuses %s before a faucet signature exists', (_name, change) => {
    expect(() => check(signed(change))).toThrow(SkrFaucetTransferError);
  });
  it('refuses v0, changed signature counts and an extra unreferenced account', () => {
    const decoded = TransactionMessage.decompile(Message.from(original().message));
    const v0 = new VersionedTransaction(decoded.compileToV0Message()); v0.sign([player]);
    expect(() => check(Buffer.from(v0.serialize()).toString('base64'))).toThrow(SkrFaucetTransferError);
    const extra = Message.from(original().message); extra.accountKeys.push(key(25).publicKey); extra.header.numReadonlyUnsignedAccounts++;
    const extraTx = new VersionedTransaction(extra); extraTx.sign([player]);
    expect(() => check(Buffer.from(extraTx.serialize()).toString('base64'))).toThrow(SkrFaucetTransferError);
    for (const required of [1, 3]) {
      const message = Message.from(original().message); message.header.numRequiredSignatures = required;
      const tx = new VersionedTransaction(message); tx.sign([player]);
      expect(() => check(Buffer.from(tx.serialize()).toString('base64'))).toThrow(SkrFaucetTransferError);
    }
  });
  it('refuses missing/tampered player signatures and any nonzero faucet slot', () => {
    expect(() => check(original().unsignedWire)).toThrow(SkrFaucetTransferError);
    const tx = VersionedTransaction.deserialize(Buffer.from(signed(), 'base64')); const sig0 = tx.signatures[0]!; sig0[0] = (sig0[0] ?? 0) ^ 1;
    expect(() => check(Buffer.from(tx.serialize()).toString('base64'))).toThrow(SkrFaucetTransferError);
    const both = VersionedTransaction.deserialize(Buffer.from(signed(), 'base64')); both.sign([authority]);
    expect(() => check(Buffer.from(both.serialize()).toString('base64'))).toThrow(SkrFaucetTransferError);
  });
  it('refuses a noncanonical/oversized wire and another retained attempt', () => {
    expect(() => check(signed() + '\n')).toThrow(SkrFaucetTransferError); expect(() => check('A'.repeat(1700))).toThrow(SkrFaucetTransferError);
    const another = { ...terms, reference: key(26).publicKey.toBase58() };
    expect(() => assertPlayerSignedFaucetTransfer(another, buildDevnetSkrClaimMessage(another).message, signed())).toThrow(SkrFaucetTransferError);
    expect(() => assertPlayerSignedFaucetTransfer(terms, Buffer.alloc(32), signed())).toThrow(SkrFaucetTransferError);
  });
  it('co-signs exact returned bytes, preserves player slot, verifies both and rejects a different authority', () => {
    const wire = signed((tx) => { tx.instructions.unshift(...cb(200_000, 375_000n)); });
    const before = VersionedTransaction.deserialize(Buffer.from(wire, 'base64'));
    const output = faucetCosign(terms, original().message, wire, authority);
    const after = VersionedTransaction.deserialize(Buffer.from(output, 'base64'));
    expect(after.message.serialize()).toEqual(before.message.serialize()); expect(after.signatures[0]).toEqual(before.signatures[0]);
    expect(Transaction.from(Buffer.from(output, 'base64')).verifySignatures()).toBe(true);
    expect(() => faucetCosign(terms, original().message, wire, key(27))).toThrow(SkrFaucetTransferError);
  });
});

describe('finalized mint/treasury and player fee proof', () => {
  it('accepts the finalized classic mint but rejects wrong genesis/owner/size/uninitialized', async () => {
    await expect(readDevnetSkrMint(accountRpc(mintBytes()), mint)).resolves.toEqual({ mint, decimals: 6, finalized: true });
    const uninitialized = mintBytes(); uninitialized[45] = 0;
    for (const rpc of [fixtureRpc({ getGenesisHash: async () => 'wrong' }), accountRpc(mintBytes(), { owner: PublicKey.default }),
      accountRpc(Buffer.alloc(MINT_SIZE + 1)), accountRpc(uninitialized)]) await expect(readDevnetSkrMint(rpc, mint)).rejects.toThrow();
  });
  it('rejects frozen, delegated or foreign-owned treasuries', async () => {
    await expect(readDevnetSkrTreasury(accountRpc(treasuryBytes()), mint, terms.authority)).resolves.toMatchObject({ balanceRaw: 10_000_000_000n });
    for (const changed of [{ state: 2 }, { delegateOption: 1, delegate: player.publicKey }, { owner: player.publicKey }]) {
      await expect(readDevnetSkrTreasury(accountRpc(treasuryBytes(changed)), mint, terms.authority)).rejects.toThrow();
    }
  });
  it('quotes the player balance and missing ATA rent without reading faucet SOL', async () => {
    const getBalance = vi.fn(async () => 2_009_999);
    const rpc = fixtureRpc({ getBalance, getFeeForMessage: async () => ({ context: { slot: 100 }, value: 10_000 }),
      getMinimumBalanceForRentExemption: async () => 2_000_000,
      getAccountInfoAndContext: async () => ({ context: { slot: 100 }, value: null }) });
    expect(await skrPlayerCost(rpc, terms, Message.from(original().message))).toEqual({ networkFeeLamports: 10_000n, accountRentLamports: 2_000_000n, sufficient: false });
    expect(getBalance).toHaveBeenCalledWith(player.publicKey, 'confirmed'); expect(getBalance).toHaveBeenCalledTimes(1);
  });
});

/** Test-only non-RFC nonce: two valid Ed25519 signatures can identify the same
 * message differently. No key is written, no network/signing tool is invoked. */
function alternatePlayerSignature(message: Uint8Array): Uint8Array {
  const p = (1n << 255n) - 19n, order = (1n << 252n) + 27742317777372353535851937790883648493n;
  const mod = (n: bigint) => ((n % p) + p) % p;
  const pow = (a: bigint, b: bigint) => { let out = 1n; for (; b; b >>= 1n, a = mod(a * a)) if (b & 1n) out = mod(out * a); return out; };
  const d = mod(-121665n * pow(121666n, p - 2n)), y = mod(4n * pow(5n, p - 2n));
  const xx = mod((y * y - 1n) * pow(mod(d * y * y + 1n), p - 2n));
  let x = pow(xx, (p + 3n) / 8n); if (mod(x * x) !== xx) x = mod(x * pow(2n, (p - 1n) / 4n)); if (x & 1n) x = p - x;
  type Point = [bigint, bigint, bigint, bigint];
  const add = ([x1,y1,z1,t1]: Point, [x2,y2,z2,t2]: Point): Point => {
    const a=mod((y1-x1)*(y2-x2)), b=mod((y1+x1)*(y2+x2)), c=mod(2n*d*t1*t2), dd=mod(2n*z1*z2);
    const e=mod(b-a), f=mod(dd-c), g=mod(dd+c), h=mod(b+a); return [mod(e*f),mod(g*h),mod(f*g),mod(e*h)];
  };
  let point: Point = [0n,1n,1n,0n], base: Point = [x,y,1n,mod(x*y)], r = 17n;
  for (let n=r; n; n>>=1n, base=add(base,base)) if(n&1n) point=add(point,base);
  const le = (n: bigint) => { const bytes=Buffer.alloc(32); for(let i=0;i<32;i++){bytes[i]=Number(n&255n);n>>=8n;} return bytes; };
  const read = (bytes: Uint8Array) => [...bytes].reverse().reduce((n,byte)=>(n<<8n)+BigInt(byte),0n);
  const zi=pow(point[2],p-2n), encoded=le(mod(point[1]*zi)); encoded[31]! |= Number((mod(point[0]*zi)&1n)<<7n);
  const expanded=createHash('sha512').update(new Uint8Array(32).fill(11)).digest(); expanded[0]! &= 248; expanded[31]! &= 63; expanded[31]! |= 64;
  const a=read(expanded.subarray(0,32));
  const challenge=read(createHash('sha512').update(encoded).update(player.publicKey.toBytes()).update(message).digest())%order;
  return Buffer.concat([encoded,le((r+challenge*a)%order)]);
}

describe('reference-aware claim settlement', () => {
  function fixture() {
    const faucetWire = faucetCosign(terms, original().message, signed(), authority);
    const tx = VersionedTransaction.deserialize(Buffer.from(faucetWire, 'base64'));
    return { tx, input: { signature: bs58.encode(tx.signatures[0]!), reference: terms.reference, lastValidBlockHeight: 50, faucetWire } };
  }
  it.each(['processed', 'confirmed', 'finalized'] as const)('only settles a %s result if finalized', async (confirmationStatus) => {
    const { input } = fixture();
    for (const err of [null, { InstructionError: [0, 'invalid'] }]) {
      const rpc = fixtureRpc({ getSignatureStatuses: async () => ({ context: { slot: 100 }, value: [{ slot: 100, confirmations: null, confirmationStatus, err }] }) });
      expect((await skrClaimOutcome(rpc, input)).state).toBe(confirmationStatus === 'finalized' ? (err ? 'failed' : 'finalized') : 'unknown');
    }
  });
  it('requires strict finalized expiry plus a complete reference scan', async () => {
    const { input } = fixture(); const rpc = fixtureRpc(); const scan = vi.spyOn(rpc, 'getSignaturesForAddress');
    expect(await skrClaimOutcome(rpc, input)).toEqual({ state: 'expired' }); expect(scan).toHaveBeenCalledOnce();
    expect(await skrClaimOutcome(fixtureRpc({ getBlockHeight: async () => 50 }), input)).toEqual({ state: 'unknown' });
    expect(await skrClaimOutcome(fixtureRpc({ getSignaturesForAddress: async () => { throw new Error('offline'); } }), input)).toEqual({ state: 'unknown' });
  });
  it('finds a valid alternate player signature paired with the stored faucet signature', async () => {
    const { input, tx } = fixture(); tx.signatures[0] = alternatePlayerSignature(tx.message.serialize());
    const variant = bs58.encode(tx.signatures[0]!); expect(variant).not.toBe(input.signature);
    expect(Transaction.from(tx.serialize()).verifySignatures()).toBe(true);
    const rpc = fixtureRpc({ getSignaturesForAddress: async () => [{ signature: variant, slot: 100, err: null, memo: null, blockTime: null, confirmationStatus: 'finalized' }],
      getTransaction: async () => ({ slot: 100, version: 'legacy', transaction: { message: tx.message, signatures: tx.signatures.map((sig) => bs58.encode(sig)) },
        meta: { err: null, fee: 10000, preBalances: [], postBalances: [] } }) });
    expect(await skrClaimOutcome(rpc, input)).toEqual({ state: 'finalized', landedSignature: variant });
  });
  it('does not expire when a listed reference body is missing or the page cap is reached', async () => {
    const { input } = fixture();
    expect(await skrClaimOutcome(fixtureRpc({ getSignaturesForAddress: async () => [{ signature: 'listed', slot: 100, err: null, memo: null, blockTime: null }], getTransaction: async () => null }), input)).toEqual({ state: 'unknown' });
    let n = 0;
    const rpc = fixtureRpc({ getSignaturesForAddress: async (_key, options) => Array.from({ length: options?.limit ?? 0 }, () => ({ signature: `entry-${++n}`, slot: 100, err: null, memo: null, blockTime: null })),
      getTransaction: async () => ({ slot: 100, version: 'legacy', transaction: { message: Message.from(original().message), signatures: ['unrelated', 'other-authority'] }, meta: { err: null, fee: 1, preBalances: [], postBalances: [] } }) });
    expect(await skrClaimOutcome(rpc, input)).toEqual({ state: 'unknown' }); expect(n).toBe(SKR_FAUCET.devnet.referenceScanCap);
  });
  it('treats malformed finalized error metadata as unknown instead of proving tokens unmoved', async () => {
    const { input, tx } = fixture();
    const missingError = { context: { slot: 100 }, value: [{ slot: 100, confirmations: null, confirmationStatus: 'finalized' }] } as unknown as Awaited<ReturnType<SkrFaucetRpc['getSignatureStatuses']>>;
    expect(await skrClaimOutcome(fixtureRpc({ getSignatureStatuses: async () => missingError }), input)).toEqual({ state: 'unknown' });
    const missingMetaError = { slot: 100, version: 'legacy', transaction: { message: tx.message,
      signatures: tx.signatures.map((sig) => bs58.encode(sig)) }, meta: { fee: 1, preBalances: [], postBalances: [] } } as unknown as Awaited<ReturnType<SkrFaucetRpc['getTransaction']>>;
    expect(await skrClaimOutcome(fixtureRpc({
      getSignaturesForAddress: async () => [{ signature: input.signature, slot: 100, err: null, memo: null, blockTime: null }],
      getTransaction: async () => missingMetaError,
    }), input)).toEqual({ state: 'unknown' });
  });

});


it.each(['mintAuthorityOption', 'freezeAuthorityOption'] as const)('refuses an unrevoked %s on the finalized mint', async (field) => {
  const data = mintBytes(), decoded = MintLayout.decode(data);
  MintLayout.encode({ ...decoded, [field]: 1, mintAuthority: authority.publicKey, freezeAuthority: authority.publicKey }, data);
  await expect(readDevnetSkrMint(accountRpc(data), mint)).rejects.toMatchObject({ code: 'MINT' });
});
