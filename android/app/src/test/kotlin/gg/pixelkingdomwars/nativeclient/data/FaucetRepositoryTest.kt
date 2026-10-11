package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class FaucetRepositoryTest {
    private class Fixture(val disk: MemoryStore = MemoryStore(), val cluster: String = "devnet") {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val journal = FaucetJournal(disk, WALLET, "https://localhost:18443", cluster)
        var grant: JsonObject? = null; var eligible = true; var enabled = true; var hydrated = 0; var failHydration = false
        var policy: FaucetBounds? = FaucetBounds(5000)
        val repo = FaucetRepository(session, holder, api, journal, cluster, { policy }) {
            assertNotNull("Grant proof stays durable until refresh completes", journal.read())
            if (failHydration) throw IOException("wallet offline")
            hydrated++
        }
        fun grant(status: String = "requested", id: String = "8fa8b07e-c8a1-4d1d-b647-fd5d3605ed24") = json("""{"id":"$id","status":"$status","lamports":"500000000","txSignature":${if(status=="sent") "\"${"3".repeat(88)}\"" else "null"},"error":null,"requestedAt":"2026-09-12T00:00:00Z","sentAt":${if(status!="requested") "\"2026-09-12T00:00:10Z\"" else "null"}}""")
        fun status() = buildJsonObject {
            put("enabled", enabled); put("eligible", enabled && eligible)
            put("reason", if(!enabled) "disabled" else if(eligible) "ok" else if(grant?.get("status")==JsonPrimitive("requested")) "pending" else "cooldown")
            put("grantSol", 0.5); put("grantedSol", 0); put("lifetimeCapSol", 3); put("minBalanceSol", 0.25); put("cooldownHours", 6)
            put("nextEligibleAt", JsonNull); put("last", grant ?: JsonNull)
        }
        init {
            api.onGet("/devnet-faucet/status") { status() }
            api.onPost("/devnet-faucet/claim") { body ->
                assertEquals(json("{}"), body); assertEquals(JsonNull, journal.read()!!.getValue("grant"))
                grant = grant(); eligible = false
                buildJsonObject { put("grant", grant!!); put("status", status()) }
            }
        }
    }
    @Test fun `automatic claim happens once per session across remount and only when eligible`() = runBlocking {
        val f = Fixture(); repeat(3) { f.repo.automatic() }
        assertEquals(1, f.api.posts.size); assertNotNull(f.repo.state.value.saved)
        f.grant = f.grant("sent"); f.repo.refresh(); assertEquals(1, f.hydrated); assertNull(f.disk.value)
        f.eligible = true; f.grant = null; f.repo.automatic(); assertEquals(1, f.api.posts.size)
        f.repo.claim(); assertEquals(2, f.api.posts.size); assertNull("A new request must not announce the old grant again", f.repo.state.value.arrival)
        f.repo.dismissArrival(); f.repo.refresh(); assertNull(f.repo.state.value.arrival)
    }
    @Test fun `disabled wrong cluster missing bounds and corrupt journal cannot claim`() = runBlocking {
        val disabled = Fixture(); disabled.enabled = false; disabled.repo.automatic(); disabled.repo.claim(); assertTrue(disabled.api.posts.isEmpty())
        val mainnet = Fixture(cluster="mainnet-beta"); mainnet.repo.automatic(); mainnet.repo.claim(); assertTrue(mainnet.api.gets.isEmpty()); assertTrue(mainnet.api.posts.isEmpty())
        val missing = Fixture(); missing.policy = null; missing.repo.automatic(); assertTrue(missing.api.posts.isEmpty()); assertNull(missing.disk.value)
        val corrupt = Fixture(MemoryStore("not-json")); corrupt.repo.automatic(); assertTrue(corrupt.api.posts.isEmpty()); assertNotNull(corrupt.repo.state.value.error)
    }
    @Test fun `lost claim reply survives process restart and status cannot causally prove unknown request`() = runBlocking {
        val f = Fixture(); f.api.onPost("/devnet-faucet/claim") { f.grant = f.grant(); f.eligible = false; throw IOException("lost") }
        f.repo.claim(); assertTrue(f.repo.state.value.uncertain); assertNotNull(f.disk.value)
        val restarted = Fixture(f.disk); restarted.grant = f.grant; restarted.eligible = false
        restarted.repo.automatic(); assertTrue(restarted.api.posts.isEmpty()); assertTrue(restarted.repo.state.value.uncertain)
        restarted.grant = restarted.grant("sent"); restarted.repo.refresh()
        assertNull(restarted.repo.state.value.arrival); assertTrue(restarted.repo.state.value.uncertain); assertEquals(0, restarted.hydrated)
    }
    @Test fun `matching sent grant hydrates before retirement and failed hydration is retryable by GET only`() = runBlocking {
        val f = Fixture(); f.repo.claim(); f.grant = f.grant("sent"); f.failHydration = true
        f.repo.refresh(); assertNotNull(f.disk.value); assertNull(f.repo.state.value.arrival)
        f.failHydration = false; f.repo.refresh(); assertNull(f.disk.value); assertNotNull(f.repo.state.value.arrival)
        f.repo.refresh(); assertEquals(1, f.api.posts.size); assertEquals(1, f.hydrated)
    }
    @Test fun `a different latest grant never retires or announces the saved grant`() = runBlocking {
        val f = Fixture(); f.repo.claim(); f.grant = f.grant("sent", "7fa8b07e-c8a1-4d1d-b647-fd5d3605ed24"); f.repo.refresh()
        assertNotNull(f.disk.value); assertNotNull(f.repo.state.value.saved); assertNull(f.repo.state.value.arrival); assertEquals(0, f.hydrated)
    }
    @Test fun `failed grant is an exact terminal record without arrival or automatic new claim`() = runBlocking {
        val f = Fixture(); f.repo.claim(); f.grant = f.grant("failed"); f.repo.refresh()
        assertNull(f.disk.value); assertNull(f.repo.state.value.arrival)
        f.eligible = true; f.repo.automatic(); assertEquals(1, f.api.posts.size)
        f.repo.claim(); assertEquals(2, f.api.posts.size)
    }
    @Test fun `uncertainty requires an explicit fresh action and fresh server eligibility`() = runBlocking {
        val f = Fixture(); f.api.onPost("/devnet-faucet/claim") { throw ApiException(503, null, "unavailable") }
        f.repo.claim(); f.repo.automatic(); f.repo.refresh(); assertEquals(1, f.api.posts.size)
        f.eligible = false; f.repo.claim(); assertEquals(1, f.api.posts.size)
        f.eligible = true; f.repo.claim(); assertEquals(2, f.api.posts.size)
    }
    @Test fun `late identity and concurrent taps never publish or duplicate a claim`() = runBlocking {
        val f = Fixture(); val gate = CompletableDeferred<Unit>()
        f.api.onPost("/devnet-faucet/claim") { gate.await(); f.grant=f.grant(); f.eligible=false; buildJsonObject { put("grant",f.grant!!); put("status",f.status()) } }
        val first = launch { f.repo.claim() }; yield(); f.repo.claim(); assertEquals(1,f.api.posts.size)
        signedIn(f.holder,"other"); gate.complete(Unit); first.join()
        assertNull(f.repo.state.value.saved); assertNotNull(f.disk.value)
    }
    @Test fun `foreground polls GET using exported cadence and stops with lifecycle cancellation`() = runTest {
        val f = Fixture(); val job = launch { f.repo.foreground(true) }; runCurrent()
        advanceTimeBy(15000); runCurrent(); assertEquals(1, f.api.posts.size); assertTrue(f.api.gets.size >= 4)
        job.cancelAndJoin(); val calls = f.api.gets.size; advanceTimeBy(15000); assertEquals(calls, f.api.gets.size)
    }
    @Test fun `late refusal or transport failure cannot overwrite a replacement session journal or recover`() = runBlocking {
        for (failure in listOf(ApiException(409, "FAUCET_NOT_ELIGIBLE", "pending"), IOException("lost"))) {
            val f = Fixture()
            val replacement = "6a5b2023-3191-4d28-93b7-7bba7ca342e0"
            f.api.onPost("/devnet-faucet/claim") {
                signedIn(f.holder) // A new session can use the same wallet and encrypted store.
                f.journal.save(replacement)
                throw failure
            }
            try { f.repo.claim(); fail("The superseded session must cancel") }
            catch (_: CancellationException) { }
            assertEquals(replacement, f.journal.read()!!.getValue("attempt").jsonPrimitive.content)
            assertEquals("The old epoch must not issue a recovery GET", 1, f.api.gets.size)
            assertNull(f.repo.state.value.error)
            assertNull(f.repo.state.value.saved)
        }
    }
    @Test fun `strict grant states and server booleans reject malformed acknowledgements`() = runBlocking {
        val f = Fixture(); f.api.onPost("/devnet-faucet/claim") {
            buildJsonObject { put("grant", JsonObject(f.grant() + ("status" to JsonPrimitive("credited")))); put("status", f.status()) }
        }
        f.repo.claim(); assertTrue(f.repo.state.value.uncertain); assertNull(f.repo.state.value.saved); assertNotNull(f.disk.value)
        assertThrows(IllegalArgumentException::class.java) { DevnetFaucetStatus.from(JsonObject(f.status() + ("eligible" to JsonPrimitive("true")))) }
        assertThrows(IllegalArgumentException::class.java) { DevnetGrant.from(JsonObject(f.grant("sent") + ("txSignature" to JsonNull))) }
        Unit
    }
    @Test fun `not eligible race refreshes existing grant without creating a false unknown request`() = runBlocking {
        val f = Fixture(); f.api.onPost("/devnet-faucet/claim") {
            f.grant = f.grant(); f.eligible = false
            throw ApiException(409, "FAUCET_NOT_ELIGIBLE", "pending")
        }
        f.repo.claim(); assertNull(f.disk.value); assertFalse(f.repo.state.value.uncertain)
        assertEquals("requested", f.repo.state.value.status!!.last!!.status)
        assertNull(f.repo.state.value.arrival); assertEquals(1, f.api.posts.size)
    }
    @Test fun `canonical cadence and journal identity fail closed without invented defaults`() {
        assertEquals(5000L, FaucetBounds.from(json("""{"constants":{"DEVNET_FAUCET":{"pollMs":5000}}}"""))!!.pollMs)
        assertNull(FaucetBounds.from(json("{}"))); assertNull(FaucetBounds.from(json("""{"constants":{"DEVNET_FAUCET":{"pollMs":0}}}""")))
        val disk = MemoryStore(); val journal = FaucetJournal(disk, WALLET, "origin", "devnet")
        journal.save("6a5b2023-3191-4d28-93b7-7bba7ca342e0")
        assertThrows(IllegalArgumentException::class.java) { FaucetJournal(disk, "other", "origin", "devnet").read() }
        assertThrows(IllegalArgumentException::class.java) { FaucetJournal(disk, WALLET, "other", "devnet").read() }
    }

}
