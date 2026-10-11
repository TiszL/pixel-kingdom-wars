/** SQL must reject an invented cumulative predecessor independently of the
 * application auditor; the existing signed root and daily stock stay intact. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMiningBackingSnapshotReader } from '@shardkeep/chain/mining-backing';
import { createCumulativeFreeAllocationPlanner } from '../src/mining/initialFreeAllocation';
import { loadAuditedMiningPriorForBacking } from '../src/mining/publicationHistory';
import { miningPublicationMessage, miningPublicationSchema } from '../src/mining/publicationEnvelope';
import { withCumulativeFreePublicationFixture as fixture } from './fixtures/cumulativeFreePublication';
const canonical=(v:unknown):string=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v!==null&&typeof v==='object'?`{${Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`:JSON.stringify(v);

describe('cumulative publication SQL predecessor guard', () => {
 it('rejects substituted predecessor facts before consuming stock and preserves receipts through migration replay', async () => fixture(async f => {
  const first=await f.first(),stage=await f.stageDay('2020-01-02');
  const {attemptKey,...request}=stage.request;
  const plan=await createCumulativeFreeAllocationPlanner(f.conn.db,{...stage.sources,
   loadPrior:(bank,signal)=>loadAuditedMiningPriorForBacking(f.conn.db,bank,signal)})(request);
  if(plan.projection!=='READY')throw Error('Expected useful allocation');
  const snapshot=await createMiningBackingSnapshotReader(stage.backing.reader,stage.backing.trust)();
  const fields=plan.publication as unknown as Record<string,unknown>;
  const publication=miningPublicationSchema.parse({...Object.fromEntries(Object.entries(first.prepared.publication).map(([key,value])=>{
   const next=Object.hasOwn(fields,key)?fields[key]:value;return [key,typeof next==='bigint'?String(next):next];
  })),blockhashContextSlot:snapshot.slot,lastValidBlockHeight:snapshot.slot+200});
  const intent=miningPublicationMessage(publication,plan.sourceHash);
  const original=JSON.parse(plan.manifestJson),before=await f.conn.sql`select * from mining_publication_settlements order by epoch_id`;
  for(const key of ['sourceHash','signature','messageSha256','wireSha256','publicationSlot','root','total','leafCount','sequence','day']){
   const bad=structuredClone(original);bad.previousPublication[key]=key==='publicationSlot'||key==='leafCount'?0:'0';
   await expect(f.conn.sql.begin(async tx=>{
    await tx`insert into mining_publication_attempts(epoch_id,attempt_key,intent_bytes) values(${request.epochId},${attemptKey},${intent})`;
    await tx`insert into mining_publication_manifests(epoch_id,manifest_json,publication) values(${request.epochId},${canonical(bad)},${JSON.stringify(publication)}::jsonb)`;
   })).rejects.toThrow('MINING_SETTLEMENT_PREDECESSOR');
  }
  for(const change of [{sequence:'3'},{day:first.prepared.publication.day},{total:String(BigInt(publication.total)+1n)},{reserveOwner:f.buyer}]){
   await expect(f.conn.sql.begin(async tx=>{
    await tx`insert into mining_publication_attempts(epoch_id,attempt_key,intent_bytes) values(${request.epochId},${attemptKey},${intent})`;
    await tx`insert into mining_publication_manifests(epoch_id,manifest_json,publication) values(${request.epochId},${plan.manifestJson},${JSON.stringify({...publication,...change})}::jsonb)`;
   })).rejects.toThrow('MINING_SETTLEMENT_PREDECESSOR');
  }
  expect(await f.conn.sql`select * from mining_publication_settlements order by epoch_id`).toEqual(before);
  expect(await f.conn.sql`select epoch_id from mining_publication_attempts where epoch_id=${request.epochId}`).toHaveLength(0);
  const published=await stage.publish();
  const migration=readFileSync(new URL('../drizzle/0177_mining_cumulative_publications.sql',import.meta.url),'utf8');
  for(let i=0;i<2;i++)await f.conn.sql.begin(async tx=>{for(const statement of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await tx.unsafe(statement);});
  expect(await published.settle()).toEqual(published.settlement);
  expect(await f.conn.sql`select * from mining_publication_settlements where epoch_id=${first.prepared.epochId}`).toEqual(before);
  const [counts]=await f.conn.sql`select count(*)::int count from mining_ingot_dispositions where epoch_id=${request.epochId}`;
  expect(counts?.count).toBe(1);
 }),120_000);
});
