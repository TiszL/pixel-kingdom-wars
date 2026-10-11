/** Actual committed service preparation, signed locally without relay. */
import {Message,VersionedTransaction} from '@solana/web3.js';
import {vehicleServicePreparationFixture} from './vehicleServicePreparation';
export async function vehicleServiceSignedFixture(){
 const f=await vehicleServicePreparationFixture();
 try{
  const prepared=await f.preparations.prepare(f.actor,f.intent.id);
  function signed(){const tx=new VersionedTransaction(Message.from(Buffer.from(prepared.messageHex,'hex')));tx.sign([f.wallet]);return tx.serialize();}
  return {...f,servicePreparation:prepared,signed};
 }catch(error){await f.dispose();throw error;}
}
