import {createPrivateKey,sign} from 'node:crypto';
import {Keypair,Message,PublicKey,Transaction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {expect,it} from 'vitest';
import {normalizeVehicleIssuanceOriginal} from './vehicleIssuanceAccounts';
import {vehicleIssuanceFixture} from './testFixtures/vehicleIssuance';
import {vehiclePermitMessage,vehicleRequestLegacyMessage} from './vehicleIssuanceRequest';
import {verifyVehicleRequestSignedWire} from './vehicleIssuanceWire';

const wallet=Keypair.fromSeed(Buffer.alloc(32,39)),policy=Keypair.fromSeed(Buffer.alloc(32,17));
function signed(key:Keypair,message:Uint8Array){return sign(null,message,createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(key.secretKey).subarray(0,32)]),format:'der',type:'pkcs8'}));}
function fixture(){
 const {originalHash:_,...saved}=vehicleIssuanceFixture().original,original=normalizeVehicleIssuanceOriginal({...saved,buyer:wallet.publicKey.toBase58()}),policyAuthority=policy.publicKey.toBase58(),policySignature=signed(policy,vehiclePermitMessage(original)),recentBlockhash=new PublicKey(Buffer.alloc(32,21)).toBase58();
 const intentBytes=vehicleRequestLegacyMessage(original,policyAuthority,policySignature,recentBlockhash),signedTransaction=Buffer.concat([Buffer.of(1),signed(wallet,intentBytes),intentBytes]);
 return {original,policyAuthority,policySignature,recentBlockhash,intentBytes,signedTransaction};
}
it('accepts real payer consent only for the exact policy-authorized vehicle intent and owns returned bytes',()=>{
 const f=fixture(),result=verifyVehicleRequestSignedWire(f),saved=Buffer.from(f.signedTransaction);
 expect(Transaction.from(result.signedTransaction).verifySignatures()).toBe(true);expect(result.messageSha256).toHaveLength(64);expect(result.wireSha256).toHaveLength(64);expect(result.signature).not.toHaveLength(0);
 f.signedTransaction.fill(0);f.intentBytes.fill(0);f.policySignature.fill(0);result.signedTransaction.fill(0);
 expect(Buffer.from(result.signedTransaction)).toEqual(saved);expect(Object.isFrozen(result)).toBe(true);
 expect(result).not.toHaveProperty('broadcastAuthorized');
});
it.each(['actor','policy','policySignature','blockhash','terms','intent','signature','trailing','prefix','missingSignature'] as const)('refuses substituted %s rather than storing a different authorization',field=>{
 const f=fixture();
 if(field==='actor'){const {originalHash:_,...o}=f.original;f.original=normalizeVehicleIssuanceOriginal({...o,buyer:policy.publicKey.toBase58()});}
 if(field==='policy')f.policyAuthority=wallet.publicKey.toBase58();
 if(field==='policySignature')f.policySignature[0]=f.policySignature[0]!^1;
 if(field==='blockhash')f.recentBlockhash=wallet.publicKey.toBase58();
 if(field==='terms'){const {originalHash:_,...o}=f.original;f.original=normalizeVehicleIssuanceOriginal({...o,terms:{...o.terms,oracleBudget:'1'}});}
 if(field==='intent')f.intentBytes[10]=f.intentBytes[10]!^1;
 if(field==='signature')f.signedTransaction[1]=f.signedTransaction[1]!^1;
 if(field==='trailing')f.signedTransaction=Buffer.concat([f.signedTransaction,Buffer.of(0)]);
 if(field==='prefix')f.signedTransaction=Buffer.concat([Buffer.of(0x81,0),f.signedTransaction.subarray(1)]);
 if(field==='missingSignature')f.signedTransaction.fill(0,1,65);
 expect(()=>verifyVehicleRequestSignedWire(f)).toThrow();
});
it('refuses a valid signature from another wallet and a valid payer signature over modified instructions',()=>{
 const f=fixture(),foreign=Buffer.concat([Buffer.of(1),signed(policy,f.intentBytes),f.intentBytes]);
 expect(()=>verifyVehicleRequestSignedWire({...f,signedTransaction:foreign})).toThrow();
 const tx=Transaction.populate(Message.from(f.intentBytes));tx.instructions[1]!.data[272]=1;const otherIntent=tx.serializeMessage(),otherWire=Buffer.concat([Buffer.of(1),signed(wallet,otherIntent),otherIntent]);
 expect(()=>verifyVehicleRequestSignedWire({...f,intentBytes:otherIntent,signedTransaction:otherWire})).toThrow();
 expect(()=>verifyVehicleRequestSignedWire({...f,signedTransaction:otherWire})).toThrow();
});
it('refuses v0 or multiple signatures even if supplied as a replacement saved intent',()=>{
 const f=fixture(),tx=Transaction.populate(Message.from(f.intentBytes)),message=new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:f.recentBlockhash,instructions:tx.instructions}).compileToV0Message(),v0=new VersionedTransaction(message);v0.sign([wallet]);
 expect(()=>verifyVehicleRequestSignedWire({...f,intentBytes:message.serialize(),signedTransaction:v0.serialize()})).toThrow();
 expect(()=>verifyVehicleRequestSignedWire({...f,signedTransaction:Buffer.concat([Buffer.of(2),signed(wallet,f.intentBytes),signed(policy,f.intentBytes),f.intentBytes])})).toThrow();
});
