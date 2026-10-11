package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.workshop.*
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.ui.economy.WorkshopViewModel
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WorkshopRepositoryTest {
    private val job="00000000-0000-4000-8000-000000000002"
    private val now="2026-09-21T12:00:00.000Z"
    private fun view()=WorkshopView(WorkshopFeatures(WorkshopFeature(1,1,1)),true,1,1,17,WorkshopBatch(3,9),61,
        WorkshopInventory(BASE_ID,1,1),WorkshopAllowance(1,"free_wallet","2026-09-21T00:00:00.000Z","2026-09-22T00:00:00.000Z",2,
            WorkshopDaily(6,2,4),WorkshopHolding(3,2,0,0,14,9)),6,1,WorkshopLegacyHolding(1,0,0,1,14),2,
        listOf(WorkshopJob(job,1,"17",1,1,"2026-09-21T00:00:00.000Z","2026-09-21T00:01:01.000Z",true,null)),now)
    private inner class Fixture {
        val holder=testHolder(); val session=signedIn(holder); val wire=FakeApiClient(); val memory=MemoryStore()
        val store=WorkshopStore(memory,WorkshopIdentity(session.origin,"devnet",WALLET))
        var selected: String?=BASE_ID; var generation=0L; var clock=0L; var wall=0L; var allowed=true; var v=view(); var shards="999"
        var dir:BaseDirectory?=BaseDirectory(true,capabilities=BaseCapabilities(true,true),bases=listOf(BaseSummary(BASE_ID,"active",slot=0)))
        var accountReads=0; var hydrates=0; var posts=0; var gets=0; var accepted=false; var wrongProof=false
        var beforeEnqueue:()->Unit={}; var afterView:()->Unit={}; var account:suspend ()->Unit={}; var afterProof:()->Unit={}
        var onPost:suspend ()->Unit={ accepted=true }
        var beforeHydration:()->Unit={}; var snapshotPublished=false
        val api=object: ApiClient by wire {
            override suspend fun getWorkshop(path:String,query:Map<String,String>,guard:()->Unit,evidence:((JsonObject)->Unit)?):JsonObject {
                guard(); gets++
                if(path=="/workshop") { assertEquals(BASE_ID,query["baseId"]); return Json.encodeToJsonElement(v).jsonObject.also { afterView() } }
                val key=java.net.URLDecoder.decode(path.substringAfterLast('/'),"UTF-8")
                val c=store.read().operation?.command
                val r=if(!accepted) JsonNull else buildJsonObject {
                    put("version",1);put("status","accepted");put("wallet",if(wrongProof) "11111111111111111111111111111111" else WALLET);put("baseId",BASE_ID);put("jobId",job);put("receiptId",job)
                    if(c?.kind=="collect") { put("ingotsCredited",1);put("collectedAt",now) }
                    else {put("ingots",1);put("shardsCharged","17");put("recipeVersion",1);put("workshopLevelAtStart",1);put("startedAt",v.jobs[0].startedAt);put("readyAt",v.jobs[0].readyAt);put("acceptedAt",v.jobs[0].startedAt)}
                }
                val raw=buildJsonObject {put("wallet",WALLET);put("idempotencyKey",key);put("status",if(accepted) "accepted" else "unknown");put("receipt",r);put("serverNow",now)}
                afterProof();evidence?.invoke(raw);holder.requireCurrent(session);return raw
            }
            override suspend fun postWorkshop(path:String,body:JsonObject,refusal:((ApiException)->Unit)?,guard:()->Unit):JsonObject {
                beforeEnqueue();guard();assertEquals(store.read().operation!!.command.body(),body);assertTrue(store.read().operation!!.attempted);posts++;try {onPost()} catch (e:ApiException) { refusal?.invoke(e); holder.requireCurrent(session); throw e };return buildJsonObject {}
            }
        }
        val repository=WorkshopRepository(session,holder,api,store,{selected},{generation},{dir},{accountReads++;account()},{guard->hydrates++;beforeHydration();guard();snapshotPublished=true},{allowed},{clock},{wall},{"workshop-original"})
        init { wire.onGet("/native/capabilities") { json("""{"protocolVersion":1,"simVersion":17,"economy":{"workshop":{"enabled":true,"recipeVersion":1}}}""") }; wire.onGet("/balances") { assertEquals(BASE_ID,it["baseId"]);balancesJson(shards) } }
        suspend fun review():WorkshopReview { repository.reviewStart(1);return requireNotNull(repository.state.value.review) }
    }
    @Test fun `fresh server review respects wallet allowance and custodial SHARDS then archives hydrated proof`()=runBlocking<Unit> {
        val f=Fixture();val r=f.review();assertEquals("17",r.command.charge());assertEquals(1,f.accountReads);assertEquals(0,f.posts)
        f.repository.confirm(r);assertNotNull(f.store.read().operation!!.proof);assertEquals(1,f.posts)
        f.repository.finish();assertEquals(1,f.hydrates);assertNull(f.store.read().operation);assertEquals(WorkshopHydration.CURRENT_ORIGINAL_BASE,f.repository.state.value.hydration)
    }
    @Test fun `wallet aggregate capacity exhaustion cannot be replaced by selected-base room`()=runBlocking<Unit> {
        val f=Fixture();f.v=f.v.copy(allowance=f.v.allowance.copy(holding=f.v.allowance.holding.copy(held=14,pending=0,remaining=0)))
        assertThrows(IllegalArgumentException::class.java) {runBlocking {f.review()}};assertNull(f.store.read().operation)
        val poor=Fixture();poor.shards="16";assertThrows(IllegalStateException::class.java) {runBlocking {poor.review()}};assertEquals(0,poor.posts)
    }
    @Test fun `A B A selection during fresh reads invalidates old quote and does not send`()=runBlocking<Unit> {
        val f=Fixture();f.afterView={f.generation+=2};assertThrows(IllegalStateException::class.java) {runBlocking {f.review()}};assertNull(f.repository.state.value.review);assertEquals(0,f.posts)
    }
    @Test fun `gate closure lifecycle logout and base roundtrip at actual enqueue preserve attempt without relay`()=runBlocking<Unit> {
        for(reason in listOf("gate","hide","logout","base")) {
            val f=Fixture();val r=f.review();f.beforeEnqueue={when(reason){"gate"->f.allowed=false;"hide"->f.repository.dismiss();"logout"->f.holder.replace(null);else->f.generation+=2}}
            assertThrows(Exception::class.java) {runBlocking {f.repository.confirm(r)}};assertEquals(0,f.posts);assertTrue(f.store.read().operation!!.attempted)
        }
    }
    @Test fun `UTC day expiry deep-sleep elapsed and backwards clocks require another explicit review`()=runBlocking<Unit> {
        for(reason in listOf("elapsed","wall","backwards")) {
            val f=Fixture();val r=f.review();when(reason){"elapsed"->f.clock=43_200_000;"wall"->f.wall=43_200_000;else->f.clock=-1}
            assertThrows(IllegalStateException::class.java) {runBlocking {f.repository.confirm(r)}};assertEquals(0,f.posts);assertFalse(f.store.read().operation!!.attempted)
        }
    }
    @Test fun `fresh changed allowance is not silently accepted after the user reviews`()=runBlocking<Unit> {
        val f=Fixture();val r=f.review();f.v=f.v.copy(allowance=f.v.allowance.copy(daily=f.v.allowance.daily.copy(used=3,remaining=3)))
        assertThrows(IllegalStateException::class.java) {runBlocking {f.repository.confirm(r)}};assertEquals(0,f.posts)
    }
    @Test fun `paused collection stays available but starts and live gates remain closed`()=runBlocking<Unit> {
        val f=Fixture();f.v=f.v.copy(acceptingJobs=false);f.repository.reviewCollect(job);f.repository.confirm(requireNotNull(f.repository.state.value.review));assertEquals(1,f.posts)
        val closed=Fixture();closed.v=closed.v.copy(acceptingJobs=false);assertThrows(IllegalArgumentException::class.java){runBlocking{closed.review()}}
        val gate=Fixture();gate.allowed=false;assertThrows(IllegalStateException::class.java){runBlocking{gate.repository.reviewCollect(job)}}
    }
    @Test fun `lost POST needs explicit same-key review and can never turn a later refusal definitive`()=runBlocking<Unit> {
        val f=Fixture();val r=f.review();f.onPost={throw IOException("lost")};assertThrows(IOException::class.java){runBlocking{f.repository.confirm(r)}}
        f.repository.check();assertEquals(1,f.posts);f.repository.reviewSaved();f.onPost={throw ApiException(422,"INSUFFICIENT_SHARDS","no")}
        assertThrows(ApiException::class.java){runBlocking{f.repository.confirm(requireNotNull(f.repository.state.value.review))}}
        assertNull(f.store.read().operation!!.refusal);assertEquals("workshop-original",f.store.read().operation!!.command.key)
    }
    @Test fun `valid late proof is retained before obsolete session cannot publish it`()=runBlocking<Unit> {
        val f=Fixture();f.review();f.accepted=true;f.afterProof={f.holder.replace(null)}
        assertThrows(SessionSupersededException::class.java){runBlocking{f.repository.check()}};assertNotNull(f.store.read().operation!!.proof);assertNull(f.repository.state.value.journal.operation!!.proof)
    }
    @Test fun `wrong receipt never enters original journal even at late response boundary`()=runBlocking<Unit> {
        val f=Fixture();f.review();f.accepted=true;f.wrongProof=true
        assertThrows(IllegalArgumentException::class.java){runBlocking{f.repository.check()}};assertNull(f.store.read().operation!!.proof)
    }
    @Test fun `paused history needs no selected base and explicit finish marks original stock unavailable`()=runBlocking<Unit> {
        val f=Fixture();val r=f.review();f.repository.confirm(r);f.selected=null;f.generation++;f.dir=f.dir!!.copy(bases=emptyList());f.allowed=false
        f.repository.check();f.repository.finish();assertNull(f.store.read().operation);assertEquals(0,f.hydrates);assertNull(f.repository.state.value.view);assertNull(f.repository.state.value.shards)
        assertEquals(WorkshopHydration.ORIGINAL_BASE_UNAVAILABLE,f.repository.state.value.hydration)
    }
    @Test fun `finish passes original base generation and view epoch into snapshot publication before archive`()=runBlocking<Unit> {
        for (reason in listOf("base","view","session")) {
            val f=Fixture();val review=f.review();f.repository.confirm(review)
            f.beforeHydration={when(reason){"base"->f.generation+=2;"view"->f.repository.dismiss();else->f.holder.replace(null)}}
            assertThrows(Exception::class.java){runBlocking{f.repository.finish()}}
            assertFalse(f.snapshotPublished);assertNotNull(f.store.read().operation!!.proof)
            assertTrue(f.store.read().archives.isEmpty())
        }
    }
    @Test fun `unknown ownership or failed hydration cannot archive proven paid command`()=runBlocking<Unit> {
        val f=Fixture();val r=f.review();f.repository.confirm(r);f.account={throw IOException("offline")}
        assertThrows(IOException::class.java){runBlocking{f.repository.finish()}};assertNotNull(f.store.read().operation!!.proof)
    }
    @Test fun `late first refusal persists only original evidence without publishing into replacement session`()=runBlocking<Unit> {
        val f=Fixture();val review=f.review()
        val otherWallet="11111111111111111111111111111111"
        f.onPost={signedIn(f.holder,otherWallet);throw ApiException(422,"INSUFFICIENT_SHARDS","original refusal")}
        assertThrows(SessionSupersededException::class.java){runBlocking{f.repository.confirm(review)}}
        assertEquals(WorkshopRefusal(422,"INSUFFICIENT_SHARDS"),f.store.read().operation!!.refusal)
        assertEquals(otherWallet,f.holder.current!!.wallet);assertNull(f.repository.state.value.journal.operation!!.refusal)
        assertEquals(1,f.posts)
    }
    private suspend fun withModel(f:Fixture, run:suspend (WorkshopViewModel)->Unit) {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val model=WorkshopViewModel(f.repository)
        try {withTimeout(5_000) {run(model)}} finally {model.viewModelScope.cancel();Dispatchers.resetMain()}
    }
    @Test fun `foreground and wallet discovery read server values without saving or posting commands`()=runBlocking<Unit> {
        val f=Fixture();f.repository.discover();assertTrue(f.repository.state.value.advertised);assertEquals(0,f.accountReads)
        withModel(f) {m->m.foreground();assertEquals("999",m.state.value.shards);assertEquals(3L,m.state.value.view!!.allowance.holding.held);assertEquals(1L,m.state.value.view!!.inventory.held)}
        assertEquals(0,f.posts);assertNull(f.store.read().operation)
    }
    @Test fun `cancelled old foreground queues a new GET refresh instead of stranding busy state`()=runBlocking<Unit> {
        val f=Fixture();val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>();var first=true
        f.account={if(first){first=false;entered.complete(Unit);release.await()}}
        withModel(f) {m->
            coroutineScope {
                val old=async {m.foreground()};entered.await();m.dismiss();val reopened=async {m.foreground()};release.complete(Unit);old.await();reopened.await()
            }
            assertFalse(m.busy.value);assertNotNull(m.state.value.view);assertNull(m.state.value.review);assertTrue(f.accountReads>=2)
        }
        assertEquals(0,f.posts)
    }
    @Test fun `dismissing a real review retains draft and rejects old confirmation without a hidden resend`()=runBlocking<Unit> {
        val f=Fixture()
        withModel(f) {m->m.start("1")?.join();val review=requireNotNull(m.state.value.review);m.dismiss();m.confirm(review)?.join()
            assertNull(m.state.value.review);assertFalse(f.store.read().operation!!.attempted);m.foreground();assertEquals(review.command,f.store.read().operation!!.command)}
        assertEquals(0,f.posts)
    }
    @Test fun `paused no-base foreground retains saved history and explicit unused archive stays available`()=runBlocking<Unit> {
        val f=Fixture();f.review();f.selected=null;f.generation++;f.allowed=false
        f.wire.onGet("/native/capabilities") {json("""{"protocolVersion":1,"simVersion":17,"economy":{"workshop":{"enabled":false,"recipeVersion":1}}}""")}
        withModel(f) {m->m.foreground();assertNull(m.state.value.view);assertNotNull(m.state.value.journal.operation);m.archiveUnusedOrRefused()?.join();assertNull(m.state.value.journal.operation);assertEquals(1,m.state.value.journal.archives.size)}
        assertEquals(0,f.posts)
    }
    @Test fun `ViewModel double confirm cannot duplicate an in-flight original POST`()=runBlocking<Unit> {
        val f=Fixture();val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
        f.onPost={entered.complete(Unit);release.await();f.accepted=true}
        withModel(f) {m->m.start("1")?.join();val review=requireNotNull(m.state.value.review);val first=m.confirm(review);entered.await();assertNull(m.confirm(review));release.complete(Unit);first?.join();assertNotNull(m.state.value.journal.operation!!.proof)}
        assertEquals(1,f.posts)
    }
    @Test fun `process stores canonicalize origin and isolate wallets clusters while corrupt data fails closed`() {
        var opened=0;val stores=WorkshopStores{_,_,_->opened++;MemoryStore()}
        val first=stores.forIdentity("https://GAME.test:443/","devnet",WALLET)
        assertSame(first,stores.forIdentity("https://game.test","devnet",WALLET));assertEquals(1,opened)
        assertNotSame(first,stores.forIdentity("https://game.test","mainnet-beta",WALLET));assertNotSame(first,stores.forIdentity("https://game.test","devnet","11111111111111111111111111111111"))
        assertThrows(Exception::class.java){WorkshopStores{_,_,_->MemoryStore("{}")}.forIdentity("https://game.test","devnet",WALLET)}
    }
    @Test fun `disabled capability cannot advertise new Workshop work while original history survives`()=runBlocking<Unit> {
        val f=Fixture();f.review();val before=f.store.read()
        f.wire.onGet("/native/capabilities") {json("""{"protocolVersion":1,"simVersion":17,"economy":{"workshop":{"enabled":false,"recipeVersion":1}}}""")}
        f.repository.discover();assertFalse(f.repository.state.value.advertised)
        f.selected=null;f.generation++;f.repository.refresh();assertFalse(f.repository.state.value.advertised)
        assertEquals(before,f.store.read());assertEquals(0,f.posts)
    }
    @Test fun `failed rediscovery closes a stale advertisement without changing its saved original`()=runBlocking<Unit> {
        val f=Fixture();f.repository.discover();assertTrue(f.repository.state.value.advertised)
        f.review();val before=f.store.read()
        f.wire.onGet("/native/capabilities") {throw IOException("offline")}
        assertThrows(IOException::class.java){runBlocking{f.repository.discover()}}
        assertFalse(f.repository.state.value.advertised);assertEquals(before,f.store.read());assertEquals(0,f.posts)
    }

    @Test fun `building discovery waits for active Workshop read without stranding the door`()=runBlocking<Unit> {
        val f=Fixture();val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>();var first=true
        f.account={if(first){first=false;entered.complete(Unit);release.await()}}
        coroutineScope {
            val current=async{f.repository.refresh()};entered.await()
            val door=async{f.repository.refresh(waitForIdle=true)};yield()
            assertFalse(door.isCompleted);release.complete(Unit)
            current.await();door.await()
        }
        assertNotNull(f.repository.state.value.view);assertFalse(f.repository.state.value.busy);assertEquals(0,f.posts)
    }
}
