/** Test-only SDK-encoded source fixtures. These are synthetic archive records,
 * not live mainnet receipts or independently authenticated provider evidence. */
import { vi, type Mock } from 'vitest';
import { PublicKey, Keypair, SystemProgram, TransactionInstruction, TransactionMessage, type VersionedTransactionResponse } from '@solana/web3.js';
import { AccountLayout, AccountState, MintLayout, MetadataPointerLayout, ExtensionType, AccountType, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createInitializeAccount3Instruction, createInitializeImmutableOwnerInstruction, createInitializeMintInstruction, createInitializeMint2Instruction, createInitializeMetadataPointerInstruction, createMintToInstruction, TokenInstruction } from '@solana/spl-token';
import { SEEKER } from '@shardkeep/shared';
import bs58 from 'bs58';
import { readMiningSeekerHoldingEvidence, readMiningSeekerMintBirthEvidence, type MiningSeekerHoldingReader } from '../miningSeekerHolding';
const wallet = Keypair.fromSeed(Buffer.alloc(32, 1)).publicKey, payer = Keypair.fromSeed(Buffer.alloc(32, 2)).publicKey, mint = Keypair.fromSeed(Buffer.alloc(32, 3)).publicKey, other = Keypair.fromSeed(Buffer.alloc(32, 4)).publicKey;
let sequence = 0;
function sig() { const b = Buffer.alloc(64, 9); b.writeUInt32LE(++sequence); return bs58.encode(b); }
function tlv(type: number, data: Buffer) { const h = Buffer.alloc(4); h.writeUInt16LE(type); h.writeUInt16LE(data.length, 2); return Buffer.concat([h, data]); }
function mintBytes() {
  const base = Buffer.alloc(166); MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: new PublicKey(SEEKER.sgt.mintAuthority), supply: 1n, decimals: 0, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, base); base[165] = AccountType.Mint;
  const pointer = Buffer.alloc(64); MetadataPointerLayout.encode({ authority: new PublicKey(SEEKER.sgt.metadataAuthority), metadataAddress: new PublicKey(SEEKER.sgt.metadataAddress) }, pointer);
  const member = Buffer.alloc(72); mint.toBuffer().copy(member); new PublicKey(SEEKER.sgt.group).toBuffer().copy(member, 32); member.writeBigUInt64LE(1n, 64);
  return Buffer.concat([base, tlv(ExtensionType.MetadataPointer, pointer), tlv(ExtensionType.TokenGroupMember, member)]);
}
function accountBytes() {
  const base = Buffer.alloc(166); AccountLayout.encode({ mint, owner: wallet, amount: 1n, delegateOption: 0, delegate: PublicKey.default, state: AccountState.Initialized, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, base); base[165] = AccountType.Account;
  return Buffer.concat([base, tlv(ExtensionType.ImmutableOwner, Buffer.alloc(0))]);
}
function tx(instructions: TransactionInstruction[], slot: number): VersionedTransactionResponse {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions }).compileToV0Message();
  return { version: 0, slot, blockTime: slot * 10, transaction: { message, signatures: Array.from({ length: message.header.numRequiredSignatures }, sig) }, meta: { err: null, fee: 1, preBalances: Array.from({ length: message.staticAccountKeys.length }, () => 0), postBalances: [], innerInstructions: [] } };
}
function fixture(ata = true) {
  const tokenAccount = ata ? getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_2022_PROGRAM_ID) : Keypair.fromSeed(Buffer.alloc(32, 5)).publicKey;
  const create = SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: tokenAccount, lamports: 2000000, space: 170, programId: TOKEN_2022_PROGRAM_ID });
  const initialize = createInitializeAccount3Instruction(tokenAccount, mint, wallet, TOKEN_2022_PROGRAM_ID);
  const creation = tx(ata ? [createAssociatedTokenAccountInstruction(payer, tokenAccount, wallet, mint, TOKEN_2022_PROGRAM_ID)] : [create, initialize], 10);
  if (ata) {
    const keys = creation.transaction.message.staticAccountKeys;
    const size = new TransactionInstruction({ programId: TOKEN_2022_PROGRAM_ID, keys: [{ pubkey: mint, isSigner: false, isWritable: false }], data: Buffer.from([TokenInstruction.GetAccountDataSize, ExtensionType.ImmutableOwner, 0]) });
    creation.meta!.innerInstructions = [{ index: 0, instructions: [size, create, createInitializeImmutableOwnerInstruction(tokenAccount, TOKEN_2022_PROGRAM_ID), initialize].map(ix => ({ programIdIndex: keys.findIndex(k => k.equals(ix.programId)), accounts: ix.keys.map(k => keys.findIndex(x => x.equals(k.pubkey))), data: bs58.encode(ix.data), stackHeight: 2 })) }];
  }
  const txs = [creation];
  const accounts = [{ owner: TOKEN_2022_PROGRAM_ID, data: mintBytes(), executable: false, lamports: 2000000, rentEpoch: 0 }, { owner: TOKEN_2022_PROGRAM_ID, data: accountBytes(), executable: false, lamports: 2000000, rentEpoch: 0 }];
  const reader: Record<keyof MiningSeekerHoldingReader, Mock> = {
    getGenesisHash: vi.fn().mockResolvedValue(SEEKER.mainnetGenesisHash), getSlot: vi.fn().mockResolvedValue(30),
    getMultipleAccountsInfoAndContext: vi.fn().mockResolvedValue({ context: { slot: 30 }, value: accounts }),
    getBlockTime: vi.fn().mockImplementation(async (slot: number) => slot * 10),
    getSignaturesForAddress: vi.fn().mockImplementation(async (address: PublicKey) => txs.filter(t => t.transaction.message.staticAccountKeys.some(k => k.equals(address))).map(t => ({ signature: t.transaction.signatures[0]!, slot: t.slot, blockTime: t.blockTime, err: t.meta!.err, confirmationStatus: 'finalized' as const })).sort((a, b) => b.slot - a.slot)),
    getTransaction: vi.fn().mockImplementation(async (s: string) => txs.find(t => t.transaction.signatures[0] === s) ?? null),
    getBlockSignatures: vi.fn().mockImplementation(async (slot: number) => ({ blockTime: slot * 10, signatures: txs.filter(t => t.slot === slot).map(t => t.transaction.signatures[0]!) })),
  };
  const input = { linkedWallet: wallet.toBase58(), mint: mint.toBase58(), tokenAccount: tokenAccount.toBase58(), startAt: new Date(150000), endAt: new Date(250000) };
  return { reader, input, accounts, creation, txs, tokenAccount, read: () => readMiningSeekerHoldingEvidence(reader as unknown as MiningSeekerHoldingReader, input) };
}
function birthFixture(legacyInit = false) {
  const f = fixture(), issuer = new PublicKey(SEEKER.sgt.mintAuthority);
  const create = SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, lamports: 2000000, space: mintBytes().length, programId: TOKEN_2022_PROGRAM_ID });
  const initialize = (legacyInit ? createInitializeMintInstruction : createInitializeMint2Instruction)(mint, 0, issuer, null, TOKEN_2022_PROGRAM_ID);
  const pointer = createInitializeMetadataPointerInstruction(mint, issuer, new PublicKey(SEEKER.sgt.metadataAddress), TOKEN_2022_PROGRAM_ID);
  const birth = tx([create, pointer, initialize], 5);
  f.txs.unshift(birth);
  f.txs.push(tx([createMintToInstruction(mint, f.tokenAccount, issuer, 1n, [], TOKEN_2022_PROGRAM_ID)], 11));
  const input = { ...f.input, coverageFloor: new Date(40000) };
  return { ...f, birth, create, initialize, pointer, input, readBirth: () => readMiningSeekerMintBirthEvidence(f.reader as unknown as MiningSeekerHoldingReader, input) };
}

export { wallet, payer, mint, other, sig, tx, mintBytes, accountBytes, fixture as seekerHoldingFixture, birthFixture as seekerMintBirthFixture };
