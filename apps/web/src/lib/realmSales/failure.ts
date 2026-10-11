/** Binds an owner's historical failure attestation to the buyer's exact signed
 * consent and independent application pins. This does not authenticate browser
 * RPC finality, authorize a replacement purchase, or clear a durable journal. */
import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {RealmSalePreparationSchema,RealmSaleSignedWireSchema} from '@shardkeep/shared/realmSalesApi';
import {validateRealmSaleFailure,type RealmSaleFailureView} from '@shardkeep/shared/realmSaleFailureApi';
import {prepareRealmSaleSigning,verifySignedRealmSale,type RealmSaleSigningTrust} from './signing';
export interface RealmSaleFailureTrust extends RealmSaleSigningTrust{readonly upgradeAuthority:string|null}
export interface BoundRealmSaleFailure{
 readonly failure:RealmSaleFailureView;readonly browserFinalityVerified:false;readonly currentSigningAuthorized:false;readonly broadcastAuthorized:false;readonly journalClearingAuthorized:false;
}
export class RealmSaleFailureError extends Error{constructor(readonly code:'INPUT'|'TRUST'|'ACCOUNTS'|'WIRE'){super(`Realm sale failure evidence refused: ${code}`);this.name='RealmSaleFailureError';}}
function need(value:unknown,code:RealmSaleFailureError['code']):asserts value{if(!value)throw new RealmSaleFailureError(code);}
function key(value:string):PublicKey{try{const result=new PublicKey(value);need(result.toBase58()===value&&!result.equals(PublicKey.default),'ACCOUNTS');return result;}catch{throw new RealmSaleFailureError('ACCOUNTS');}}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),SYSVAR='Sysvar1111111111111111111111111111111111111';
export async function verifyRealmSaleFailure(preparation:unknown,wireMetadata:unknown,raw:unknown,trust:RealmSaleFailureTrust):Promise<BoundRealmSaleFailure>{
 const p=RealmSalePreparationSchema.parse(preparation),w=RealmSaleSignedWireSchema.parse(wireMetadata),failure=validateRealmSaleFailure(p,w,raw);
 need(trust&&typeof trust==='object','TRUST');
 // Copy every independent pin before the first await. Never derive trust from
 // the response being verified, or follow a mutable current deployment here.
 const pins:RealmSaleFailureTrust={genesisHash:trust.genesisHash,programId:trust.programId,developer:trust.developer,reviewedProgramDataSha256:trust.reviewedProgramDataSha256,reviewedDeploymentSlot:trust.reviewedDeploymentSlot,revision:trust.revision,upgradeAuthority:trust.upgradeAuthority};
 need(pins.upgradeAuthority===null||typeof pins.upgradeAuthority==='string','TRUST');
 if(pins.upgradeAuthority!==null)key(pins.upgradeAuthority);
 const source=failure.receipt.source,program=key(p.source.programId),expected=[program,PublicKey.findProgramAddressSync([program.toBuffer()],LOADER)[0],SYSVAR_CLOCK_PUBKEY];
 need(source.upgradeAuthority===pins.upgradeAuthority,'TRUST');
 need(source.accounts.length===expected.length,'ACCOUNTS');
 for(const [i,account]of source.accounts.entries())need(key(account.address).equals(expected[i]!)&&account.exists&&account.owner===(i<2?LOADER.toBase58():SYSVAR)&&account.executable===(i===0),'ACCOUNTS');
 need(source.accounts[1]!.dataSha256===pins.reviewedProgramDataSha256,'TRUST');
 const bytes=Buffer.from(w.signedTransactionHex,'hex');
 try{await prepareRealmSaleSigning(p,pins);}catch{throw new RealmSaleFailureError('TRUST');}
 try{
  const signed=await verifySignedRealmSale(p,bytes.toString('base64'));need(signed.signature===w.signature,'WIRE');
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))).toString('hex');need(hash===w.wireSha256,'WIRE');
 }catch{throw new RealmSaleFailureError('WIRE');}
 return freeze({failure,browserFinalityVerified:false,currentSigningAuthorized:false,broadcastAuthorized:false,journalClearingAuthorized:false});
}
