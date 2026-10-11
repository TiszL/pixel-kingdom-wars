import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {createDb} from '../src/db/client';
import {createMiningTaxClaimPreparationRecord,getMiningTaxClaimPreparation,getMiningTaxClaimPreparationRecord,saveMiningTaxClaimPreparation} from '../src/mining/taxClaimPreparationStore';
import {withMiningTaxPreparationFixture} from './fixtures/miningTaxPreparation';
const meta=()=>({claimId:randomUUID(),preparedAt:new Date('2026-09-25T12:00:00.000Z')});
async function fixture(run:(f:Parameters<Parameters<typeof withMiningTaxPreparationFixture>[0]>[0],r:ReturnType<typeof createMiningTaxClaimPreparationRecord>)=>Promise<void>){
 return withMiningTaxPreparationFixture(async f=>run(f,createMiningTaxClaimPreparationRecord(f.wallet,f.request,await f.readQuote(),meta())));
}
describe('durable original KEEP tax consent',()=>{
 it('retains full original proof privately through reconnect while public history grants no new authority',async()=>fixture(async(f,r)=>{
  const a=r.artifact,key={wallet:a.wallet,idempotencyKey:a.idempotencyKey};expect(await getMiningTaxClaimPreparation(f.conn.db,key)).toBeNull();
  expect(await saveMiningTaxClaimPreparation(f.conn.db,r)).toEqual(a);
  const c=createDb(f.url.toString());try{expect(await getMiningTaxClaimPreparation(c.db,key)).toEqual(a);expect(await getMiningTaxClaimPreparationRecord(c.db,key)).toEqual(r);}finally{await c.sql.end();}
  expect(await getMiningTaxClaimPreparation(f.conn.db,{...key,wallet:f.buyer})).toBeNull();
  expect(Object.keys(a)).not.toContain('snapshotProof');expect(a.currentSigningAuthorized).toBe(false);expect(a.submissionAuthorized).toBe(false);
  expect(r.snapshot.term.auctions).toHaveLength(100);expect(typeof r.snapshot.term.completedSlot).toBe('bigint');
 }));
 it('stores canonical combined ATA, pool, epoch and cursor setup without truncating private proof',async()=>withMiningTaxPreparationFixture(async f=>{
  for(const key of ['pool','cursor','accrual','ata'] as const)f.chain.store.delete(f.chain.addresses[key].toBase58());
  const r=createMiningTaxClaimPreparationRecord(f.wallet,f.request,await f.readQuote(),meta());
  expect(r.artifact.transactions[0]!.kind).toBe('combined');expect(r.artifact.transactions[0]!.newAccounts).toHaveLength(4);
  await saveMiningTaxClaimPreparation(f.conn.db,r);expect(await getMiningTaxClaimPreparationRecord(f.conn.db,{wallet:f.wallet,idempotencyKey:f.request.idempotencyKey})).toEqual(r);
 }));
 it('concurrent identical intent retains one original observation and rejects changed caps, spot or round',async()=>fixture(async(f,r)=>{
  const later=structuredClone(r);later.artifact.claimId=randomUUID();
  const [a,b]=await Promise.all([saveMiningTaxClaimPreparation(f.conn.db,r),saveMiningTaxClaimPreparation(f.conn.db,later)]);expect(a).toEqual(b);
  for(const change of [{round:'1'},{spot:20},{caps:{...a.caps,maxFeeLamports:'9999'}}]){
   const bad={...r,artifact:{...r.artifact,...change}};await expect(saveMiningTaxClaimPreparation(f.conn.db,bad)).rejects.toMatchObject({code:expect.stringMatching(/REQUEST_CONFLICT|INVALID_INPUT/)});
  }
  expect(await f.conn.sql`select * from mining_tax_claim_preparations`).toHaveLength(1);
 }));
 it('refuses self-consistent message hash substitution, private snapshot drift and misbound actual quotes',async()=>fixture(async(f,r)=>{
  const bytes=Buffer.from(r.artifact.transactions[0]!.messageHex,'hex');bytes[bytes.length-1]=bytes[bytes.length-1]!^1;
  for(const mutate of [(x:typeof r)=>{x.artifact.transactions[0]!.messageHex=bytes.toString('hex');x.artifact.transactions[0]!.messageSha256=createHash('sha256').update(bytes).digest('hex');},
   (x:typeof r)=>{(x.snapshot as {wallet:string}).wallet=f.buyer;},(x:typeof r)=>{x.artifact.identity.cursor=x.artifact.identity.pool;},
   (x:typeof r)=>{x.artifact.intended.claimBaseUnits='1';},(x:typeof r)=>{x.artifact.source.snapshotSha256='00'.repeat(32);}]){
   const bad=structuredClone(r);mutate(bad);await expect(saveMiningTaxClaimPreparation(f.conn.db,bad)).rejects.toMatchObject({code:'INVALID_INPUT'});
  }
  const q=await f.readQuote();expect(()=>createMiningTaxClaimPreparationRecord(f.buyer,f.request,q,meta())).toThrow();
  expect(await f.conn.sql`select * from mining_tax_claim_preparations`).toHaveLength(0);
 }));
 it('keeps copied original evidence even if the supplied quote and returned artifact are mutated',async()=>fixture(async(f,r)=>{
  await saveMiningTaxClaimPreparation(f.conn.db,r);const expected=structuredClone(r);r.artifact.fees.totalLamports='1';
  const key={wallet:expected.artifact.wallet,idempotencyKey:expected.artifact.idempotencyKey};const first=await getMiningTaxClaimPreparationRecord(f.conn.db,key);first!.artifact.identity.term=expected.artifact.wallet;
  expect(await getMiningTaxClaimPreparationRecord(f.conn.db,key)).toEqual(expected);
 }));
 it('allows minimal runtime grants and rejects mutation even with mistakenly broad table grants',async()=>fixture(async(f,r)=>{
  const role=`tax_prepare_${randomUUID().replaceAll('-','')}`;await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant select,insert on mining_tax_claim_preparations to ${role}`);
  try{
   await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));expect(await saveMiningTaxClaimPreparation(tx,r)).toEqual(r.artifact);});
   await f.conn.sql.unsafe(`grant all on mining_tax_claim_preparations to ${role}`);
   for(const statement of ['update mining_tax_claim_preparations set artifact=artifact','delete from mining_tax_claim_preparations'])await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx.unsafe(statement);})).rejects.toThrow('MINING_TAX_PREPARATION_IMMUTABLE');
   // Retained child evidence now makes PostgreSQL reject TRUNCATE before its trigger.
   await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx.unsafe('truncate mining_tax_claim_preparations');})).rejects.toThrow('cannot truncate a table referenced in a foreign key constraint');
   expect(await getMiningTaxClaimPreparationRecord(f.conn.db,{wallet:r.artifact.wallet,idempotencyKey:r.artifact.idempotencyKey})).toEqual(r);
  }finally{await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }));
 it('SQL derives identity/digests, rejects hash forgery, oversized proof and non-READ-COMMITTED inserts',async()=>fixture(async(f,r)=>{
  await saveMiningTaxClaimPreparation(f.conn.db,r);const [row]=await f.conn.sql`select artifact,snapshot_text from mining_tax_claim_preparations`;
  const original=row!.artifact,proof=String(row!.snapshot_text);const next=()=>({...original,claimId:randomUUID(),idempotencyKey:randomUUID()});
  const bad=next();bad.transactions[0].messageSha256='00'.repeat(32);
  await expect(f.conn.sql`insert into mining_tax_claim_preparations(artifact,snapshot_text) values(${JSON.stringify(bad)}::jsonb,${proof})`).rejects.toThrow('MINING_TAX_PREPARATION_INPUT');
  await expect(f.conn.sql`insert into mining_tax_claim_preparations(wallet,artifact,snapshot_text) values(${f.wallet},${JSON.stringify(next())}::jsonb,${proof})`).rejects.toThrow('MINING_TAX_PREPARATION_DERIVED');
  await expect(f.conn.sql`insert into mining_tax_claim_preparations(artifact,snapshot_text) values(${JSON.stringify(next())}::jsonb,${' '.repeat(524289)})`).rejects.toThrow('MINING_TAX_PREPARATION_INPUT');
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into mining_tax_claim_preparations(artifact,snapshot_text) values(${JSON.stringify(next())}::jsonb,${proof})`;})).rejects.toThrow('MINING_TAX_PREPARATION_READ_COMMITTED');
 }));
 it('audits saved exact ABI at GET even when a raw SQL insert supplies a self-consistent byte hash',async()=>fixture(async(f,r)=>{
  await saveMiningTaxClaimPreparation(f.conn.db,r);const [row]=await f.conn.sql`select snapshot_text from mining_tax_claim_preparations`;
  const bad=structuredClone(r.artifact);bad.claimId=randomUUID();bad.idempotencyKey=randomUUID();const bytes=Buffer.from(bad.transactions[0]!.messageHex,'hex');bytes[bytes.length-1]=bytes[bytes.length-1]!^1;
  bad.transactions[0]!.messageHex=bytes.toString('hex');bad.transactions[0]!.messageSha256=createHash('sha256').update(bytes).digest('hex');
  await f.conn.sql`insert into mining_tax_claim_preparations(artifact,snapshot_text) values(${JSON.stringify(bad)}::jsonb,${String(row!.snapshot_text)})`;
  await expect(getMiningTaxClaimPreparation(f.conn.db,{wallet:bad.wallet,idempotencyKey:bad.idempotencyKey})).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 }));
 it('reapplies the additive migration without rewriting immutable original evidence',async()=>fixture(async(f,r)=>{
  await saveMiningTaxClaimPreparation(f.conn.db,r);for(let i=0;i<2;i++)for(const s of readFileSync(new URL('../drizzle/0186_mining_tax_claim_preparations.sql',import.meta.url),'utf8').split('--> statement-breakpoint').filter(x=>x.trim()))await f.conn.sql.unsafe(s);
  expect(await getMiningTaxClaimPreparationRecord(f.conn.db,{wallet:r.artifact.wallet,idempotencyKey:r.artifact.idempotencyKey})).toEqual(r);
 }));
});
