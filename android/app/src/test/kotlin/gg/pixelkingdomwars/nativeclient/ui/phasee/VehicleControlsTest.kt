package gg.pixelkingdomwars.nativeclient.ui.phasee
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.vehicle.*
import org.junit.Assert.*
import org.junit.Test
class VehicleControlsTest {
 private val f=VehicleFixtures
 private fun state(r:VehicleRecord)=VehicleState(loaded=true,journal=VehicleJournal(identity=f.identity(),pending=listOf(r)),selectedId=r.id)
 private fun record()=VehicleRecord("10000000-0000-4000-8000-000000000000","installation",VehicleProtocol.request(f.client).getValue("idempotencyKey").toString(),f.request,f.policy.raw,response=f.client)
 @Test fun `absent installed trust keeps new burn approval closed while original recovery remains visible`() {val c=vehicleControls(state(record()),true,false);assertFalse(c.review);assertFalse(c.deliver);assertTrue(c.recover)}
 @Test fun `wallet marker suppresses another prompt and paused original wire can still upload`() {val r=record().copy(attempts=listOf("wallet"),signed=f.wire);val c=vehicleControls(state(r),false,false);assertFalse(c.review);assertFalse(c.approve);assertTrue(c.upload);assertTrue(c.recover)}
 @Test fun `held evidence blocks all effects and terminal history exposes archive only`() {val held=vehicleControls(state(record().copy(held=true,signed=f.wire)),true,true);assertFalse(held.review);assertFalse(held.upload);val end=vehicleControls(state(record().copy(response=f.terminal())),true,true);assertFalse(end.review);assertFalse(end.deliver);assertFalse(end.recover);assertTrue(end.archive)}
}
