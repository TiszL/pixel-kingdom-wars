/** A lost local signed packet must remain recoverable from the committed plan,
 * original owner capture and actual finalized chain source after API restart. */
import {describe,it,expect} from 'vitest';
import {createVehicleBurnFinalityReader} from '@shardkeep/chain/vehicle-burn-finality';
import {createVehicleBurnPreparations} from '../src/game/vehicleBurnPreparations';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
describe('durable vehicle burn plan paired with finalized recovery',()=>{
 it('recovers the same actual burn from a reopened private loader without local signed bytes or new preparation',async()=>{
  const f=await vehicleBurnDatabase();try{
   await expect(f.reader.verify({reservationId:f.reservation.id})).rejects.toHaveProperty('reservationReleaseAuthorized',false);
   const signed=f.finalizeBurn(),reopened=f.conn.reopen();try{
    const paused=createVehicleBurnPreparations(reopened.db),reader=createVehicleBurnFinalityReader(()=>f.rpc,f.trust,paused.loadSavedReservation);
    const original=await paused.prepare(f.actor,f.reservation.id);expect(original).toEqual(f.preparation);
    const recovered=await reader.verify({reservationId:f.reservation.id});
    expect(recovered).toMatchObject({signature:signed.signature,wallet:f.actor,preBurnOwner:f.actor,identity:f.identity,
     originalMessageSha256:original.messageSha256,finalityVerified:true,preBurnOwnershipVerified:true,installationAuthorized:false});
    expect(await reader.verify({reservationId:f.reservation.id,signedTransaction:signed.signedTransaction})).toEqual(recovered);
    f.setOnline(false);await expect(reader.verify({reservationId:f.reservation.id})).rejects.toHaveProperty('reservationReleaseAuthorized',false);
    expect(await paused.prepare(f.actor,f.reservation.id)).toEqual(original);
    expect(await reopened.sql`select * from vehicle_activation_reservations`).toHaveLength(1);
    expect(await reopened.sql`select * from vehicle_burn_preparations`).toHaveLength(1);
   }finally{await reopened.sql.end();}
  }finally{await f.dispose();}
 },30_000);
});
