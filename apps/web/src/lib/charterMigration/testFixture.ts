/** CPU-only existing-clan snapshot and actual registration compiler/signatures. */
import {CharterMigrationSchema} from '@shardkeep/shared/charterMigrationApi';
import {charterClientFixture,fixtureUuid} from '../charter/testFixture';
import {prepareCharterSigning,signCharter} from '../charter/signing';
export function migrationFixture(n=31){
 const f=charterClientFixture(),pair=f.pair(n),signing=pair.creation,actor=pair.creator.publicKey.toBase58();
 const migration=CharterMigrationSchema.parse({version:1,id:signing.original.creationIntentId,actor,request:{clanId:signing.original.clanId,idempotencyKey:fixtureUuid(n+1000)},
  snapshot:{clan:{id:signing.original.clanId,name:signing.original.metadata.name,tag:'OLD',inviteMode:'open'},memberCount:3,chestShards:'217',capturedAt:'2026-09-30T00:00:00.000Z',commitment:signing.original.admissionCommitment},
  original:signing.original,status:'prepared',signing,wire:null,terminal:null,signingAuthorized:false,relayAuthorized:false,migrationAuthorized:false,fenceReleaseAuthorized:false});
 const review=()=>prepareCharterSigning(signing,f.trust,actor);
 const sign=async()=>{const prepared=await review(),signed=await signCharter(prepared,{publicKey:pair.creator.publicKey,signVersionedTransaction:async tx=>{tx.sign([pair.creator]);return tx;}});if(signed.kind!=='creation')throw Error('Wrong fixture signature');return signed.wire;};
 return {...f,...pair,migration,actor,review,sign,identity:{origin:'https://game.example',api:'https://game.example/api',cluster:'devnet' as const,wallet:actor}};
}
