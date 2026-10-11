import { randomUUID } from 'node:crypto';
import { AddressLookupTableAccount, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import { keepAta } from '@shardkeep/chain';
import { TOKEN } from '@shardkeep/shared';
import { withGemsFlow } from './gemsFlow';
import { getOrCreatePlayerAccount, postTransaction } from '../../src/ledger';
import { initializeGemsFlowEvidence } from '../../src/mining/gemsFlowEvidence';
import { creditDeposit } from '../../src/money/deposits';
import { createGemsFinalizedOriginReader, type GemsFinalizedOriginReader, type GemsFinalizedOriginWiring } from '../../src/mining/gemsFinalizedOrigins';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export async function withFinalizedGems(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, coverageAt = '2035-01-01T00:00:00Z', cluster: 'devnet' | 'mainnet-beta' = 'devnet') {
 await withGemsFlow(async base => run(await setup(base, coverageAt, cluster)), false);
}
async function setup(base: Parameters<Parameters<typeof withGemsFlow>[0]>[0], coverageAt: string, cluster: 'devnet' | 'mainnet-beta') {
 await base.clock(coverageAt); await initializeGemsFlowEvidence(base.conn.db);
 const signer = Keypair.generate(), wallet = signer.publicKey.toBase58(), mint = Keypair.generate().publicKey, reserveOwner = Keypair.generate().publicKey, reserveAta = keepAta(reserveOwner, mint, true);
 const genesis = Keypair.generate().publicKey.toBase58();
 await base.clock('2035-01-01T00:01:00Z'); await base.conn.sql`insert into players(wallet,created_at) values(${wallet},'2035-01-01T00:01:00Z')`;
 const gems = await getOrCreatePlayerAccount(base.conn.db, wallet, 'player_gems');
 await base.conn.sql`insert into economy_chain_identity(singleton,cluster,keep_mint,core_program,config_pda,gems_reserve_owner,gems_reserve_ata) values(true,${cluster},${mint.toBase58()},${Keypair.generate().publicKey.toBase58()},${Keypair.generate().publicKey.toBase58()},${reserveOwner.toBase58()},${reserveAta.toBase58()})`;
 const transactions = new Map<string, VersionedTransactionResponse>();
 const calls: Array<{ signature: string; commitment: string }> = [];
 const reader: GemsFinalizedOriginReader = {
  getGenesisHash: async () => genesis,
  getSlot: async commitment => { if (commitment !== 'finalized') throw new Error('fixture demands finality'); return 200; },
  getTransaction: async (signature, options) => { calls.push({ signature, commitment: options.commitment }); return transactions.get(signature) ?? null; },
 };
 const wiring: GemsFinalizedOriginWiring = { trust: { cluster, expectedGenesisHash: genesis, keepMint: mint.toBase58(), reserveOwner: reserveOwner.toBase58(), reserveAta: reserveAta.toBase58() }, connect: () => [reader] };
 const request = { wallet, day: '2035-01-01' };
 const read = createGemsFinalizedOriginReader(base.conn.db, wiring);
 const transfer = (raw = 100_000_000_123n, blockTime = Date.parse('2035-01-01T01:00:00Z') / 1000, version: 'legacy' | 0 = 'legacy') => {
  const source = keepAta(signer.publicKey, mint), data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(raw, 1); data[9] = TOKEN.decimals;
  const ix = new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [{ pubkey: source, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: reserveAta, isSigner: false, isWritable: true }, { pubkey: signer.publicKey, isSigner: true, isWritable: false }], data });
  const message = new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [ix] });
  const lookup = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, addresses: [source, reserveAta, mint] } });
  const signed = new VersionedTransaction(version === 'legacy' ? message.compileToLegacyMessage() : message.compileToV0Message([lookup])); signed.sign([signer]);
  const loaded = signed.message.version === 0 ? signed.message.resolveAddressTableLookups([lookup]) : { writable: [], readonly: [] };
  const signature = bs58.encode(signed.signatures[0]!), keys = [...signed.message.staticAccountKeys, ...loaded.writable, ...loaded.readonly], index = keys.findIndex(k => k.equals(reserveAta));
  const balance = (amount: bigint) => ({ accountIndex: index, mint: mint.toBase58(), owner: reserveOwner.toBase58(), programId: TOKEN_PROGRAM.toBase58(), uiTokenAmount: { amount: amount.toString(), decimals: TOKEN.decimals, uiAmount: null } });
  const tx: VersionedTransactionResponse = { slot: 100, blockTime, version, transaction: { message: signed.message, signatures: signed.signatures.map(s => bs58.encode(s)) }, meta: { err: null, fee: 5000, preBalances: keys.map(() => 1000000), postBalances: keys.map(() => 1000000), preTokenBalances: [balance(500n)], postTokenBalances: [balance(500n + raw)], innerInstructions: [], loadedAddresses: loaded, logMessages: [] } };
  transactions.set(signature, tx); return { signature, tx, raw };
 };
 const credit = async (payment = transfer(), options: { actor?: string; depositId?: string; omitModern?: boolean; direct?: boolean } = {}) => {
  await base.clock('2035-01-01T02:00:00Z');
  const actor = options.actor ?? wallet, depositId = options.depositId ?? randomUUID(), whole = payment.raw / 1_000_000_000n;
  if (options.direct) {
   const acct = await getOrCreatePlayerAccount(base.conn.db, actor, 'player_gems');
   await postTransaction(base.conn.db, { idempotencyKey: `deposit:${depositId}:credit`, type: 'gems.buy', entries: [{ account: base.sys.onchain_inflow, delta: -whole }, { account: base.sys.emission_pool, delta: whole }, { account: base.sys.gems_mint, delta: -whole }, { account: acct.id, delta: whole }], metadata: { wallet: actor, depositId, txSignature: payment.signature, keepBaseUnits: payment.raw.toString(), keep: whole.toString(), gems: whole.toString(), rate: 1, source: 'wallet', ...(!options.omitModern ? { mint: mint.toBase58(), destination: reserveAta.toBase58() } : {}) } });
  } else {
   const reference = Keypair.generate().publicKey.toBase58(), payload = { idempotencyKey: randomUUID(), keepIn: Number(whole), gemsOut: Number(whole), destination: reserveAta.toBase58(), mint: mint.toBase58(), gemsBuyVersion: 1, decimals: TOKEN.decimals, expiresAt: '2035-01-01T03:00:00Z' };
   await base.conn.sql`insert into deposits(id,player_wallet,kind,reference,status,payload,created_at) values(${depositId},${actor},'gems_buy',${reference},'pending',${JSON.stringify(payload)}::jsonb,'2035-01-01T00:30:00Z')`;
   await creditDeposit(base.conn.db, depositId, { wallet: actor, txSignature: payment.signature, kind: 'gems_buy', lamports: payment.raw, finalized: true }, new Date('2035-01-01T02:00:00Z'));
  }
  return { ...payment, depositId };
 };
 return { ...base, signer, wallet, gems, mint, reserveOwner, reserveAta, genesis, transactions, calls, reader, wiring, request, read, transfer, credit };
}
