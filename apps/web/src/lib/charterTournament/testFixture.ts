/** CPU-only synthetic fixture with real throwaway signatures; never production import. */
import {createHash} from 'node:crypto';
import {lockFixture} from '../../../../../packages/chain/src/testFixtures/charterLock';
import {createCharterLockQuoteReader,buildCharterLockPacket} from '../../../../../packages/chain/src/charterLockPreparation';
import {CHARTER_TOURNAMENT_POLICY,CharterTournamentBudgetSchema,tournamentSchedule} from '@shardkeep/shared/charterTournament';
import {ORDINARY_REFINED_IDS} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {CharterTournamentOperationSchema,postgresJsonbText,type CharterTournamentOperationTerms} from '@shardkeep/shared/charterTournamentApi';
import {PHASE_E_CHARTER_TRANSFER} from '@shardkeep/shared';
import type {TournamentSigningTrust} from './signing';
export async function tournamentFixture(action:'set'|'clear'='set'){
 const f=lockFixture(action),actor=f.leader.publicKey.toBase58(),op=f.original.operation,domain={genesisHash:f.original.creation.chain.genesisHash,economyProgram:f.original.creation.chain.economyProgram,craftProgram:f.original.creation.chain.craftProgram,treasury:f.lookup.keys[11]!.toBase58()},budget=CharterTournamentBudgetSchema.parse(Object.fromEntries(ORDINARY_REFINED_IDS.map(i=>[i,'100'])));
 const event={version:1 as const,id:op.eventId,domain,sponsorWallet:actor,...tournamentSchedule('2026-10-03T00:00:00.000Z'),policy:CHARTER_TOURNAMENT_POLICY,budget};
 const terms:CharterTournamentOperationTerms={version:1,epochId:'12345678-1234-4678-9abc-def012345684',entryId:op.fenceId,eventId:op.eventId,clanId:f.original.creation.clanId,leader:actor,lockId:op.lockId,fenceId:op.fenceId,operationId:op.id,action,expectedRevision:op.expectedRevision,domain,event,roster:[actor],clearance:action==='set'?null:{version:1,eventId:op.eventId,completedAt:event.playEndsAt,rankings:[],occupations:[],entitlements:[]}};
 const original={...f.original,operation:{...op,termsHash:createHash('sha256').update('SHARDKEEP_CHARTER_TOURNAMENT_LOCK_TERMS_V1'+postgresJsonbText(terms)).digest('hex')}};
 const quote=await createCharterLockQuoteReader(f.connect,f.options)(original,f.permitId),policySignatureHex=f.sign(f.policy,Buffer.from(quote.packetInput.candidateHex,'hex')).toString('hex'),packet=buildCharterLockPacket({...quote.packetInput,policySignatureHex});
 const operation=CharterTournamentOperationSchema.parse({version:1,original,operationTerms:terms,status:'prepared',entryId:op.fenceId,attempt:{id:'12345678-1234-4678-9abc-def012345685',candidateHex:quote.packetInput.candidateHex,policySigner:quote.packetInput.policySigner,quote},preparation:{policySignatureHex,packet},signed:null,terminal:null,inventory:{version:1,revision:'1',count:1,messages:[quote.packetInput.candidateHex]}});
 const trust:TournamentSigningTrust={version:1,revision:'owned-fixture',deployment:f.trust,policySigner:f.policy.publicKey.toBase58(),treasury:domain.treasury,royaltyBps:PHASE_E_CHARTER_TRANSFER.royaltyBps,lookupTables:[f.lookup.pin]};
 const entry={version:1 as const,id:op.fenceId,eventId:op.eventId,clanId:original.creation.clanId,leader:actor,epochId:terms.epochId,lockId:op.lockId,roster:[actor],status:'pending' as const,set:operation,clear:null};
 return {...f,original,actor,terms,event:{...event,terminal:null},operation,entry,trust};
}
