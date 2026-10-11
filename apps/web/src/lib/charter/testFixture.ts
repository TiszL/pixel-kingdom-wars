/** CPU vectors built by accepted chain compilers; no RPC, DB or sale clearance. */
import {createHash} from 'node:crypto';
import {Keypair,PublicKey,AddressLookupTableProgram,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram} from '@solana/web3.js';
import {CLANS,PHASE_E_CHARTER_PREPARATION,PHASE_E_CHARTER_TRANSFER,PHASE_E_POLICY} from '@shardkeep/shared';
import type {CharterCreationSigning,CharterSaleSigning} from '@shardkeep/shared/charterApi';
import {preparationFixture,candidateFor,sign} from '../../../../../packages/chain/src/testFixtures/charterPreparation';
import {buildCharterCreationPacket} from '../../../../../packages/chain/src/charterCreationPreparation';
import {buildCharterTransferPacket} from '../../../../../packages/chain/src/charterTransferPreparation';
import {charterPda,charterAssetPda,charterMintPda,charterFreezePda,charterExecutorPda,charterCreationPda,hashCharterMetadata} from '../../../../../packages/chain/src/charterProtocol';
import {charterTransferConfigPda,charterTransferAccounts,encodeCharterPurposePermit,hashCharterTransferPayload,CORE_PROGRAM} from '../../../../../packages/chain/src/charterTransferProtocol';
import {seekerAuthorityPda,seekerPermitReceiptPda} from '../../../../../packages/chain/src/seekerAuctionProtocol';
import type {CharterSigningTrust} from './signing';
const hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
export const fixtureUuid=(n:number)=>`12345678-1234-4678-9abc-${String(n).padStart(12,'0')}`;
/** Matches this closed ASCII D176 terms object, not a general JSON serializer. */
export function fixtureTermsJson(value:unknown):string{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 const v=value as Record<string,unknown>;return '{'+Object.keys(v).sort((a,b)=>Buffer.byteLength(a)-Buffer.byteLength(b)||Buffer.compare(Buffer.from(a),Buffer.from(b))).map(k=>JSON.stringify(k)+': '+fixtureTermsJson(v[k])).join(', ')+'}';
}
export function charterStaticKeys(economy:PublicKey,craft:PublicKey,treasury:PublicKey){
 const pda=(program:PublicKey,seed:string)=>PublicKey.findProgramAddressSync([Buffer.from(seed)],program)[0];
 return [seekerAuthorityPda(economy),pda(economy,'charter_config'),charterTransferConfigPda(economy),craft,pda(craft,'charter_control'),pda(craft,'charter_collection'),pda(craft,'charter_collection_authority'),CORE_PROGRAM,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId,economy,treasury];
}
export function charterClientFixture(){
 const f=preparationFixture(),economy=new PublicKey(f.original.chain.economyProgram),craft=new PublicKey(f.original.chain.craftProgram),treasury=Keypair.generate().publicKey;
 const staticKeys=charterStaticKeys(economy,craft,treasury);
 const data=Buffer.alloc(56+staticKeys.length*32);data.writeUInt32LE(1);data.writeBigUInt64LE((1n<<64n)-1n,4);data.writeBigUInt64LE(100n,12);staticKeys.forEach((k,i)=>k.toBuffer().copy(data,56+i*32));
 const lookupPin={address:Keypair.generate().publicKey.toBase58(),dataSha256:hash(data)},lookupTable={address:lookupPin.address,owner:AddressLookupTableProgram.programId.toBase58(),executable:false as const,dataHex:data.toString('hex'),slot:150};
 const trust:CharterSigningTrust={version:1,revision:'fixture-d180',deployment:f.trust,policySigner:f.policy.publicKey.toBase58(),treasury:treasury.toBase58(),royaltyBps:PHASE_E_CHARTER_TRANSFER.royaltyBps,lookupTables:[lookupPin]};
 const common={version:1 as const,deployment:f.trust,lookupTable,lookupPin,blockhash:f.blockhash,blockhashSlot:150,lastValidBlockHeight:300,observedSlot:150,observedUnixTimestamp:'1800000000',context:{feeSlot:150,closingSlot:150,closingGenesisHash:f.original.chain.genesisHash},signingAuthorized:false as const,relayAuthorized:false as const};
 function pair(n:number,maxMetadata=false,sellerLeaves=true){
  const creator=Keypair.generate(),buyer=Keypair.generate(),clanId=fixtureUuid(n),creationIntentId=fixtureUuid(n+10),asset=charterMintPda(craft,clanId);
  const name=maxMetadata?'X'.repeat(CLANS.nameMaxLen):'Fixture Clan',prefix=maxMetadata?'https://invalid.example/'+'x'.repeat(231)+'/':'https://invalid.example/charters/',uri=prefix+clanId;
  const original={...f.original,clanId,creationIntentId,payer:creator.publicKey.toBase58(),metadata:{name,uri,hash:hashCharterMetadata({name,uri}).toString('hex')},chain:{...f.original.chain,charter:charterPda(economy,clanId).toBase58(),asset:asset.toBase58(),assetBinding:charterAssetPda(economy,asset).toBase58(),freezeAuthority:charterFreezePda(craft,clanId).toBase58(),executor:charterExecutorPda(economy,clanId).toBase58(),creationReceipt:charterCreationPda(economy,creationIntentId).toBase58()}};
  const candidate=candidateFor(original);candidate.fill(n,73,89);const signature=sign(f.policy,candidate);
  const creationPacket=buildCharterCreationPacket({original,candidate,policySigner:trust.policySigner,policySignature:signature,lookupTable,expectedLookupTable:lookupPin,blockhash:f.blockhash,blockhashSlot:150,lastValidBlockHeight:300,currentBlockHeight:200});
  const allocations=[{kind:'charter',address:original.chain.charter,bytes:280},{kind:'assetBinding',address:original.chain.assetBinding,bytes:90},{kind:'creationReceipt',address:original.chain.creationReceipt,bytes:154},{kind:'permitReceipt',address:seekerPermitReceiptPda(economy,candidate.subarray(73,89)).toBase58(),bytes:107},{kind:'asset',address:original.chain.asset,bytes:137+Buffer.byteLength(name)+Buffer.byteLength(uri)}].map(a=>({...a,minimumBalanceLamports:'1000'}));
  const creation:CharterCreationSigning={...common,kind:'creation',attemptId:fixtureUuid(n+20),original,policy:{signer:trust.policySigner,candidateHex:candidate.toString('hex'),signatureHex:signature.toString('hex')},packet:creationPacket,costs:{allocations,networkFeeLamports:'10000',rentLamports:'5000',coreCreateFeeLamports:String(PHASE_E_CHARTER_PREPARATION.coreCreateFeeLamports),totalLamports:String(PHASE_E_CHARTER_PREPARATION.coreCreateFeeLamports+15000)},costLimits:{maxNetworkFeeLamports:'100000',maxRentLamports:'100000',maxTotalLamports:'2000000'},coreCostProfile:{version:1,profile:'mpl-core-0.15.2-charter-pfd-seq-none',reviewedProgramDataSha256:f.trust.core.reviewedProgramDataSha256}};
  const terms={version:1 as const,id:fixtureUuid(n+30),clanId,seller:creator.publicKey.toBase58(),buyer:buyer.publicKey.toBase58(),priceLamports:'101000003',sellerLeaves,domain:{genesisHash:f.original.chain.genesisHash,economyProgram:economy.toBase58(),craftProgram:craft.toBase58(),treasury:treasury.toBase58()},expectedRevision:0,epochId:fixtureUuid(100),fenceId:fixtureUuid(n+40),royaltyBps:PHASE_E_CHARTER_TRANSFER.royaltyBps};
  const termsHash=hash('SHARDKEEP_CHARTER_SALE_TERMS_V1'+fixtureTermsJson(terms)),domain={economy,craft,seller:creator.publicKey,buyer:buyer.publicKey,treasury},wireTerms={clanId,transferId:terms.id,fenceId:terms.fenceId,expectedRevision:0,priceLamports:BigInt(terms.priceLamports),termsHash:Buffer.from(termsHash,'hex')},permitId=Buffer.alloc(16,n+30);
  const saleCandidate=encodeCharterPurposePermit(new PublicKey(terms.domain.genesisHash),economy,1,buyer.publicKey,{permitId,expiry:1800000540n},hashCharterTransferPayload(domain,wireTerms)),saleSignature=sign(f.policy,saleCandidate),accounts=charterTransferAccounts(domain,wireTerms,permitId);
  const salePacket=buildCharterTransferPacket({original:{creation:{...original,issuedPermitIds:[candidate.subarray(73,89).toString('hex')]},sale:{id:terms.id,fenceId:terms.fenceId,seller:terms.seller,buyer:terms.buyer,treasury:terms.domain.treasury,expectedRevision:0,priceLamports:terms.priceLamports,termsHash}},candidateHex:saleCandidate.toString('hex'),policySigner:trust.policySigner,policySignatureHex:saleSignature.toString('hex'),lookupTable,expectedLookupTable:lookupPin,blockhash:f.blockhash,blockhashSlot:150,lastValidBlockHeight:300,currentBlockHeight:200});
  const royalty=BigInt(terms.priceLamports)*BigInt(PHASE_E_CHARTER_TRANSFER.royaltyBps)/BigInt(PHASE_E_POLICY.basisPoints);
  const sale:CharterSaleSigning={...common,kind:'sale',attemptId:fixtureUuid(n+50),original:{creation:original,terms,termsHash},policy:{signer:trust.policySigner,candidateHex:saleCandidate.toString('hex'),signatureHex:saleSignature.toString('hex')},packet:salePacket,costs:{priceLamports:terms.priceLamports,sellerLamports:(BigInt(terms.priceLamports)-royalty).toString(),royaltyLamports:royalty.toString(),networkFeeLamports:'15000',rentLamports:'2000',totalLamports:(BigInt(terms.priceLamports)+17000n).toString(),allocations:[{kind:'transfer-receipt',address:accounts.transferReceipt.toBase58(),bytes:338,minimumBalanceLamports:'1000'},{kind:'permit-receipt',address:accounts.receipt.toBase58(),bytes:107,minimumBalanceLamports:'1000'}]},costLimits:{maxNetworkFeeLamports:'100000',maxRentLamports:'100000',maxAdditionalLamports:'200000'}};
  return {creator,buyer,creation,sale};
 }
 return {trust,staticKeys,lookupPin,lookupTable,pair};
}
