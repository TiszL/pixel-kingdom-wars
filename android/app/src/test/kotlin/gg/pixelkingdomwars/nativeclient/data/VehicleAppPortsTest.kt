package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.SessionCookieJar
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.vehicle.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test
class VehicleAppPortsTest {
 private class Fixture {
  val f=VehicleFixtures;val identity=f.identity();val holder=testHolder();val session=AccountSession(identity.wallet,identity.origin,SessionCookieJar(identity.origin.toHttpUrl(),MemoryStore()).sessionToken()).also(holder::replace)
  var pins:VehicleSigningTrust?=f.pins;var catalogue:JsonObject?=buildJsonObject{put("constants",buildJsonObject{put("PHASE_E_VEHICLE_CLIENT",f.policy.raw.getValue("client"));put("PHASE_E_VEHICLES",f.policy.raw.getValue("vehicles"));put("PHASE_E_ADVANCED_EXPEDITIONS",f.policy.raw.getValue("advanced"));put("PHASE_E_PAID_STARTER_ROUTES",f.policy.raw.getValue("paidRoutes"))})}
  var page=CharterLifecycle(true,true,1,true,true,"content-1",false,"base-1");var owned=false
  val ports=VehicleAppPorts(session,holder,VehicleTransport(object:VehiclePort{override val identity=this@Fixture.identity;override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit):JsonObject=error("noHTTP")}),{pins},{catalogue},{page},{check(owned)},VehicleRpcReads{_,_->error("noRPC")},VehicleWallet(session,holder,session.origin,SolanaCluster.DEVNET,{false},{null},null),{0},{})
 }
 @Test fun `fresh admission binds session visible lifetime selected base content and configured pins`() {
  val f=Fixture();val guard=f.ports.capture(true)
  for(p in listOf(f.page.copy(active=false),f.page.copy(visible=false),f.page.copy(viewEpoch=2),f.page.copy(actionsAllowed=false),f.page.copy(contentReady=false),f.page.copy(contentIdentity="changed"),f.page.copy(selectionIdentity="changed"),f.page.copy(battleActive=true))){val old=f.page;f.page=p;assertTrue(runCatching{guard()}.isFailure);f.page=old}
  f.pins=null;assertTrue(runCatching{guard()}.isFailure);f.pins=f.f.pins;f.catalogue=null;assertTrue(runCatching{guard()}.isFailure);f.holder.replace(null);assertTrue(runCatching{f.ports.capture(false)}.isFailure)
 }
 @Test fun `paused history needs original session and view but no current trust or catalogue`() {
  val f=Fixture();f.pins=null;f.catalogue=null;f.page=f.page.copy(actionsAllowed=false,contentReady=false);f.ports.capture(false)();assertTrue(runCatching{f.ports.capture(true)}.isFailure);f.page=f.page.copy(visible=false);assertTrue(runCatching{f.ports.capture(false)}.isFailure)
 }
 @Test fun `fresh ownership is explicit and cannot accidentally block original committed burn`() {
  val f=Fixture();f.ports.capture(true)();assertTrue(runCatching{f.ports.requireOwnedBase(f.f.base)}.isFailure);f.owned=true;f.ports.requireOwnedBase(f.f.base)
 }
}
