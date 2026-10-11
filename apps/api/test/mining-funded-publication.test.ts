import { describe,expect,it } from 'vitest';
import { withFundedMiningFixture as fixture } from './fixtures/fundedMining';
import { getPreparedMiningPublication } from '../src/mining/publicationPreparation';

describe('source-derived ordinary paid and free funded mining',()=>{
  it('prepares both disjoint funded pools from actual paid inputs and preserves the original providerless message',async()=>fixture(async f=>{
    const p=await f.stage(),result=await p.prepare(p.request);
    expect(result.status).toBe('prepared'); if(result.status!=='prepared')throw Error('Useful funded source was not prepared');
    expect(BigInt(result.publication.freeGross)).toBeGreaterThan(0n);expect(BigInt(result.publication.deedGross)).toBeGreaterThan(0n);
    expect(BigInt(result.publication.playerNet)+BigInt(result.publication.recycle)+BigInt(result.publication.tax)).toBe(BigInt(result.publication.freeGross)+BigInt(result.publication.deedGross));
    const m=JSON.parse(result.manifestJson);expect(m.awards.map((a:{wallet:string})=>a.wallet).sort()).toEqual([f.wallet,f.buyer].sort());
    expect(m.awards.every((a:{renown:string;days:string})=>a.renown==='1'&&a.days==='1')).toBe(true);
    expect(await getPreparedMiningPublication(f.conn.db,p.request.epochId)).toEqual(result);
    expect(await f.conn.sql`select * from mining_ingot_dispositions where epoch_id=${p.request.epochId}`).toHaveLength(0);
  }));
  it('returns sold-and-reacquired paid inputs while still funding the eligible deedless pool',async()=>fixture(async f=>{
    const p=await f.stage('2020-01-01',{outBack:true}),result=await p.prepare(p.request);
    expect(result.status).toBe('prepared');if(result.status!=='prepared')throw Error('Free pool should remain useful');
    expect(result.publication.deedGross).toBe('0');expect(BigInt(result.publication.freeGross)).toBeGreaterThan(0n);
    const m=JSON.parse(result.manifestJson),paid=m.reservations.find((r:{baseId:string})=>r.baseId===f.paidBaseId);
    expect(paid).toMatchObject({proposedConsumed:0,proposedReturned:1});
    expect(m.awards.find((a:{wallet:string})=>a.wallet===f.buyer)).toMatchObject({net:'0',renown:'0',days:'0'});
  }));
});
