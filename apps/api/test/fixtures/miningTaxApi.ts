/** Shared browser/JVM fixture: restricted runtime API and actual owner receipt
 * verification over encoded finalized banks. No Vitest or client globals. */
import { randomUUID } from 'node:crypto';
import { PublicKey, SYSVAR_CLOCK_PUBKEY, VersionedTransaction } from '@solana/web3.js';
import { buildApp } from '../../src/app';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { players, sessions } from '../../src/db/schema';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../../src/auth/session';
import { createMiningTaxClaimSettlement } from '../../src/mining/taxClaimSettlement';
import { createMiningTaxClaimFailure } from '../../src/mining/taxClaimFailure';
import type { MiningTaxFailureRpc } from '../../../../packages/chain/src/miningTaxFailure';
import { withMiningTaxAdmissionFixture, type MiningTaxAdmissionFixture } from './miningTaxAdmission';
import { TEST_CONFIG } from '../helpers';

export interface MiningTaxApiFixtureOptions {
 mode: 'claim' | 'combined' | 'split'; genesisHash?: string; origin?: string; loseRelay?: boolean; continuationKey?: string;
}
async function setup(f: MiningTaxAdmissionFixture, options: MiningTaxApiFixtureOptions) {
 await runMigrations(f.conn.db);
 const role = `tax_pair_${randomUUID().replaceAll('-', '')}`, password = randomUUID();
 await f.conn.sql.unsafe(`create role ${role} login password '${password}'; grant usage on schema public to ${role};
  grant select on players,sessions,mining_tax_claim_preparations,mining_tax_claim_signed_wires,mining_tax_claim_receipts,mining_tax_claim_failures,mining_tax_claim_continuations to ${role};
  grant insert on mining_tax_claim_preparations,mining_tax_claim_signed_wires,mining_tax_claim_continuations to ${role};
  grant execute on function public.shardkeep_mining_tax_continuation_lock(uuid) to ${role}`);
 const url = new URL(f.url); url.username = role; url.password = password;
 let runtime = createDb(url.toString(), { max: 4 }), app: Awaited<ReturnType<typeof buildApp>> | undefined;
 const config = { ...TEST_CONFIG, DATABASE_URL: url.toString(), WEB_ORIGIN: [options.origin ?? TEST_CONFIG.WEB_ORIGIN[0]!] };
 const preparation = f.record.artifact, sent: string[] = [], sends: number[] = [], signatures: number[] = [];
 const trust = { genesisHash: preparation.identity.genesisHash, programId: preparation.identity.programId,
  configAddress: preparation.identity.configAddress, keepMint: preparation.identity.keepMint, reserveOwner: preparation.identity.reserveOwner,
  reviewedDeploymentSlot: preparation.source.reviewedDeploymentSlot, reviewedProgramDataSha256: preparation.source.reviewedProgramDataSha256 };
 let preparePosts = 0, submitPosts = 0, continuationPosts = 0;
 const providers = { miningTaxPreparationSources: f.sources, miningTaxRelaySources: { admission: f.sources, transport: () => ({
  getGenesisHash: async () => preparation.source.genesisHash,
  getSignatureStatuses: async () => ({ context: { slot: f.control.slot }, value: [null] }), getBlockHeight: async () => f.control.height,
  sendRawTransaction: async (bytes: Uint8Array) => {
   const wire = Buffer.from(bytes), ordinal = preparation.transactions.findIndex(t => t.messageHex === wire.subarray(65).toString('hex'));
   if (ordinal < 0 || !wire.equals(Buffer.from(f.wire(ordinal)))) throw Error('unexpected relay packet');
   const custody = await f.conn.sql`select encode(signed_transaction,'hex') wire from mining_tax_claim_signed_wires where claim_id=${preparation.claimId} and ordinal=${ordinal}`;
   if (custody.length !== 1 || custody[0]!.wire !== wire.toString('hex')) throw Error('wire was not durably committed before relay');
   sent.push(wire.toString('base64')); sends.push(ordinal);
   if (options.loseRelay) throw Error('lost relay reply');
   return f.chain.txs[ordinal]!.transaction.signatures[0]!;
  },
 }) } };
 try {
  await f.conn.db.insert(players).values({ wallet: f.wallet }).onConflictDoNothing();
  const [session] = await f.conn.db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const jwt = await issueSessionJwt(config, f.wallet, session!.id), cookie = `${SESSION_COOKIE}=${jwt}`;
  app = await buildApp(config, runtime.db, providers); await app.ready();
  const rows = (table: 'mining_tax_claim_signed_wires' | 'mining_tax_claim_receipts') => f.conn.sql.unsafe<{ ordinal: number }[]>(`select ordinal from ${table} order by ordinal`);
  return {
   chain: f, preparation, trust, cookie, cookieHeader: `${cookie}; Secure; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SEC}`, sent, rows,
   blockHeight: f.control.height,
   async request(input: { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body?: string }) {
    const key = preparation.idempotencyKey, base = '/claims/mining-tax/';
    const allowed = input.method === 'POST' ? [base + 'prepare', base + 'submit', ...(options.continuationKey ? [base + `continue/${key}`] : [])]
     : [base + `prepare/by-key/${key}`, base + `by-key/${key}`, base + `failures/by-key/${key}`, ...preparation.transactions.map(t => base + `review/by-key/${key}/${t.ordinal}`), ...(options.continuationKey ? [base + `continuations/by-key/${key}`, ...[key, options.continuationKey].flatMap(k => [base + `prepare/by-key/${k}`, base + `by-key/${k}`, base + `failures/by-key/${k}`, base + `review/by-key/${k}/0`])] : [])];
    if (!allowed.includes(input.url)) throw Error('unexpected fixture request');
    if (input.method === 'POST') { if (input.url.endsWith('/prepare')) preparePosts++; else if (input.url.includes('/continue/')) continuationPosts++; else submitPosts++; }
    const response = await app!.inject({ method: input.method, url: input.url, headers: input.headers,
     ...(input.body === undefined ? {} : { payload: input.body }) });
    return { status: response.statusCode, body: response.body };
   },
   sign(input: { unsigned: string; key: string; ordinal: number }) {
    const packet = preparation.transactions.find(t => t.ordinal === input.ordinal), bytes = Buffer.from(input.unsigned, 'base64');
    if (input.key !== preparation.idempotencyKey || !packet || bytes.toString('base64') !== input.unsigned || bytes.length > 1232
     || bytes[0] !== 1 || !bytes.subarray(1, 65).equals(Buffer.alloc(64)) || !bytes.subarray(65).equals(Buffer.from(packet.messageHex, 'hex'))) throw Error('unexpected wallet approval');
    const signed = VersionedTransaction.deserialize(bytes); signed.sign([f.chain.signer]); signatures.push(input.ordinal);
    return { wire: Buffer.from(signed.serialize()).toString('base64') };
   },
   async settle(input: { key: string; ordinal: number; setupFee?: number }) {
    if (input.key !== preparation.idempotencyKey || !preparation.transactions.some(t => t.ordinal === input.ordinal)) throw Error('wrong original settlement');
    if (options.mode === 'split' && input.ordinal === 0) {
     const fee = input.setupFee ?? 5, remaining = Number(preparation.caps.maxFeeLamports) - fee;
     if (!Number.isSafeInteger(fee) || fee < 0 || remaining < 0) throw Error('invalid fixture setup fee');
     const receipt = await f.verifySetup(fee);
     // The original aggregate cap stays immutable while actual setup costs are
     // bound into the second explicit review and final transaction balances.
     f.control.fee = remaining;
     const claim = f.chain.txs[1]!, delta = claim.meta!.fee - remaining;
     claim.meta!.fee = remaining; claim.meta!.preBalances[0]! -= delta;
     return receipt;
    }
    if (input.setupFee !== undefined) throw Error('setup fee only belongs to split ordinal zero');
    await f.stage('paid'); return createMiningTaxClaimSettlement(f.conn.db, f.options)({ ...f.key, ordinal: input.ordinal });
   },
   async fail(input: { key: string; ordinal: number; fee?: number }) {
    if(input.key!==preparation.idempotencyKey||!preparation.transactions.some(t=>t.ordinal===input.ordinal))throw Error('wrong original failure');
    const tx=f.chain.txs[input.ordinal]!,old=tx.meta!,fee=input.fee??old.fee;
    if(!Number.isSafeInteger(fee)||fee<0||fee>old.preBalances[0]!)throw Error('invalid fixture failed fee');
    tx.meta={...old,fee,err:{InstructionError:[0,{Custom:9}]},postBalances:old.preBalances.map((n,i)=>n-(i===0?fee:0)),postTokenBalances:structuredClone(old.preTokenBalances!)};
    const connect=(signal:AbortSignal):MiningTaxFailureRpc=>{const rpc=f.chain.connect(signal);return {
     getGenesisHash:()=>rpc.getGenesisHash(),getSlot:c=>rpc.getSlot(c),getTransaction:(signature,options)=>rpc.getTransaction(signature,options),
     getMultipleAccountsInfoAndContext:async(keys,options)=>{const r=await rpc.getMultipleAccountsInfoAndContext(keys,options);return {context:r.context,value:r.value.map((row,i)=>row?{address:keys[i]!,owner:row.owner,executable:row.executable,data:row.data}:null)};},
    };};
    // Admission uses its own earlier Clock bank. Historical failure RPC uses
    // the receipt fixture's finalized bank/slot, so restore that exact encoded
    // Clock only for its owner read; never relax production bank consistency.
    const clock=f.chain.state.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!,oldClock=clock.data;clock.data=Buffer.from(f.chain.clock);
    try{return await createMiningTaxClaimFailure(f.conn.db,{connect,trust:f.chain.trust.mining})({...f.key,ordinal:input.ordinal});}finally{tx.meta=old;clock.data=oldClock;}
   },
   async restart(paused: boolean) {
    await app!.close(); await runtime.sql.end(); runtime = createDb(url.toString(), { max: 4 });
    process.env['PHASE_E_MINING_ENABLED'] = paused ? 'false' : 'true';
    app = await buildApp(config, runtime.db, paused ? {} : providers); await app.ready();
   },
   async inspect() { return { preparePosts, submitPosts, continuationPosts, sends: [...sends], signatures: [...signatures],
    wires: await rows('mining_tax_claim_signed_wires'), receipts: await rows('mining_tax_claim_receipts') }; },
   async close() { await app?.close(); await runtime.sql.end(); await f.conn.sql.unsafe(`drop owned by ${role}; drop role ${role}`); },
  };
 } catch (error) {
  await app?.close(); await runtime.sql.end(); await f.conn.sql.unsafe(`drop owned by ${role}; drop role ${role}`); throw error;
 }
}
export async function withMiningTaxApiFixture(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>, options: MiningTaxApiFixtureOptions) {
 const flags = { PHASE_E_MINING_ENABLED: 'true', PHASE_E_SEEKER_ENABLED: 'false', MULTI_BASE_ENABLED: 'false' };
 const previous = Object.fromEntries(Object.keys(flags).map(key => [key, process.env[key]]));
 Object.assign(process.env, flags);
 try {
  await withMiningTaxAdmissionFixture(async chain => {
   const fixture = await setup(chain, options); try { await run(fixture); } finally { await fixture.close(); }
  }, { mode: options.mode, persistSigned: false, ...(options.genesisHash ? { genesisHash: new PublicKey(options.genesisHash) } : {}) });
 } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
