package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.divine.*
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import okhttp3.HttpUrl.Companion.toHttpUrl
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class DivineTrialAppPortsTest {
 private val f=DivineTrialFixtures
 private class Fixture {
  val identity=DivineTrialFixtures.identity();val holder=testHolder();val jar=SessionCookieJar(identity.origin.toHttpUrl(),DivineTrialFixtures.Memory());val session=AccountSession(identity.wallet,identity.origin,jar.sessionToken()).also(holder::replace)
  var page=CharterLifecycle(true,true,1,true,true,"content",false,"base1");var policy:JsonObject?=run{val f=DivineTrialFixtures;buildJsonObject{put("constants",JsonObject(f.vector.dobj("validationConstants")+mapOf("PHASE_E_DIVINE_TRIALS" to f.vector.getValue("constants"),"CAMPAIGN" to buildJsonObject{put("encounters",JsonArray(List(f.rules.bound("campaignStage")){buildJsonObject{put("keepLevel",f.vector.dobj("validationConstants").getValue("campaignKeepLevel"))}}))})))}}
  val transport=DivineTransport(object:DivinePort{override val identity=this@Fixture.identity;override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit):JsonObject=error("No request needed")})
  val ports=DivineTrialAppPorts(session,holder,transport,{policy},{page},{},{})
 }
 @Test fun `fresh guard freezes selected base admitted content and existing battle exclusion`() {for(change in listOf<(CharterLifecycle)->CharterLifecycle>({it.copy(selectionIdentity="base2")},{it.copy(contentIdentity="other")},{it.copy(battleActive=true)},{it.copy(actionsAllowed=false)})){val x=Fixture();val guard=x.ports.capture(true);x.page=change(x.page);assertTrue(runCatching{guard()}.isFailure)}}
 @Test fun `saved read survives unavailable policy but not hidden or retired view`() {val x=Fixture();val guard=x.ports.capture(false);x.policy=null;guard();x.page=x.page.copy(visible=false);assertTrue(runCatching{guard()}.isFailure);assertTrue(runCatching{x.ports.capture(true)}.isFailure)}
 @Test fun `same wallet replacement session cannot inherit old action authority`() {val x=Fixture();val guard=x.ports.capture(false);x.holder.replace(AccountSession(x.identity.wallet,x.identity.origin,x.jar.sessionToken()));assertTrue(runCatching{guard()}.isFailure)}
}
