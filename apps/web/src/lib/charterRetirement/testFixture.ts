/** Synthetic finalized bank and real ephemeral signatures, never live authority. */
import {preparedRetirement} from '../../../../../packages/chain/src/testFixtures/charterRetirement';
import {CharterRetirementOperationSchema,CharterRetirementDraftSchema} from '@shardkeep/shared/charterRetirementApi';
import {PHASE_E_CHARTER_TRANSFER} from '@shardkeep/shared';
import type {RetirementSigningTrust} from './signing';
export async function retirementFixture(){
 const f=await preparedRetirement(),actor=f.leader.publicKey.toBase58();
 const operation=CharterRetirementOperationSchema.parse({version:1,original:f.original,status:'prepared',
  memberPayment:{id:'12345678-1234-4678-9abc-def012345686',totalShards:'100'},
  attempt:{id:'12345678-1234-4678-9abc-def012345685',candidateHex:f.quote.packetInput.candidateHex,policySigner:f.quote.packetInput.policySigner,quote:f.quote},
  preparation:{policySignatureHex:f.packetInput.policySignatureHex,packet:f.packet},signed:null,terminal:null,
  signingAuthorized:false,relayAuthorized:false,retirementAuthorized:false,fenceReleaseAuthorized:false});
 const trust:RetirementSigningTrust={version:1,revision:'owned-fixture',deployment:f.trust,policySigner:f.policy.publicKey.toBase58(),
  treasury:f.lookup.keys[11]!.toBase58(),royaltyBps:PHASE_E_CHARTER_TRANSFER.royaltyBps,lookupTables:[f.lookup.pin]};
 const draft=CharterRetirementDraftSchema.parse({version:1,id:'12345678-1234-4678-9abc-def012345687',actor,
  request:{clanId:f.original.creation.clanId,idempotencyKey:'12345678-1234-4678-9abc-def012345688'},
  clan:{id:f.original.creation.clanId,name:'Seafarers',tag:'SEA'},fenceId:f.original.retirement.fenceId,totalShards:'100',shares:[{wallet:actor,shards:'100'}],
  memberPayment:operation.memberPayment,operation,cancelled:false,signingAuthorized:false,relayAuthorized:false,retirementAuthorized:false,fenceReleaseAuthorized:false});
 return {...f,operation,actor,trust,draft};
}
