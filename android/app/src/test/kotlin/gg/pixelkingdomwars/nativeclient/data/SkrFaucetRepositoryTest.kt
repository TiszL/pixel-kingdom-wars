package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class SkrFaucetRepositoryTest {
    private fun vector(name: String): JsonObject {
        val stream = javaClass.getResourceAsStream("/skr-faucet-api-vectors.json")
        assertNotNull("MISSING: vector from P5 frozen route-test output", stream)
        return Json.parseToJsonElement(stream!!.bufferedReader().use { it.readText() }).jsonObject.getValue(name).jsonObject
    }
    private inner class Fixture(val disk: MemoryStore = MemoryStore()) {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val journal = SkrFaucetJournal(disk, session.wallet, session.origin, "devnet")
        var base = "11111111-1111-4111-8111-111111111111"
        var identity: SkrIdentity? = null
        var policy: SkrFaucetBounds? = SkrFaucetBounds(5000, "1000")
        var hydrated = 0
        val repo = SkrFaucetRepository(session, holder, api, journal, { identity }, { policy }, { base },
            signer = { _, _, _ -> error("Unexpected wallet prompt") }, refreshWallet = { hydrated++ })
        fun configure() {
            val grant = SkrFaucetGrant.from(vector("claim").getValue("grant").jsonObject)
            identity = SkrIdentity(grant.mint, grant.decimals)
            api.onGet("/devnet-skr-faucet/status") { vector("status") }
        }
    }
    @Test fun `no profile produces zero HTTP calls and saved history stays visible`() = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.repo.claim()
        assertTrue(f.api.gets.isEmpty()); assertTrue(f.api.posts.isEmpty()); assertFalse(f.repo.state.value.available)
        assertTrue(skrFaucetEntryDiscovered(false) { true })
        assertTrue(skrFaucetEntryDiscovered(false) { error("encrypted store unreadable") })
    }
    @Test fun `null code 404 hides only fresh entry and coded not owned stays an error`() = runBlocking {
        val f = Fixture(); f.configure()
        f.api.onGet("/devnet-skr-faucet/status") { throw ApiException(404, null, "missing") }
        f.repo.refresh(); assertFalse(f.repo.state.value.available); assertTrue(f.api.posts.isEmpty())
        f.api.onGet("/devnet-skr-faucet/status") { throw ApiException(404, "SKR_FAUCET_NOT_OWNED", "not owned") }
        f.repo.refresh(); assertTrue(f.repo.state.value.available); assertNotNull(f.repo.state.value.error)
    }
    @Test fun `uncertain claim survives restart and refresh never repeats a money POST`() = runBlocking {
        val f = Fixture(); f.configure()
        f.api.onPost("/devnet-skr-faucet/claim") { body ->
            assertEquals(setOf("baseId"), body.keys); assertNotNull(f.journal.read())
            throw IOException("lost acknowledgement")
        }
        f.repo.claim(); f.repo.refresh(); f.repo.claim()
        assertEquals(1, f.api.posts.size); assertNotNull(f.disk.value)
        val next = Fixture(f.disk); next.configure(); next.repo.refresh(); assertTrue(next.api.posts.isEmpty())
    }
    @Test fun `rapid taps are admitted once and stale session never publishes`() = runBlocking {
        val f = Fixture(); f.configure(); val gate = CompletableDeferred<Unit>()
        f.api.onPost("/devnet-skr-faucet/claim") { gate.await(); vector("claim") }
        val first = launch { f.repo.claim() }; yield()
        repeat(20) { f.repo.claim() }; assertEquals(1, f.api.posts.size)
        signedIn(f.holder); gate.complete(Unit); first.join()
        assertNotNull(f.disk.value); assertNull(f.repo.state.value.grant)
    }
    @Test fun `wrong profile mint and missing pack policy refuse all writes`() = runBlocking {
        val f = Fixture(); f.configure(); f.identity = SkrIdentity("11111111111111111111111111111112", 6)
        f.repo.claim(); assertTrue(f.api.posts.isEmpty())
        f.configure(); f.policy = null; f.repo.claim(); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `unknown server reason keeps history and allows no claim`() = runBlocking {
        val f = Fixture(); f.configure()
        f.api.onGet("/devnet-skr-faucet/status") { JsonObject(vector("status") + ("reason" to JsonPrimitive("future"))) }
        f.repo.claim(); assertTrue(f.api.posts.isEmpty()); assertFalse(f.repo.state.value.canClaim)
    }
    @Test fun `different selected base after awaited status cannot admit claim`() = runBlocking {
        val f = Fixture(); f.configure()
        f.api.onGet("/devnet-skr-faucet/status") { f.base = "22222222-2222-4222-8222-222222222222"; vector("status") }
        f.repo.claim(); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `policy reads pack with no embedded grant or cadence fallback`() {
        assertNull(SkrFaucetBounds.from(null))
        val pack = json("""{"constants":{"SKR_FAUCET":{"devnet":{"pollMs":5000,"grantSkr":1000}}}}""")
        assertEquals(SkrFaucetBounds(5000, "1000"), SkrFaucetBounds.from(pack))
        assertNull(SkrFaucetBounds.from(json("""{"constants":{"SKR_FAUCET":{"devnet":{"pollMs":0,"grantSkr":1000}}}}""")))
    }
}
