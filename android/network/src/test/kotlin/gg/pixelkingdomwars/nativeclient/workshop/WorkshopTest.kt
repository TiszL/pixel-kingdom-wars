package gg.pixelkingdomwars.nativeclient.workshop

import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class WorkshopTest {
    private val id = WorkshopIdentity("https://game.test", "devnet", "11111111111111111111111111111111")
    private val base = "00000000-0000-4000-8000-000000000001"
    private val job = "00000000-0000-4000-8000-000000000002"
    private val now = "2026-09-21T12:00:00.000Z"
    // Deliberately synthetic prices and timers prove native consumes the server, not a Kotlin copy.
    private fun view() = WorkshopView(WorkshopFeatures(WorkshopFeature(1,1,1)), true, 1, 1, 17,
        WorkshopBatch(3,9), 61, WorkshopInventory(base,1,1),
        WorkshopAllowance(1,"free_wallet","2026-09-21T00:00:00.000Z","2026-09-22T00:00:00.000Z",2,
            WorkshopDaily(6,2,4),WorkshopHolding(3,2,0,0,14,9)),6,1,WorkshopLegacyHolding(1,0,0,1,14),2,
        listOf(WorkshopJob(job,1,"17",1,1,"2026-09-21T00:00:00.000Z","2026-09-21T00:01:01.000Z",true,null)),now)
    private fun start(key: String = "original-start") = WorkshopCommand.start(view(),key,1)
    private fun collect() = WorkshopCommand.collect(view(),"original-collect",job)
    private fun proof(c: WorkshopCommand, accepted: Boolean = false): WorkshopProof {
        val receipt = if (!accepted) null else buildJsonObject {
            put("version",1); put("status","accepted"); put("wallet",id.wallet); put("baseId",base); put("jobId",job); put("receiptId",job)
            if(c.kind == "start") { put("ingots",c.ingots); put("shardsCharged",c.charge()); put("recipeVersion",c.recipeVersion!!); put("workshopLevelAtStart",1)
                put("capacityScopeAtStart","free_wallet"); put("startedAt",view().jobs[0].startedAt); put("readyAt",view().jobs[0].readyAt); put("acceptedAt",view().jobs[0].startedAt)
            } else { put("ingotsCredited",c.ingots); put("collectedAt",now) }
        }
        return WorkshopProof(id.wallet,c.key,if(accepted) "accepted" else "unknown",receipt,now)
    }
    private fun raw(p: WorkshopProof) = workshopJson.encodeToJsonElement(p).jsonObject
    private class Memory: SecretStore { var data: String?=null; var fail=false; override fun read()=data; override fun write(value:String) { if(fail) throw IOException("disk full"); data=value }; override fun clear() { error("Never discard") } }
    private inner class Fixture(val command: WorkshopCommand = start()) {
        val memory=Memory(); val store=WorkshopStore(memory,id); var accepted=false; var posts=0; var gets=0
        var send: suspend (() -> Unit) -> Unit = { g -> g(); accepted=true }
        var read: suspend () -> WorkshopProof = { proof(command,accepted) }
        val port=object: WorkshopPort {
            override suspend fun get(path:String,guard:()->Unit,retain:(JsonObject)->Unit):JsonObject { gets++; guard(); assertEquals(command.receiptPath,path); return raw(read()) }
            override suspend fun post(path:String,body:JsonObject,guard:()->Unit,refusal:(ApiException)->Unit) {
                assertEquals(command.postPath,path); assertEquals(command.body(),body); assertTrue(store.read().operation!!.attempted); posts++; try { send(guard) } catch (e: ApiException) { refusal(e); throw e }
            }
        }
        val engine=WorkshopTransport(store,port)
        suspend fun begin() = engine.begin(command) {}
    }
    @Test fun `wallet allowance stays aggregate and selected inventory stays local`() {
        val v=view(); v.validate(); assertEquals(3L,v.allowance.holding.held); assertEquals(1L,v.inventory.held)
        assertThrows(IllegalArgumentException::class.java) { v.copy(allowance=v.allowance.copy(scope="deed_base")).validate() }
        assertThrows(IllegalArgumentException::class.java) { v.copy(allowance=v.allowance.copy(holding=v.allowance.holding.copy(remaining=13))).validate() }
        assertThrows(IllegalArgumentException::class.java) { v.copy(allowance=v.allowance.copy(resetsAt="2026-09-23T00:00:00.000Z")).validate() }
    }
    @Test fun `strict capabilities schema integer and time proofs fail closed`() {
        val good=workshopJson.encodeToJsonElement(view()).jsonObject; WorkshopView.from(good)
        for(bad in listOf(JsonObject(good + ("unknownTerms" to JsonPrimitive(1))),JsonObject(good - "features"),JsonObject(good + ("serverNow" to JsonPrimitive("2026-09-21T12:00:00Z"))))) {
            assertThrows(Exception::class.java) { WorkshopView.from(bad) }
        }
        assertThrows(IllegalArgumentException::class.java) { view().copy(features=WorkshopFeatures(WorkshopFeature(1,1,2))).validate() }
        assertThrows(IllegalArgumentException::class.java) { view().copy(batch=WorkshopBatch(9_007_199_254_740_992L,9)).validate() }
        assertThrows(IllegalArgumentException::class.java) { view().copy(jobs=view().jobs + view().jobs).validate() }
    }
    @Test fun `quoted numeric boolean and null primitives cannot impersonate the current protocol`() {
        val good=workshopJson.encodeToJsonElement(view()).jsonObject
        for((field, value) in listOf("shardsPerIngot" to JsonPrimitive("17"), "level" to JsonPrimitive("1"), "acceptingJobs" to JsonPrimitive("true"), "level" to JsonNull, "serverNow" to JsonPrimitive(1))) {
            assertThrows(Exception::class.java) { WorkshopView.from(JsonObject(good + (field to value))) }
        }
        val feature=buildJsonObject { put("version","1"); put("receipts",1); put("allowance",1) }
        assertThrows(Exception::class.java) { WorkshopView.from(JsonObject(good + ("features" to buildJsonObject { put("workshop",feature) }))) }
        for(c in listOf(start(),collect())) {
            val p=proof(c,true); val r=p.receipt!!
            for(field in listOf("version",if(c.kind=="start") "ingots" else "ingotsCredited")) {
                assertThrows(Exception::class.java) { WorkshopProof.from(raw(p.copy(receipt=JsonObject(r + (field to JsonPrimitive("1"))))),id,c) }
            }
            for((field,value) in listOf("wallet" to JsonPrimitive(1), "status" to JsonPrimitive(true), "serverNow" to JsonNull, "status" to JsonPrimitive("future"))) {
                assertThrows(Exception::class.java) { WorkshopProof.from(JsonObject(raw(p) + (field to value)),id,c) }
            }
        }
    }
    @Test fun `unsupported preflight saves no unusable draft and positive preflight is atomic without second GET`() = runBlocking<Unit> {
        val f=Fixture(); f.read={ throw ApiException(404,null,"old server") }
        assertThrows(ApiException::class.java) { runBlocking { f.begin() } }; assertNull(f.store.read().operation)
        f.read={ proof(f.command).copy(status="future") }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.begin() } }; assertNull(f.store.read().operation)
        var live=true; f.read={ live=false; proof(f.command,true) }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.engine.begin(f.command) { check(live) } } }
        assertNotNull(f.store.read().operation!!.proof); assertEquals(3,f.gets); assertEquals(0,f.posts)
    }
    @Test fun `paused starts refuse but a paid ready job can collect`() {
        assertThrows(IllegalArgumentException::class.java) { WorkshopCommand.start(view().copy(acceptingJobs=false),"original-start",1) }
        WorkshopCommand.collect(view().copy(acceptingJobs=false),"original-collect",job)
        assertThrows(IllegalArgumentException::class.java) { start().admit(view().copy(shardsPerIngot=18,jobs=emptyList())) }
        assertThrows(IllegalArgumentException::class.java) { start().copy(ingots=Long.MAX_VALUE).validate() }
    }
    @Test fun `both original receipts bind wallet key base quantity and actual charge`() {
        for(c in listOf(start(),collect())) {
            val p=proof(c,true); p.validate(id,c)
            val bad=listOf(p.copy(wallet="other"),p.copy(idempotencyKey="other-key"),p.copy(receipt=JsonObject(p.receipt!! + ("baseId" to JsonPrimitive(job)))),
                p.copy(receipt=JsonObject(p.receipt + ((if(c.kind=="start") "shardsCharged" else "ingotsCredited") to (if(c.kind=="start") JsonPrimitive("18") else JsonPrimitive(2))))))
            bad.forEach { assertThrows(IllegalArgumentException::class.java) { it.validate(id,c) } }
        }
    }
    @Test fun `matching receipts retain legacy absent scope without inventing values`() {
        val c=start(); val p=proof(c,true); p.copy(receipt=JsonObject(p.receipt!! - "capacityScopeAtStart")).validate(id,c)
        assertThrows(IllegalArgumentException::class.java) { p.copy(receipt=JsonObject(p.receipt + ("futureEconomicField" to JsonPrimitive(1)))).validate(id,c) }
    }
    @Test fun `persist before network and before sole explicit POST then hydrate before archive`() = runBlocking<Unit> {
        for(c in listOf(start(),collect())) {
            val f=Fixture(c); f.read={ proof(c,f.accepted) }
            val saved=f.begin(); assertEquals(0,f.posts); val accepted=f.engine.confirm(saved) {}; assertNotNull(accepted.operation!!.proof)
            var hydrated=false; val done=f.engine.finish(accepted,{}, { assertNotNull(f.store.read().operation!!.proof); hydrated=true })
            assertTrue(hydrated); assertNull(done.operation); assertEquals(c,done.archives.single().operation.command); assertEquals(1,f.posts)
        }
    }
    @Test fun `lost acknowledgement restarts GET only with original terms even paused`() = runBlocking<Unit> {
        val f=Fixture(); val saved=f.begin(); f.send={ f.accepted=true; throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.engine.confirm(saved) {} } }
        val restarted=WorkshopTransport(WorkshopStore(f.memory,id),f.port); assertNotNull(restarted.check {}.operation!!.proof); assertEquals(1,f.posts)
    }
    @Test fun `unknown explicit retry preserves exact body key and ambiguous refusal cannot retire`() = runBlocking<Unit> {
        val f=Fixture(); val saved=f.begin(); f.send={ throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.engine.confirm(saved) {} } }
        f.send={ throw ApiException(422,"INSUFFICIENT_SHARDS","empty") }
        assertThrows(ApiException::class.java) { runBlocking { f.engine.confirm(f.store.read()) {} } }
        assertNull(f.store.read().operation!!.refusal); assertEquals(2,f.posts)
        // Rewritten 2026-10-06 (dead-end audit): the uncertain original now closes after its fresh `unknown` receipt (owner:
        // no saved request may block play forever), but the ambiguous refusal still cannot retire it as "refused".
        assertEquals("unknown",f.engine.archiveUnsentOrRefused(f.store.read()) {}.archives.single().reason); assertEquals(2,f.posts)
    }
    @Test fun `first typed refusal requires explicit fresh absence archival preserving original history`() = runBlocking<Unit> {
        val f=Fixture(); val saved=f.begin(); f.send={ throw ApiException(422,"INSUFFICIENT_SHARDS","empty") }
        assertThrows(ApiException::class.java) { runBlocking { f.engine.confirm(saved) {} } }
        val refused=f.store.read(); assertNotNull(refused.operation!!.refusal)
        val archived=f.engine.archiveUnsentOrRefused(refused) {}; assertEquals("refused",archived.archives.single().reason)
        assertThrows(IllegalArgumentException::class.java) { f.store.begin(archived,f.command) }
        f.store.begin(archived,start("different-key"))
    }
    @Test fun `unknown generic auth wrong-status and wrong-kind errors stay uncertain`() = runBlocking<Unit> {
        for(e in listOf(ApiException(409,"IDEMPOTENCY_BODY_MISMATCH","x"),ApiException(401,"INSUFFICIENT_SHARDS","x"),ApiException(422,null,"x"),ApiException(409,"JOB_NOT_READY","x"))) {
            val f=Fixture(); val saved=f.begin(); f.send={ throw e }; assertThrows(ApiException::class.java) { runBlocking { f.engine.confirm(saved) {} } }; assertNull(f.store.read().operation!!.refusal)
        }
        assertTrue(workshopRefusalDefinitive("collect",409,"JOB_NOT_READY")); assertFalse(workshopRefusalDefinitive("collect",503,"PHASE_E_DISABLED"))
    }
    @Test fun `post-success receipt error cannot become a definitive refusal`() = runBlocking<Unit> {
        val f=Fixture(); val saved=f.begin(); f.send={ f.read={ throw ApiException(422,"INSUFFICIENT_SHARDS","receipt outage") } }
        assertThrows(ApiException::class.java) { runBlocking { f.engine.confirm(saved) {} } }; assertNull(f.store.read().operation!!.refusal); assertTrue(f.store.read().operation!!.attempted)
    }
    @Test fun `late positive proof and initial refusal remain in original journal before session guard`() = runBlocking<Unit> {
        for(refusal in listOf(false,true)) {
            val f=Fixture(); var live=true; val guard={ check(live) }; val saved=f.begin()
            if(refusal) f.send={ live=false; throw ApiException(422,"INSUFFICIENT_SHARDS","empty") }
            else f.read={ if(f.posts>0) live=false; proof(f.command,f.posts>0) }
            assertThrows(Exception::class.java) { runBlocking { f.engine.confirm(saved,guard) } }
            val o=f.store.read().operation!!; if(refusal) assertNotNull(o.refusal) else assertNotNull(o.proof)
        }
    }
    @Test fun `actual enqueue guard blocks stale view while durable attempt remains`() = runBlocking<Unit> {
        val f=Fixture(); var live=true; var relayed=false; val saved=f.begin()
        f.send={ guard -> live=false; guard(); relayed=true }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.engine.confirm(saved) { check(live) } } }
        assertFalse(relayed); assertTrue(f.store.read().operation!!.attempted)
    }
    @Test fun `saved accepted proof survives failed hydration and cannot be downgraded`() = runBlocking<Unit> {
        val f=Fixture(); val accepted=f.engine.confirm(f.begin()) {}
        assertThrows(IOException::class.java) { runBlocking { f.engine.finish(accepted,{}, { throw IOException("offline") }) } }
        assertNotNull(f.store.read().operation!!.proof); f.accepted=false
        assertThrows(IllegalStateException::class.java) { runBlocking { f.engine.check {} } }; assertNotNull(f.store.read().operation!!.proof)
    }
    @Test fun `unattempted explicit abandonment retains proof and rejects stale CAS`() = runBlocking<Unit> {
        val f=Fixture(); val saved=f.begin(); val marked=f.store.attempt(saved)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.engine.archiveUnsentOrRefused(saved) {} } }; assertEquals(marked,f.store.read())
        val other=Fixture(); val draft=other.begin(); val done=other.engine.archiveUnsentOrRefused(draft) {}; assertEquals("unattempted",done.archives.single().reason)
    }
    @Test fun `schema corruption identity changes and storage failure never permit a POST`() = runBlocking<Unit> {
        for(raw in listOf("{}","{\"version\":9}","broken")) { val f=Fixture(); f.memory.data=raw; assertThrows(Exception::class.java) { runBlocking { f.begin() } }; assertEquals(0,f.posts) }
        val f=Fixture(); val saved=f.begin(); assertThrows(IllegalArgumentException::class.java) { WorkshopStore(f.memory,id.copy(cluster="mainnet-beta")).read() }
        f.memory.fail=true; assertThrows(IOException::class.java) { runBlocking { f.engine.confirm(saved) {} } }; assertEquals(0,f.posts)
        val blocked=Fixture(); blocked.memory.fail=true; assertThrows(IOException::class.java) { runBlocking { blocked.begin() } }; assertEquals(1,blocked.gets)
    }
}
