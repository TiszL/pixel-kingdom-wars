/** Independent receipt authority is reconstructed from the entire private
 * source graph, including exact original units, custody and pinned terms. */
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createHistoricalMineResolutionFixture} from './fixtures/historicalMineResolution';
import {hashPhysicalMineCustodyEvidence} from '../src/mining/shardsTaxMineCustody';
import {readHistoricalMineTaxSource} from '../src/mining/shardsTaxMineRecoveryHistory';
const conn=resourceClaimsDatabase();let fixture:Awaited<ReturnType<typeof createHistoricalMineResolutionFixture>>;
beforeAll(async()=>{await conn.setup();fixture=await createHistoricalMineResolutionFixture(conn);},120000);
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(fixture.verified);vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');});
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});afterAll(()=>conn.close());
type Source=Awaited<ReturnType<typeof fixture.createResolvedSource>>;
async function corruption(f:Source,change:(tx:Parameters<Parameters<typeof conn.db.transaction>[0]>[0])=>Promise<unknown>){
 const abort=Error('restore isolated corruption');
 await expect(conn.db.transaction(async tx=>{await tx.execute(sql`set local session_replication_role='replica'`);await change(tx);
  await expect(readHistoricalMineTaxSource(tx,f.resolution.children[0]!.segment.id)).rejects.toThrow();throw abort;
 })).rejects.toBe(abort);
}
describe.sequential('complete original Mine recovery history',()=>{
 it('reconstructs both original half-open terms with their actual late observations after a paused database reopen',async()=>{
  const f=await fixture.createResolvedSource();vi.stubEnv('PHASE_E_MINING_ENABLED','false');const reopened=conn.reopen();
  try{for(const child of f.resolution.children){const result=await readHistoricalMineTaxSource(reopened.db,child.segment.id);
   expect(result.original).toMatchObject({parentId:f.parent.id,childId:child.segment.id,wallet:f.wallet,baseId:f.base.id,firstUnit:child.segment.first_unit,lastUnit:child.segment.last_unit,resolvedAt:fixture.verified.toISOString()});
   expect(result.term).toEqual(child.certificate);expect(result).toMatchObject({postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false});
  }}finally{await reopened.sql.end();}
 });
 it('keeps immutable source identity stable while conserved quantities move into raid reservation',async()=>{
  const f=await fixture.createResolvedSource(),child=f.resolution.children[0]!.segment.id,before=await readHistoricalMineTaxSource(conn.db,child);
  await conn.sql`update shards_mine_segments set buffer=0,reserved=gross where id=${child}`;
  expect(await readHistoricalMineTaxSource(conn.db,child)).toEqual(before);
 });
 it('refuses an unresolved original parent instead of accepting its copied confirmed label',async()=>{
  const f=await fixture.createSource();await expect(readHistoricalMineTaxSource(conn.db,f.parent.id)).rejects.toThrow();
 });
 it.each(['parent identity','missing peer','missing certificate','child time','term domain'] as const)('holds corrupted %s before granting receipt source authority',async kind=>{
  const f=await fixture.createResolvedSource();await corruption(f,async tx=>{
   if(kind==='parent identity')await tx.execute(sql`update shards_mine_segments set source_key=source_key||':bad' where id=${f.parent.id}`);
   if(kind==='missing peer')await tx.execute(sql`delete from shards_mine_segments where id=${f.resolution.children[1]!.segment.id}`);
   if(kind==='missing certificate')await tx.execute(sql`delete from shards_mine_resolution_terms where segment_id=${f.resolution.children[1]!.segment.id}`);
   if(kind==='child time')await tx.execute(sql`update shards_mine_segments set starts_at=starts_at+interval '1 millisecond',ends_at=ends_at+interval '1 millisecond' where id=${f.resolution.children[0]!.segment.id}`);
   if(kind==='term domain')await tx.execute(sql`update shards_mine_resolutions set term_source=jsonb_set(term_source,'{genesisHash}','"unrelated"') where parent_id=${f.parent.id}`);
  });
 });
 it('recomputes full custody integrity and rejects a changed nested historical actor even with a recomputed digest',async()=>{
  const f=await fixture.createResolvedSource();await corruption(f,async tx=>{
   const [row]=await tx.execute<{custody:typeof f.resolution.header.custody}>(sql`select custody from shards_mine_resolutions where parent_id=${f.parent.id}`);
   const changed=JSON.parse(JSON.stringify(row!.custody));changed.evidence.rosters[0]!.wallet='unrelated';
   changed.evidence.custody.evidenceSha256=hashPhysicalMineCustodyEvidence(changed.evidence);changed.evidenceSha256=changed.evidence.custody.evidenceSha256;
   await tx.execute(sql`update shards_mine_resolutions set custody=${JSON.stringify(changed)}::jsonb where parent_id=${f.parent.id}`);
  });
 });
 it('holds custody observed after the immutable server verification time even when its digest is internally consistent',async()=>{
  const f=await fixture.createResolvedSource();await corruption(f,async tx=>{
   const [row]=await tx.execute<{custody:unknown}>(sql`select custody from shards_mine_resolutions where parent_id=${f.parent.id}`);
   const changed=JSON.parse(JSON.stringify(row!.custody));changed.evidence.rosters[0].observedAt=new Date(+fixture.verified+1).toISOString().replace('Z','000Z');
   changed.evidence.custody.evidenceSha256=hashPhysicalMineCustodyEvidence(changed.evidence);changed.evidenceSha256=changed.evidence.custody.evidenceSha256;
   await tx.execute(sql`update shards_mine_resolutions set custody=${JSON.stringify(changed)}::jsonb where parent_id=${f.parent.id}`);
  });
 });
 it('refuses a certificate whose independently pinned snapshot is missing',async()=>{
  const f=await fixture.createResolvedSource();await corruption(f,async tx=>{
   await tx.execute(sql`delete from expedition_term_snapshots where term_id=${f.resolution.children[0]!.termId}`);
  });
 });
});
