/** Synthetic finalized banks and local payer, never live request authority. */
import {createPrivateKey,sign} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {vehicleIssuanceQuoteFixture} from './vehicleIssuanceQuote';
import {normalizeVehicleIssuanceOriginal} from '../vehicleIssuanceAccounts';
import {createVehicleIssuanceQuoteReader} from '../vehicleIssuanceQuote';
import {copyVehicleRequestSaved,type VehicleIssuanceCurrentRpc} from '../vehicleIssuanceCurrent';
export async function vehicleIssuanceCurrentFixture(){
 const payer=Keypair.fromSeed(Buffer.alloc(32,51)),base=vehicleIssuanceQuoteFixture(),{originalHash:_,...raw}=base.input.original;
 const f=vehicleIssuanceQuoteFixture(normalizeVehicleIssuanceOriginal({...raw,buyer:payer.publicKey.toBase58()}));
 const quote=await createVehicleIssuanceQuoteReader(()=>f.rpc,f.trust,f.policyAuthority,{costLimits:f.costLimits})(f.input);
 const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(payer.secretKey).subarray(0,32)]),format:'der',type:'pkcs8'}),message=Buffer.from(quote.messageHex,'hex'),signedTransaction=Buffer.concat([Buffer.of(1),sign(null,message,key),message]);
 const saved={quote,signedTransaction},ref={wallet:quote.original.buyer,idempotencyKey:'11111111-1111-4111-8111-111111111111'},wire=copyVehicleRequestSaved(saved).wire;
 f.controls.initialBankSlot=103;f.controls.finalBankSlot=103;f.controls.feeSlot=103;f.controls.slot=103;
 const deliveries:{bytes:Uint8Array;options:unknown}[]=[],control:{status:unknown;blockhashValid:boolean}={status:null,blockhashValid:true};
 const rpc:VehicleIssuanceCurrentRpc={...f.rpc,isBlockhashValid:async()=>({context:{slot:f.controls.slot},value:control.blockhashValid}),getSignatureStatuses:async()=>({context:{slot:f.controls.slot},value:[control.status]}),sendRawTransaction:async(bytes,options)=>{deliveries.push({bytes:Buffer.from(bytes),options});return wire.signature;}};
 return {...f,payer,saved,ref,wire,rpc,control,deliveries};
}
