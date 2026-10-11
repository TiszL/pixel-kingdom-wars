import {describe,it,expect} from 'vitest';
import {encodeCharterPurposePermit,hashCharterTransferPayload} from './charterTransferProtocol';
import {createCharterTransferCancellationReader} from './charterTransferCancellation';
import {transferPreparationFixture} from './testFixtures/charterTransferPreparation';
describe('ordinary Charter cancellation original inventory',()=>{
 it('proves expired complete inventory and unchanged original registry without current signer or admission',async()=>{
  const f=transferPreparationFixture();f.authorityData[147]=1;f.get('craftControl').data[137]=1;
  const candidate=encodeCharterPurposePermit(f.genesis,f.domain.economy,1,f.buyer.publicKey,{permitId:f.permitId,expiry:1_800_000_009n},hashCharterTransferPayload(f.domain,f.terms)).toString('hex');
  const read=createCharterTransferCancellationReader(f.connect,f.trust,async()=>({original:f.original,inventory:{version:1,revision:'1',count:1,messages:[candidate]}}));
  const result=await read(f.original.sale.id);expect(result.outcome).toBe('absent-after-expiry');expect(result.fenceReleaseAuthorized).toBe(false);
 });
 it('never treats an exact-expiry bank as impossibility of late execution',async()=>{
  const f=transferPreparationFixture();const candidate=encodeCharterPurposePermit(f.genesis,f.domain.economy,1,f.buyer.publicKey,{permitId:f.permitId,expiry:1_800_000_010n},hashCharterTransferPayload(f.domain,f.terms)).toString('hex');
  await expect(createCharterTransferCancellationReader(f.connect,f.trust,async()=>({original:f.original,inventory:{version:1,revision:'1',count:1,messages:[candidate]}}))(f.original.sale.id)).rejects.toMatchObject({code:'LIVE_PERMIT'});
 });
 it('supports never-issued cancellation only with actual original bank proof',async()=>{
  const f=transferPreparationFixture(),load=async()=>({original:f.original,inventory:{version:1 as const,revision:'0',count:0,messages:[]}});
  expect((await createCharterTransferCancellationReader(f.connect,f.trust,load)(f.original.sale.id)).outcome).toBe('absent-after-expiry');
  f.get('charter').data.writeUInt32LE(3,153);
  await expect(createCharterTransferCancellationReader(f.connect,f.trust,load)(f.original.sale.id)).rejects.toThrow();
 });
 it('rejects a newer Clock mixed with older receipt absence instead of releasing a possibly completed sale',async()=>{
  const f=transferPreparationFixture(),load=async()=>({original:f.original,inventory:{version:1 as const,revision:'0',count:0,messages:[]}}),read=createCharterTransferCancellationReader(f.connect,f.trust,load);
  expect((await read(f.original.sale.id)).outcome).toBe('absent-after-expiry');f.rows.find(r=>r.data.length===40)!.data.writeBigUInt64LE(151n);
  await expect(read(f.original.sale.id)).rejects.toThrow();
 });
 it('holds missing or inconsistent retained exposure rather than treating it as zero',async()=>{
  const f=transferPreparationFixture();
  const read=createCharterTransferCancellationReader(f.connect,f.trust,async()=>({original:f.original,inventory:{version:1,revision:'1',count:1,messages:[]}}));
  await expect(read(f.original.sale.id)).rejects.toThrow();expect(f.connect).not.toHaveBeenCalled();
 });
});
