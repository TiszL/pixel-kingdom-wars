/** S5-held SQL consistency only. Candidate authority comes from the actual
 * private resolution writer, strict reader, kernel and ledger posting. */
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createHistoricalMineResolutionFixture} from './fixtures/historicalMineResolution';
import {readHistoricalMineTaxSource,historicalMineTaxSource} from '../src/mining/shardsTaxMineRecoveryHistory';
import {attributeHistoricalMineTax} from '../src/mining/shardsTaxMineHistoricalAttribution';
import {SHARDS_TAX_LINEAGE} from '../src/mining/shardsTaxAttribution';
import {bootstrapSystemAccounts,getOrCreateBaseAccount,postTransaction} from '../src/ledger';
const conn=resourceClaimsDatabase();
let fixture:Awaited<ReturnType<typeof createHistoricalMineResolutionFixture>>;
const encode=(v:unknown)=>JSON.stringify(v,(_key,value)=>typeof value==='bigint'?value.toString():value);
beforeAll(async()=>{await conn.setup();fixture=await createHistoricalMineResolutionFixture(conn);},120000);
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(fixture.verified);vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');});
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});afterAll(()=>conn.close());
async function insert(kind='valid'){
 const f=await fixture.createResolvedSource(),part=f.resolution.children[0]!,evidence=await readHistoricalMineTaxSource(conn.db,part.segment.id),key='mine.collect:'+f.mine.id+':fixture:'+randomUUID();
 const rollback=Error('rollback SQL-only candidate');
 await expect(conn.db.transaction(async tx=>{
  const sys=await bootstrapSystemAccounts(tx),dest=await getOrCreateBaseAccount(tx,f.base.id,'base_shards'),gross=BigInt(part.segment.gross);
  const receipt=attributeHistoricalMineTax({source:historicalMineTaxSource(evidence,gross,key,randomUUID()),original:evidence.original,term:evidence.term,
   carry:{wallet:f.wallet,currency:'SHARDS',lineage:SHARDS_TAX_LINEAGE,sequence:0n,value:0n}});
  const posted=await postTransaction(tx,{idempotencyKey:key,type:kind==='wrong ledger type'?'fixture.unrelated':'mine.collect',metadata:{baseId:f.base.id,mineBuildingId:f.mine.id},
   entries:[{account:sys.shard_genesis,delta:-gross},...(receipt.net?[{account:dest.id,delta:receipt.net}]:[]),...(receipt.tax?[{account:sys.shards_tax_escrow,delta:receipt.tax}]:[])]});
  await tx.execute(sql`insert into shards_mine_deliveries(operation_key,segment_id,destination_base_id,gross,net,tax,ledger_id) values(${key},${part.segment.id},${f.base.id},${gross.toString()},${receipt.net.toString()},${receipt.tax.toString()},${posted.transaction.id})`);
  const body=JSON.parse(encode({...receipt,source:{...receipt.source,ledger:{transactionId:posted.transaction.id,idempotencyKey:key}}}));
  if(kind==='wrong version')body.version=1;
  if(kind==='authority flag')body.postingAuthorized=true;
  if(kind==='changed certificate')body.term.finality.observedAt=new Date(+fixture.verified-1).toISOString();
  if(kind==='copied source')body.source.key='unrelated:'+key;
  if(kind==='changed earning')body.source.earning.at=new Date(Date.parse(body.source.earning.at)+1).toISOString();
  if(kind==='changed parent'||kind==='missing certificate'){
   await tx.execute(sql`set local session_replication_role='replica'`);
   if(kind==='changed parent')await tx.execute(sql`update shards_mine_segments set source_key=source_key||':changed' where id=${f.parent.id}`);
   if(kind==='missing certificate')await tx.execute(sql`delete from shards_mine_resolution_terms where segment_id=${part.segment.id}`);
   await tx.execute(sql`set local session_replication_role='origin'`);
  }
  let rejected=false;
  try{await tx.execute(sql`insert into shards_tax_assessments(operation_key,segment_id,wallet,wallet_sequence,lineage,gross,net,tax,carry_before,carry_after,term_id,term_hash,ledger_id,receipt)
   values(${key},${part.segment.id},${f.wallet},1,${SHARDS_TAX_LINEAGE},${gross.toString()},${receipt.net.toString()},${receipt.tax.toString()},0,${receipt.carryAfter.value.toString()},${part.termId},${part.termHash},${posted.transaction.id},${JSON.stringify(body)}::jsonb)`);}catch{rejected=true;}
  expect(rejected,kind).toBe(kind!=='valid');
  if(kind==='valid')await tx.execute(sql`set constraints all immediate`);throw rollback;
 })).rejects.toBe(rollback);
 expect(await conn.sql`select operation_key from shards_tax_assessments where wallet=${f.wallet}`).toHaveLength(0);
 expect(await conn.sql`select id from ledger_transactions where idempotency_key=${key}`).toHaveLength(0);
}
describe.sequential('held historical Mine assessment SQL',()=>{
 it('accepts actual private original evidence beside its exact delivery and ledger',()=>insert());
 it.each(['wrong version','authority flag','changed certificate','copied source','changed earning','wrong ledger type','changed parent','missing certificate'])('rejects %s before accepting historical assessment consistency',kind=>insert(kind));
 it('leaves the original cache/Mine/common checks byte-identical and does not replace the deferred prefix guard',async()=>{
  const old=await readFile(new URL('../drizzle/0195_shards_cache_sources.sql',import.meta.url),'utf8'),next=await readFile(new URL('../drizzle/0202_shards_mine_resolution_contract.sql',import.meta.url),'utf8');
  const name='CREATE OR REPLACE FUNCTION public.shardkeep_shards_assessment_insert_guard()',prior=old.slice(old.indexOf(name)).split('END $$;')[0]+'END $$;';
  const withoutBranch=next.slice(next.indexOf(name)).replace(/\n -- BEGIN HISTORICAL MINE CHILD[\s\S]*? -- END HISTORICAL MINE CHILD\n/,'\n').replace(';historical record;',';');
  expect(withoutBranch.trim()).toBe(prior.trim());expect(next).not.toContain('CREATE OR REPLACE FUNCTION public.shardkeep_shards_assessment_prefix_guard');
 });
});
