package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.SessionCookieJar
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

internal fun charterTestCatalogue()=buildJsonObject{putJsonObject("constants") {
    putJsonObject("CLANS"){put("nameMinLen",3);put("nameMaxLen",24);put("tagMinLen",2);put("tagMaxLen",5);put("createCostShards",5000)}
    putJsonObject("PHASE_E_POLICY"){put("basisPoints",10000)}
    putJsonObject("PHASE_E_CHARTER_TRANSFER"){put("royaltyBps",500)}
    putJsonObject("PHASE_E_CHARTER_PREPARATION"){put("computeUnitLimit",400000);put("coreCreateFeeLamports",1500000)}
    putJsonObject("PHASE_E_CHARTER_ADMISSION"){putJsonObject("v1"){put("issuedPermitTtlSec",540);put("observationMaxAgeMs",10000)}}
    putJsonObject("PHASE_E_SEEKER_AUCTION"){put("maxPolicyPermitTtlSec",600)}
}}
class CharterAppPortsTest {
    private class Fixture {
        val e=CharterFixtures.envelope();val identity=CharterFixtures.identity(e.actor);val holder=testHolder()
        val session=AccountSession(identity.wallet,identity.origin,SessionCookieJar(identity.origin.toHttpUrl(),MemoryStore()).sessionToken()).also(holder::replace)
        var pins:CharterSigningTrust?=CharterFixtures.pins;var catalogue:JsonObject?=charterTestCatalogue()
        var page=CharterLifecycle(true,true,1,true,true,"content-1",false);var now=0L
        val wallet=CharterWallet(session,holder,session.origin,SolanaCluster.DEVNET,{false},{null},null)
        val genesis=e.signing!!.charterObject("deployment").charterText("expectedGenesisHash")
        var genesisRead:suspend ()->String={genesis};var height=e.signing!!.getValue("lastValidBlockHeight").jsonPrimitive.long
        var clock=CharterClock(e.signing!!.charterObject("context").getValue("closingSlot").jsonPrimitive.long,e.signing!!.charterText("observedUnixTimestamp").toLong());var heightReads=0
        val port=object:CharterPort {override val identity=this@Fixture.identity;override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonObject)->Unit):JsonObject=error("No HTTP expected")}
        fun ports(timeout:Long=30000)=CharterAppPorts(session,holder,CharterTransport(port),{pins},{catalogue},{page},object:CharterRpcReads{
            override suspend fun genesisHash()=genesisRead();override suspend fun finalizedBlockHeight():Long{heightReads++;return height};override suspend fun clock(minimumSlot:Long)=clock
        },wallet,{now},{},timeout)
        suspend fun prepared()=CharterTransaction.prepare(e.signing!!,CharterFixtures.pins,e.actor,CharterFixtures.crypto)
    }
    @Test fun `canonical catalogue has no response-derived defaults or numeric string coercion`() {
        assertEquals(CharterFixtures.protocol,charterAppPolicy(charterTestCatalogue())!!.protocol);assertEquals(CharterFixtures.crypto,charterAppPolicy(charterTestCatalogue())!!.crypto)
        assertNull(charterAppPolicy(null));val c=charterTestCatalogue().charterObject("constants")
        val broken=JsonObject(c+("CLANS" to JsonObject(c.charterObject("CLANS")+("createCostShards" to JsonPrimitive("5000")))))
        assertNull(charterAppPolicy(buildJsonObject{put("constants",broken)}))
    }
    @Test fun `new actions freeze session lifecycle content policy and independent pins`()=runBlocking {
        val f=Fixture();val p=f.ports();val guard=p.capture(true)
        for(change in listOf(f.page.copy(active=false),f.page.copy(visible=false),f.page.copy(viewEpoch=2),f.page.copy(actionsAllowed=false),f.page.copy(contentReady=false),f.page.copy(contentIdentity="new"),f.page.copy(battleActive=true),f.page.copy(selectionIdentity="changed"))){val old=f.page;f.page=change;assertTrue(runCatching{guard()}.isFailure);f.page=old}
        f.pins=null;assertTrue(runCatching{guard()}.isFailure);f.pins=CharterFixtures.pins;f.catalogue=null;assertTrue(runCatching{guard()}.isFailure)
        p.capture(false)();assertTrue(runCatching{p.capture(true)}.isFailure);signedIn(f.holder,f.e.actor);assertTrue(runCatching{p.capture(false)}.isFailure)
    }
    @Test fun `fresh approval requires pinned genesis original height and current Clock then expires after awaits`()=runBlocking {
        val f=Fixture();val p=f.ports();val prepared=f.prepared();val guard=p.capture(true);val fresh=p.live(prepared,f.e.signing!!,guard);fresh()
        f.now=10001;assertTrue(runCatching{fresh()}.isFailure);f.now=0
        f.genesisRead={"11111111111111111111111111111111"};assertTrue(runCatching{p.live(prepared,f.e.signing!!,guard)}.isFailure);f.genesisRead={f.genesis}
        f.height++;assertTrue(runCatching{p.live(prepared,f.e.signing!!,guard)}.isFailure);f.height--
        f.clock=f.clock.copy(unixTimestamp=prepared.expiryUnixTimestamp+1);assertTrue(runCatching{p.live(prepared,f.e.signing!!,guard)}.isFailure)
    }
    @Test fun `ignored cancellation holds process-wide fresh read fence until actual underlying request settles`()=runBlocking {
        val f=Fixture();val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>();f.genesisRead={withContext(NonCancellable){entered.complete(Unit);release.await();f.genesis}}
        val p=f.ports(25);val prepared=f.prepared();val guard=p.capture(true);val work=async{assertTrue(runCatching{p.live(prepared,f.e.signing!!,guard)}.isFailure)}
        entered.await();work.await();assertTrue(runCatching{f.ports(25).capture(true)}.isFailure);f.ports(25).capture(false)();assertEquals(0,f.heightReads)
        release.complete(Unit);withTimeout(2000){while(runCatching{f.ports().capture(true)}.isFailure)delay(5)};assertEquals(0,f.heightReads)
    }
    @Test fun `read adapter requests finalized contextual Clock and rejects malformed timestamp encoding`()=runBlocking {
        val f=Fixture();val methods=mutableListOf<String>();var malformed=false
        val api=object:ApiClient by FakeApiClient(){override suspend fun post(path:String,body:JsonObject):JsonObject {
            val method=body.charterText("method");methods+=method
            return buildJsonObject{put("result",when(method){"getGenesisHash"->JsonPrimitive(f.genesis);"getBlockHeight"->JsonPrimitive(100);else->{val options=body.getValue("params").jsonArray[1].jsonObject;assertEquals("finalized",options.charterText("commitment"));assertEquals(JsonPrimitive(50),options["minContextSlot"])
                buildJsonObject{putJsonObject("context"){put("slot",50)};putJsonObject("value"){put("owner","Sysvar1111111111111111111111111111111111111");put("executable",false);put("data",buildJsonArray{add(if(malformed)"AAAA" else Base64.getEncoder().encodeToString(ByteBuffer.allocate(40).order(ByteOrder.LITTLE_ENDIAN).putLong(32,100).array()));add("base64")})}}
            }})}
        }}
        val p=CharterSessionRpc(api,SolanaCluster.DEVNET);assertEquals(f.genesis,p.genesisHash());assertEquals(100,p.finalizedBlockHeight());assertEquals(CharterClock(50,100),p.clock(50));malformed=true;assertTrue(runCatching{p.clock(50)}.isFailure)
        assertEquals(listOf("getGenesisHash","getBlockHeight","getAccountInfo","getAccountInfo"),methods)
    }
}
