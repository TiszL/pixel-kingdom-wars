/** Saved original projection only. None of these facts becomes client trust. */
import {PHASE_E_CHARTER_TRANSFER} from '@shardkeep/shared';
import {CharterCreationSigningSchema,CharterSaleSigningSchema} from '@shardkeep/shared/charterApi';
import {verifyCharterTransferQuote} from '@shardkeep/chain/charter-transfer-preparation';
import type {SaleState} from '../db/charterSales';
import type {CharterCreationPreparationState} from './clanCharterCreationPreparation';
const json=(value:unknown)=>JSON.parse(JSON.stringify(value,(_key,v:unknown)=>typeof v==='bigint'?v.toString():v)) as unknown;
export function creationClientSigning(state:CharterCreationPreparationState|null){
 if(!state?.preparation)return null;
 const {quote,id,candidateHex,policySigner}=state.attempt,p=quote.packetInput,source=quote.observation.source;
 // The verified quote fixes the reviewed program roster in economy/craft/Core order.
 return CharterCreationSigningSchema.parse(json({version:1,kind:'creation',attemptId:id,original:p.original,
  deployment:{expectedGenesisHash:source.genesisHash,economy:source.programs[0],craft:source.programs[1],core:source.programs[2],stateProvenance:source.stateProvenance},
  policy:{signer:policySigner,candidateHex,signatureHex:state.preparation.policySignatureHex},lookupTable:p.lookupTable,lookupPin:p.expectedLookupTable,
  blockhash:p.blockhash,blockhashSlot:p.blockhashSlot,lastValidBlockHeight:p.lastValidBlockHeight,packet:state.preparation.packet,
  costs:quote.costs,costLimits:quote.costLimits,coreCostProfile:quote.coreCostProfile,observedSlot:quote.observation.slot,observedUnixTimestamp:quote.observation.unixTimestamp,
  context:quote.context,signingAuthorized:false,relayAuthorized:false}));
}
export function saleClientSigning(state:SaleState){
 if(!state.preparation)return null;
 if(!state.attempt)throw Error('Missing immutable Charter sale attempt');
 const {quote:raw,id,candidateHex,policySigner}=state.attempt,quote=verifyCharterTransferQuote(raw),p=quote.packetInput,s=state.original;
 const {issuedPermitIds:_history,...creation}=p.original.creation;
 return CharterSaleSigningSchema.parse({version:1,kind:'sale',attemptId:id,
  original:{creation,terms:{version:1,id:s.id,clanId:s.clanId,seller:s.seller,buyer:s.buyer,priceLamports:s.priceLamports,sellerLeaves:s.sellerLeaves,
   domain:s.domain,expectedRevision:s.expectedRevision,epochId:s.epochId,fenceId:s.fenceId,royaltyBps:PHASE_E_CHARTER_TRANSFER.royaltyBps},termsHash:s.termsHash},
  deployment:quote.observation.source.programs,policy:{signer:policySigner,candidateHex,signatureHex:state.preparation.policySignatureHex},
  lookupTable:p.lookupTable,lookupPin:p.expectedLookupTable,blockhash:p.blockhash,blockhashSlot:p.blockhashSlot,lastValidBlockHeight:p.lastValidBlockHeight,
  packet:state.preparation.packet,costs:quote.costs,costLimits:quote.costLimits,observedSlot:quote.observation.slot,observedUnixTimestamp:quote.observation.unixTimestamp,
  context:quote.context,signingAuthorized:false,relayAuthorized:false});
}
