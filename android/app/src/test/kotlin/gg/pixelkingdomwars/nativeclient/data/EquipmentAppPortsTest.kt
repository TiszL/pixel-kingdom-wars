package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.SessionCookieJar
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test
class EquipmentAppPortsTest {
 private class Fixture {
  val f=EquipmentFixtures;val identity=f.identity();val holder=testHolder();val session=AccountSession(identity.wallet,identity.origin,SessionCookieJar(identity.origin.toHttpUrl(),MemoryStore()).sessionToken()).also(holder::replace)
  var catalogue:JsonObject?=buildJsonObject{put("constants",buildJsonObject{put("PHASE_E_ORDINARY_EQUIPMENT",f.policy.equipment);put("PHASE_E_POLICY",buildJsonObject{put("basisPoints",f.policy.tax.getValue("basisPoints"));put("taxes",buildJsonObject{put("resources",buildJsonObject{put("islandPoolBps",f.policy.tax.getValue("islandPoolBps"))})})})})}
  var page=CharterLifecycle(true,true,1,true,true,"content-1",false,"base-1");var owned=false
  val ports=EquipmentAppPorts(session,holder,EquipmentTransport(object:EquipmentPort{override val identity=this@Fixture.identity;override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit,refusal:suspend(gg.pixelkingdomwars.nativeclient.network.ApiException)->Unit):JsonObject=error("noHTTP")}),{catalogue},{page},{f.base},{check(owned)},{})
 }
 @Test fun `fresh admission fences wallet lifetime content selected kingdom and battle`() {val f=Fixture();val guard=f.ports.capture(true);for(p in listOf(f.page.copy(active=false),f.page.copy(visible=false),f.page.copy(viewEpoch=2),f.page.copy(actionsAllowed=false),f.page.copy(contentReady=false),f.page.copy(contentIdentity="changed"),f.page.copy(selectionIdentity="changed"),f.page.copy(battleActive=true))){val old=f.page;f.page=p;assertTrue(runCatching{guard()}.isFailure);f.page=old};f.catalogue=null;assertTrue(runCatching{guard()}.isFailure);f.holder.replace(null);assertTrue(runCatching{f.ports.capture(false)}.isFailure)}
 @Test fun `paused original history requires only its captured session and visible lifetime`() {val f=Fixture();f.catalogue=null;f.page=f.page.copy(actionsAllowed=false,contentReady=false);f.ports.capture(false)();assertTrue(runCatching{f.ports.capture(true)}.isFailure);f.page=f.page.copy(visible=false);assertTrue(runCatching{f.ports.capture(false)}.isFailure)}
 @Test fun `historical original never grants current base ownership`() {val f=Fixture();f.ports.capture(false)();assertTrue(runCatching{f.ports.requireOwnedBase(f.f.base)}.isFailure);f.owned=true;f.ports.requireOwnedBase(f.f.base)}
 @Test fun `new Lens policy invalidates captured fresh consent without stranding original recovery`() {val f=Fixture();val fresh=f.ports.capture(true);val recover=f.ports.capture(false);f.catalogue=JsonObject(f.catalogue!!+("constants" to JsonObject(f.catalogue!!.getValue("constants").jsonObject+("PHASE_E_SURVEY_LENS" to SurveyLensFixtures.policy.surveyLens!!))));assertTrue(runCatching{fresh()}.isFailure);recover();assertNotNull(f.ports.policy()!!.surveyLens);f.ports.capture(true)()}

}
