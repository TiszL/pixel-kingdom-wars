/** Real original funding/admission/preparation and ephemeral wallet consent.
 * Chain account banks remain explicit synthetic fixtures, never live authority. */
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { vi } from 'vitest';
import { createCharterCreationSignedStore } from '../../src/game/clanCharterCreationSignedStore';
import { charterCreationPreparationFixture } from './charterCreationPreparation';
export { postgresLeaf, outcome } from './charterCreationPreparation';
export const signedRefusal=(suffix:string)=>({code:'CLAN_CHARTER_SIGNED_'+suffix});
export const noSignedAuthority={signingAuthorized:false,relayAuthorized:false,mintAuthorized:false,
 paymentAuthorized:false,activationAuthorized:false,refundAuthorized:false,reservationReleaseAuthorized:false};
export async function charterCreationSignedFixture(){
 const f=await charterCreationPreparationFixture();
 async function prepared(){
  const payer=Keypair.generate();
  // The old actor fixture intentionally discards wallet secrets. Inject only
  // its first key generation synchronously; all real funding/custody follows.
  const generate=vi.spyOn(Keypair,'generate').mockReturnValueOnce(payer);
  let pending:ReturnType<typeof f.actor>;
  try{pending=f.actor();}finally{generate.mockRestore();}
  const actor=await pending!;
  if(actor.wallet!==payer.publicKey.toBase58())throw Error('Fixture did not bind its signing wallet');
  const p=await f.admitted(actor),saved=await p.service().prepare(actor.wallet,p.consent.creationIntentId);
  if(!saved.preparation)throw Error('Fixture did not reach actual issued preparation');
  const transaction=VersionedTransaction.deserialize(Buffer.from(saved.preparation.packet.unsignedTransactionHex,'hex'));
  transaction.sign([payer]);const wire=Buffer.from(transaction.serialize());
  return {...p,payer,saved,wire,transaction};
 }
 const store=()=>createCharterCreationSignedStore(f.db);
 const signedRows=()=>f.sql`select * from charter_creation_signed_wires order by attempt_id`;
 return {...f,preparedSigned:prepared,store,signedRows};
}
export type SignedFixture=Awaited<ReturnType<typeof charterCreationSignedFixture>>;
export type SignedPreparation=Awaited<ReturnType<SignedFixture['preparedSigned']>>;
