/** Cryptographic binding of an authenticated owner's historical attestation.
 * This verifies original buyer consent and canonical receipt bytes, not browser
 * RPC finality, fresh eligibility, payment admission or permission to sign. */
import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {PHASE_E_SEEKER_SALE} from '@shardkeep/shared';
import {RealmSalePreparationSchema,RealmSaleSignedWireSchema,type RealmSalePreparationView} from '@shardkeep/shared/realmSalesApi';
import {validateRealmSaleSettlement,type RealmSaleSettlementView} from '@shardkeep/shared/realmSaleSettlementApi';
import {verifySignedRealmSale} from './signing';
export class RealmSaleSettlementError extends Error{constructor(readonly code:'INPUT'|'WIRE'|'ACCOUNTS'|'RECEIPT'){super(`Realm sale settlement refused: ${code}`);this.name='RealmSaleSettlementError';}}
function need(v:unknown,code:RealmSaleSettlementError['code']):asserts v{if(!v)throw new RealmSaleSettlementError(code);}
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),SYSVAR='Sysvar1111111111111111111111111111111111111';
// Reviewed Anchor ABI, parity-tested against the real chain receipt fixture.
// The registry digest identifies the canonical registry; it is not game tuning.
const RECEIPT_DISCRIMINATOR=[150,87,46,5,104,64,139,147],RECEIPT_BYTES=294,REGISTRY_VERSION=1;
const REGISTRY_HASH='a4aacd9f6dd5caa33c42b3163d9ad45b0efcb9a500520315792b2b677db9e200';
function key(value:string):PublicKey{try{const k=new PublicKey(value);need(k.toBase58()===value&&!k.equals(PublicKey.default),'ACCOUNTS');return k;}catch{throw new RealmSaleSettlementError('ACCOUNTS');}}
function le(value:string|number,size=8):Buffer{const b=Buffer.alloc(size);if(size===2)b.writeUInt16LE(Number(value));else b.writeBigUInt64LE(BigInt(value));return b;}
function bindReceipt(p:RealmSalePreparationView,s:RealmSaleSettlementView):Buffer{
 const program=key(p.source.programId),buyer=key(p.wallet),b=s.purchase,source=s.receipt.source;
 const derive=(seed:string,...tail:Buffer[])=>PublicKey.findProgramAddressSync([Buffer.from(seed),...tail],program);
 const config=derive('realm_sale_config')[0],access=derive('realm_access',buyer.toBuffer(),Buffer.of(p.realm))[0];
 const saleId=Buffer.from(p.saleId,'hex'),[receipt,bump]=derive('realm_sale',buyer.toBuffer(),saleId),auctionConfig=derive('auction_config')[0];
 const term=derive('seeker_term',auctionConfig.toBuffer(),le(p.terms.round))[0];
 const expected=[program,PublicKey.findProgramAddressSync([program.toBuffer()],LOADER)[0],config,access,SYSVAR_CLOCK_PUBKEY,receipt];
 for(const [i,a]of source.accounts.entries())need(key(a.address).equals(expected[i]!)&&a.owner===(i<2?LOADER.toBase58():i===4?SYSVAR:program.toBase58())&&a.exists&&a.executable===(i===0),'ACCOUNTS');
 key(source.genesisHash);if(source.upgradeAuthority!==null)key(source.upgradeAuthority);
 need(b.address===receipt.toBase58(),'ACCOUNTS');
 // Re-encode all fields after B4l has bound every purchase field to the original
 // preparation and fixed policy. Exact equality rejects noncanonical ABI bytes,
 // hidden config/term/registry substitutions and signed-i64 high-bit mutations.
 const canonical=Buffer.concat([Buffer.from(RECEIPT_DISCRIMINATOR),Buffer.of(PHASE_E_SEEKER_SALE.version),config.toBuffer(),saleId,buyer.toBuffer(),key(b.seller).toBuffer(),key(b.developer).toBuffer(),term.toBuffer(),
  Buffer.of(b.spot,b.realm),le(b.day),le(b.round),le(REGISTRY_VERSION,2),Buffer.from(REGISTRY_HASH,'hex'),le(b.priceLamports),le(b.sellerLamports),le(b.developerLamports),le(b.priorExpiry),le(b.coverageStart),le(b.expiresAt),le(b.acceptedAt),Buffer.of(bump)]);
 const bytes=Buffer.from(s.receipt.receiptAccountHex,'hex');need(canonical.length===RECEIPT_BYTES&&bytes.length===RECEIPT_BYTES&&canonical.equals(bytes),'RECEIPT');return bytes;
}
async function sha256(bytes:Uint8Array):Promise<string>{return Buffer.from(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))).toString('hex');}
/** The returned frozen DTO remains owner-attested success. Journal lifecycle is
 * a separate durable controller decision, never an authority field added here. */
export async function verifyRealmSaleSettlement(preparation:unknown,wireMetadata:unknown,raw:unknown):Promise<RealmSaleSettlementView>{
 // Own every input before awaiting a digest/signature operation. The bounded
 // consistency parser returns a deeply frozen settlement tree.
 const p=RealmSalePreparationSchema.parse(preparation),w=RealmSaleSignedWireSchema.parse(wireMetadata),s=validateRealmSaleSettlement(p,w,raw);
 const receipt=bindReceipt(p,s),wire=Buffer.from(w.signedTransactionHex,'hex'),signed=await verifySignedRealmSale(p,wire.toString('base64'));
 need(signed.signature===w.signature,'WIRE');need(await sha256(wire)===w.wireSha256,'WIRE');
 need(await sha256(receipt)===s.receipt.source.accounts[5]!.dataSha256,'RECEIPT');return s;
}
