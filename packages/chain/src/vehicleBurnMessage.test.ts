import {describe,it,expect} from 'vitest';
import {Keypair,PublicKey,Message,Transaction,VersionedTransaction,SystemProgram} from '@solana/web3.js';
import {burnV1,MPL_CORE_PROGRAM_ID} from '@metaplex-foundation/mpl-core';
import {createNoopSigner,publicKey} from '@metaplex-foundation/umi';
import {buildVehicleBurnMessage} from './vehicleBurnMessage';
const pk=()=>Keypair.generate().publicKey.toBase58();
export function vehicleBurnFixture(){
 const wallet=Keypair.generate();return {wallet,input:{wallet:wallet.publicKey.toBase58(),reservationId:'ac2ee077-1c46-4fb0-8c35-cb331613e054',
  identity:{assetId:pk(),collection:pk(),family:'survey_balloon' as const,tier:1 as const},blockhash:pk()}};
}
describe('reserved vehicle burn message',()=>{
 it('matches the installed Core burnV1 instruction and adds one reservation-bound signed memo',()=>{
  const f=vehicleBurnFixture(),plan=buildVehicleBurnMessage(f.input),m=Message.from(plan.messageBytes),ix=Transaction.populate(m).instructions;
  const signer=createNoopSigner(publicKey(f.input.wallet));
  const official=burnV1({payer:signer,programs:{getPublicKey:()=>MPL_CORE_PROGRAM_ID} as never},{asset:publicKey(f.input.identity.assetId),
   collection:publicKey(f.input.identity.collection),payer:signer,authority:signer,systemProgram:publicKey(SystemProgram.programId.toBase58())}).getInstructions()[0]!;
  expect(ix).toHaveLength(2);expect(ix[0]!.programId.toBase58()).toBe(official.programId);
  expect(ix[0]!.data).toEqual(Buffer.from(official.data));expect(ix[0]!.keys.map(k=>k.pubkey.toBase58())).toEqual(official.keys.map(k=>k.pubkey));
  expect(ix[1]!.programId.toBase58()).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
  expect(ix[1]!.data.toString()).toBe(`shardkeep:vehicle-install:v1:${f.input.reservationId}:survey_balloon:1`);
  expect(ix[1]!.keys.map(k=>k.pubkey.toBase58())).toEqual([f.input.wallet]);
  expect(m.header.numRequiredSignatures).toBe(1);expect(m.accountKeys[0]!.toBase58()).toBe(f.input.wallet);
  expect(plan.packetBytes).toBeLessThanOrEqual(1232);expect(plan).toMatchObject({signingAuthorized:false,broadcastAuthorized:false});
 });
 it('binds each independent reservation, registry identity and wallet into different signed consent',()=>{
  const f=vehicleBurnFixture(),original=buildVehicleBurnMessage(f.input).messageSha256;
  for(const patch of [{reservationId:'ac2ee077-1c46-4fb0-8c35-cb331613e055'},{wallet:pk()},{blockhash:pk()},
   {identity:{...f.input.identity,assetId:pk()}},{identity:{...f.input.identity,collection:pk()}},
   {identity:{...f.input.identity,family:'cargo_cutter'}},{identity:{...f.input.identity,tier:2}}])
   expect(buildVehicleBurnMessage({...f.input,...patch} as never).messageSha256).not.toBe(original);
 });
 it('owns returned bytes and rejects client-injected instructions, authority, aliases and malformed scope',()=>{
  const f=vehicleBurnFixture(),plan=buildVehicleBurnMessage(f.input),before=plan.messageBytes;plan.messageBytes.fill(0);expect(plan.messageBytes).toEqual(before);
  for(const patch of [{instructions:[]},{burnVerified:true},{reservationId:f.input.reservationId.toUpperCase()},{reservationId:'x'},{reservationId:f.input.reservationId+'\n'},
   {blockhash:'bad'},{wallet:PublicKey.default.toBase58()},{wallet:PublicKey.findProgramAddressSync([Buffer.of(1)],new PublicKey(MPL_CORE_PROGRAM_ID))[0].toBase58()},
   {identity:{...f.input.identity,assetId:f.input.wallet}},{identity:{...f.input.identity,collection:f.input.wallet}},
   {identity:{...f.input.identity,collection:MPL_CORE_PROGRAM_ID}},{identity:{...f.input.identity,family:'starter'}}])
   expect(()=>buildVehicleBurnMessage({...f.input,...patch} as never)).toThrow();
 });
 it('creates locally signable bytes without signing or broadcasting during preparation',()=>{
  const f=vehicleBurnFixture(),plan=buildVehicleBurnMessage(f.input),tx=new VersionedTransaction(Message.from(plan.messageBytes));
  tx.sign([f.wallet]);expect(Transaction.from(tx.serialize()).verifySignatures()).toBe(true);expect(tx.serialize()).toHaveLength(plan.packetBytes);
 });
});
