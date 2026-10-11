package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.seeker.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import kotlinx.serialization.json.*
import kotlinx.coroutines.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class SeekerShardsClaimsAppBindingTest {
    private val fixture = Json.parseToJsonElement(javaClass.getResource("/seeker-shards-claims.json")!!.readText()).jsonObject
    private val rules = SeekerShardsClaimsPolicy.from(fixture.getValue("policy").jsonObject)
    private fun catalogue() = buildJsonObject { put("constants", buildJsonObject { put("PHASE_E_POLICY", buildJsonObject { put("seekerIsland", fixture.getValue("policy")) }) }) }
    private inner class Fixture {
        val holder = testHolder(); val jar = SessionCookieJar("https://localhost:18443".toHttpUrl(), MemoryStore())
        val session = AccountSession(WALLET, "https://localhost:18443", jar.sessionToken()).also(holder::replace)
        val identity = StarterIdentity(session.origin, "devnet", WALLET)
        val game = GameApi(session.origin, jar, "test")
        val store = SeekerShardsClaimStore(MemoryStore(), identity, rules)
        var content: JsonObject? = catalogue(); val lifetime = SeekerShardsViewLifetime().also { it.start(); it.setOpen(true) }
        var orders = true; var ready = true; var version = "one"
        val port = SeekerShardsClaimsAppPort(session, holder, "devnet", store, game.seekerShardsClaimsPort(identity, session.token, rules),
            { content }, { lifetime.snapshot(orders, ready, version) })
    }
    private fun rejects(block: () -> Unit) = assertTrue(runCatching(block).isFailure)
    @Test fun `policy comes only from canonical content with strict numeric fields`() {
        assertEquals(rules, seekerShardsClaimsPolicy(catalogue())); assertNull(seekerShardsClaimsPolicy(null))
        val c = catalogue().toString().replace("\"totalSpots\":100", "\"totalSpots\":\"100\"")
        assertNull(seekerShardsClaimsPolicy(Json.parseToJsonElement(c).jsonObject))
    }
    @Test fun `hidden foreground discovery is GET only and pause preserves recovery`() {
        val f = Fixture(); f.lifetime.setOpen(false); f.orders = false; f.ready = false
        f.port.capture(false) {} (); rejects { f.port.capture(true) {} }
    }
    @Test fun `view background session and policy changes invalidate captured mutation guards`() {
        val f = Fixture(); val guard = f.port.capture(true) {}; guard()
        f.lifetime.invalidate(); rejects(guard)
        val after = f.port.capture(true) {}; f.lifetime.stop(); rejects(after)
        f.lifetime.start(); f.content = null; rejects { f.port.capture(true) {} }
        f.port.capture(false) {} (); f.jar.beginAuthentication(); rejects { f.port.capture(false) {} }
    }
    @Test fun `binding proves exact cookie token actor and cluster before any request`() {
        val f = Fixture()
        rejects { SeekerShardsClaimsAppPort(f.session, f.holder, "mainnet-beta", f.store,
            f.game.seekerShardsClaimsPort(f.identity, f.session.token, rules), { catalogue() }, { f.lifetime.snapshot(true, true) }) }
        val other = SessionCookieJar("https://localhost:18443".toHttpUrl(), MemoryStore())
        rejects { SeekerShardsClaimsAppPort(f.session, f.holder, "devnet", f.store,
            SeekerShardsClaimsHttpPort(f.identity, other, other.sessionToken(), rules, "test"), { catalogue() }, { f.lifetime.snapshot(true, true) }) }
    }
    @Test fun `content replacement requires another current review`() {
        val f = Fixture(); val guard = f.port.capture(true) {}; f.version = "two"; rejects(guard)
    }
    @Test fun `closing a binding waits for the original repository request to drain`() = runBlocking {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val slow = object : SeekerShardsClaimPort {
            override suspend fun get(path: String, query: Map<String, String>, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
                guard(); entered.complete(Unit); release.await()
                return JsonObject(fixture.getValue("entitlements").jsonObject + ("wallet" to JsonPrimitive(WALLET)))
            }
            override suspend fun post(body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject = error("No POST")
        }
        val repository = SeekerShardsClaimsRepository(f.session, f.holder, slow, f.store, { null }, { 0 }, { null }, {}, {}, { false })
        val binding = SeekerShardsClaimsBinding(repository, f.port)
        val request = launch { runCatching { repository.refresh() } }; entered.await()
        val close = launch(start = CoroutineStart.UNDISPATCHED) { binding.close() }
        assertFalse(close.isCompleted); release.complete(Unit); withTimeout(3000) { request.join(); close.join() }
        assertTrue(close.isCompleted); rejects { f.port.capture(false) {} }
    }
    @Test fun `retired binding suppresses all new network requests`() {
        val f = Fixture(); val guard = f.port.capture(false) {}; f.port.retire(); rejects(guard); rejects { f.port.capture(false) {} }
    }
}
