package gg.pixelkingdomwars.nativeclient.notifications

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.ApiClient
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

private const val BINDING = "00000000-0000-4000-8000-000000000071"
private const val EVENT = "00000000-0000-4000-8000-000000000072"
private const val TOKEN = "original_Firebase_registration_token_00000001"
private fun payload() = mapOf("version" to "1", "bindingId" to BINDING, "eventId" to EVENT,
    "kind" to "mail", "title" to "Mail arrived", "body" to "Open your inbox.", "url" to "/?screen=mail")

class NotificationJournalTest {
    private fun journal() = NotificationJournal(MemoryStore()).also { it.activate(NotificationBinding(WALLET, BINDING, TOKEN, active = true)) }
    @Test fun `duplicate delivery is retired before display and across restart`() {
        val disk = MemoryStore(); val j = NotificationJournal(disk)
        j.activate(NotificationBinding(WALLET, BINDING, TOKEN, active = true))
        assertNotNull(j.accept(payload())); assertNull(j.accept(payload()))
        assertNull(NotificationJournal(disk).accept(payload()))
    }
    @Test fun `inactive consent and logout never show queued messages`() {
        val j = journal(); j.block(); assertNull(j.accept(payload())); assertFalse(j.active(BINDING))
        j.clear(); assertNull(j.accept(payload()))
    }
    @Test fun `identity revocation survives process death before any network cleanup`() {
        val disk = MemoryStore(); val j = NotificationJournal(disk)
        j.activate(NotificationBinding(WALLET, BINDING, TOKEN, active = true)); j.revoke()
        val restarted = NotificationJournal(disk)
        assertFalse(restarted.active(BINDING)); assertNull(restarted.accept(payload())); assertFalse(restarted.read()!!.consented)
        assertEquals("Cleanup still knows the original token", TOKEN, restarted.read()!!.token)
    }
    @Test fun `wrong identity binding and unknown fields cannot become navigation`() {
        val j = journal()
        assertNull(j.accept(payload() + ("bindingId" to EVENT)))
        assertNull(j.accept(payload() + ("wallet" to WALLET)))
        assertNotNull(j.accept(payload()))
    }
    @Test fun `canonical notification kind determines the only permitted screen`() {
        val j = journal()
        for (url in listOf("https://evil.example", "/?screen=mail&baseId=other", "/?screen=base", "/?screen=mail#x"))
            assertNull(j.accept(payload() + ("url" to url)))
        assertNull(j.accept(payload() + ("kind" to "purchase")))
        assertNotNull(j.accept(payload()))
    }
    @Test fun `multi deed full mines open the canonical bases screen`() {
        val j = journal()
        assertNotNull(j.accept(payload() + mapOf("kind" to "mine_full", "url" to "/?screen=bases")))
    }
    @Test fun `malformed messages do not consume a later valid event`() {
        val j = journal()
        assertNull(j.accept(payload() + ("eventId" to "not-a-uuid")))
        assertNull(j.accept(payload() + ("title" to "")))
        assertNull(j.accept(payload() + ("body" to "x".repeat(501))))
        assertNull(j.accept(payload() + ("version" to "2")))
        assertNotNull(j.accept(payload()))
    }
    @Test fun `corrupt storage fails closed instead of inventing a subscription`() {
        assertTrue(runCatching { NotificationJournal(MemoryStore("broken")).accept(payload()) }.isFailure)
    }
    @Test fun `storage failure cannot display an unrecorded duplicate`() {
        val disk = object : SecretStore {
            var data: String? = null; var fail = false
            override fun read() = data
            override fun write(value: String) { if (fail) error("disk unavailable"); data = value }
            override fun clear() { data = null }
        }
        val j = NotificationJournal(disk); j.activate(NotificationBinding(WALLET, BINDING, TOKEN, active = true)); disk.fail = true
        var displays = 0
        assertTrue(runCatching { j.dispatch(payload()) { displays++ } }.isFailure)
        assertEquals(0, displays)
    }
}

private class PushFixture {
    val holder = testHolder(); val session = signedIn(holder); val disk = MemoryStore(); val journal = NotificationJournal(disk)
    var permitted = true; var enabled = true; var configured = true
    var token = TOKEN; var deleted = 0; var auto = false; var shownCancelled = 0
    var onToken: suspend () -> Unit = {}; var onPost: suspend () -> Unit = {}; var onDelete: suspend () -> Unit = {}
    var onTokenDelete: suspend () -> Unit = {}
    var background = false; var loginRequired = false; var serverWallet = WALLET
    val writes = mutableListOf<Pair<String, JsonObject>>(); val deletes = mutableListOf<JsonObject>(); var reads = 0
    val provider = object : NotificationTokens {
        override suspend fun token(): String { onToken(); return token }
        override suspend fun delete() { deleted++; onTokenDelete(); token = "new_Firebase_registration_token_${deleted.toString().padStart(12, '0')}" }
        override fun autoInit(enabled: Boolean) { auto = enabled }
    }
    val api = object : ApiClient {
        override suspend fun get(path: String, query: Map<String, String>): JsonObject {
            if (background && path == "/auth/login/status") return buildJsonObject { put("loginRequired", loginRequired) }
            if (background && path == "/me") return buildJsonObject { put("wallet", serverWallet) }
            assertEquals(NativeNotifications.PATH, path); reads++
            return buildJsonObject { put("version", 1); put("enabled", enabled) }
        }
        override suspend fun post(path: String, body: JsonObject): JsonObject {
            assertEquals(NativeNotifications.PATH + "/subscribe", path)
            // Durable consent precedes even an ambiguous registration response.
            assertEquals(journal.read()?.token, body.string("token"))
            assertEquals(journal.read()?.bindingId, body.string("bindingId"))
            writes += path to body; onPost(); return json("{\"ok\":true}")
        }
        override suspend fun put(path: String, body: JsonObject): JsonObject = error("No PUT")
        override suspend fun delete(path: String): JsonObject = error("No token in URL")
        override suspend fun delete(path: String, body: JsonObject): JsonObject {
            assertEquals(NativeNotifications.PATH + "/subscribe", path); deletes += body; onDelete(); return json("{}")
        }
    }
    fun controller() = NativeNotifications(journal, provider, { holder.current }, { api }, holder::requireCurrent,
        { permitted }, configured, "gg.pixelkingdomwars.twa.debug", { shownCancelled++ })
}

class NativeNotificationsTest {
    @Test fun `ordinary first boot only probes and cannot manufacture push consent`() = runTest {
        val f = PushFixture(); val c = f.controller(); c.refresh()
        assertEquals(1, f.reads); assertTrue(f.writes.isEmpty()); assertNull(f.disk.value); assertFalse(f.auto)
    }
    @Test fun `permission denial and disabled feature cannot register a device`() = runTest {
        val f = PushFixture(); val c = f.controller(); f.permitted = false; c.enable()
        assertTrue(f.writes.isEmpty()); assertNull(f.disk.value)
        f.permitted = true; f.enabled = false; c.enable(); assertTrue(f.writes.isEmpty())
    }
    @Test fun `unconfigured builds do not touch Firebase or server`() = runTest {
        val f = PushFixture(); f.configured = false; val c = f.controller(); c.refresh(); c.enable()
        assertEquals(0, f.reads); assertTrue(f.writes.isEmpty()); assertFalse(f.auto)
    }
    @Test fun `explicit enable activates only the durable server-confirmed binding`() = runTest {
        val f = PushFixture(); val c = f.controller(); f.onPost = { assertFalse(f.journal.read()!!.active) }
        c.enable(); assertTrue(c.state.value.optedIn); assertTrue(f.journal.read()!!.active); assertTrue(f.auto)
    }
    @Test fun `lost subscribe response recovers the same durable binding on restart`() = runTest {
        val f = PushFixture(); f.onPost = { throw java.io.IOException("lost response") }; f.controller().enable()
        val saved = f.journal.read()!!; assertFalse(saved.active)
        f.onPost = {}; f.controller().refresh()
        assertEquals(saved.bindingId, f.journal.read()!!.bindingId); assertTrue(f.journal.read()!!.active)
        assertEquals(f.writes[0].second, f.writes[1].second)
    }
    @Test fun `paused server delivery does not remove the existing opt out`() = runTest {
        val f = PushFixture(); val c = f.controller(); c.enable(); f.enabled = false; c.refresh()
        assertFalse(c.state.value.supported); assertTrue(c.state.value.optedIn)
        c.disable(); assertFalse(c.state.value.optedIn); assertEquals(1, f.deletes.size); assertNull(f.journal.read())
    }
    @Test fun `unconfirmed consent can be turned off immediately and after restart while paused`() = runTest {
        val f = PushFixture(); f.onPost = { throw java.io.IOException("lost response") }; val c = f.controller(); c.enable()
        assertTrue(c.state.value.optedIn); assertFalse(f.journal.read()!!.active)
        f.enabled = false; val restarted = f.controller(); restarted.refresh()
        assertTrue(restarted.state.value.optedIn); restarted.disable()
        assertEquals(1, f.deletes.size); assertNull(f.journal.read())
    }
    @Test fun `server revoked binding cannot regain consent through foreground refresh`() = runTest {
        val f = PushFixture(); f.onPost = { throw ApiException(409, "FCM_BINDING_REVOKED", "Consent was revoked") }; val c = f.controller(); c.enable()
        val revoked = f.journal.read()!!; assertFalse(revoked.consented); assertFalse(c.state.value.optedIn)
        f.onPost = {}; c.refresh(); assertEquals(1, f.writes.size)
        c.enable(); assertEquals(2, f.writes.size); assertNotEquals(revoked.bindingId, f.journal.read()!!.bindingId)
    }
    @Test fun `token rotation retires the exact previous token and preserves consent`() = runTest {
        val f = PushFixture(); val c = f.controller(); c.enable(); val binding = f.journal.read()!!.bindingId
        f.token = "replacement_Firebase_registration_token_0002"; c.refresh()
        assertEquals(TOKEN, f.writes.last().second.string("previousToken")); assertEquals(binding, f.journal.read()!!.bindingId)
        assertNull(f.journal.read()!!.previousToken)
    }
    @Test fun `revoked Android permission clears local receipt and retires remote capability`() = runTest {
        val f = PushFixture(); val c = f.controller(); c.enable(); f.permitted = false; c.refresh()
        assertNull(f.journal.read()); assertEquals(1, f.deletes.size); assertEquals(1, f.deleted); assertFalse(f.auto)
    }
    @Test fun `disable remains locally effective when remote cleanup fails`() = runTest {
        val f = PushFixture(); val c = f.controller(); c.enable(); f.onDelete = { throw java.io.IOException("offline") }; c.disable()
        assertNull(f.journal.read()); assertFalse(c.state.value.optedIn); assertEquals(1, f.deleted); assertFalse(f.auto)
    }
    @Test fun `logout persists revocation before awaiting network and never restores late registration`() = runTest {
        val f = PushFixture(); val c = f.controller(); val posted = CompletableDeferred<Unit>(); val reply = CompletableDeferred<Unit>()
        f.onPost = { posted.complete(Unit); reply.await() }
        val enabling = launch { c.enable() }; posted.await()
        f.onDelete = { assertNull(f.disk.value); assertFalse(f.journal.active(BINDING)) }
        val loggingOut = launch { c.beforeLogout() }; yield()
        assertFalse(f.journal.read()!!.consented)
        reply.complete(Unit); enabling.join(); loggingOut.join()
        assertNull(f.journal.read()); assertFalse(c.state.value.optedIn); assertFalse(f.auto)
    }
    @Test fun `identity change during token acquisition cannot bind an old account`() = runTest {
        val f = PushFixture(); val c = f.controller(); f.onToken = { signedIn(f.holder, "11111111111111111111111111111111") }
        runCatching { c.enable() }
        assertTrue(f.writes.isEmpty()); assertNull(f.journal.read())
    }
    @Test fun `account replacement blocks queued old notifications before awaiting sync`() = runTest {
        val f = PushFixture(); val c = f.controller(); c.enable(); val b = f.journal.read()!!
        val replacement = signedIn(f.holder, "11111111111111111111111111111111"); c.identityChanged(replacement)
        assertFalse(f.journal.active(b.bindingId)); c.refresh()
        assertNull(f.journal.read()); assertFalse(f.auto); assertEquals(1, f.deleted)
        assertEquals(1, f.writes.size)
    }
    @Test fun `old logout cleanup cannot erase or unregister the next account`() = runTest {
        val f = PushFixture(); val c = f.controller(); c.enable()
        val retiring = CompletableDeferred<Unit>(); val released = CompletableDeferred<Unit>()
        f.onDelete = { retiring.complete(Unit); released.await() }
        val logout = launch { c.beforeLogout() }; retiring.await()
        val replacement = signedIn(f.holder, "11111111111111111111111111111111"); c.identityChanged(replacement)
        val fresh = launch { c.enable() }; released.complete(Unit); logout.join(); fresh.join()
        assertEquals(replacement.wallet, f.journal.read()!!.wallet); assertTrue(f.journal.read()!!.active)
        assertEquals("Only the old registration was deleted", 1, f.deleted); assertTrue(f.auto)
    }
    @Test fun `revoked binding is not automatically revived after cold restart`() = runTest {
        val f = PushFixture(); f.controller().enable(); f.journal.revoke()
        f.controller().refresh(); assertEquals(1, f.writes.size); assertNull(f.journal.read())
    }
    @Test fun `real login transition deletes old SDK token before registering the next wallet`() = runTest {
        val f = PushFixture(); val c = f.controller(); c.enable(); c.blockLocally()
        val replacement = signedIn(f.holder, "11111111111111111111111111111111"); c.identityChanged(replacement)
        c.refresh(); c.enable()
        assertEquals(1, f.deleted); assertNotEquals(TOKEN, f.writes.last().second.string("token"))
        assertEquals(replacement.wallet, f.journal.read()!!.wallet); assertTrue(f.journal.read()!!.active)
    }
    @Test fun `failed SDK deletion retains revoked capability through process death and retries before enable`() = runTest {
        val f = PushFixture(); val c = f.controller(); c.enable()
        f.onTokenDelete = { throw java.io.IOException("offline SDK") }; c.disable()
        val restored = NotificationJournal(f.disk).read()!!
        assertEquals(TOKEN, restored.token); assertFalse(restored.consented); assertFalse(restored.active)
        val restart = f.controller(); restart.enable(); assertEquals(1, f.writes.size)
        f.onTokenDelete = {}; restart.enable()
        assertNotEquals(TOKEN, f.writes.last().second.string("token")); assertTrue(f.journal.read()!!.active)
    }
}

class NotificationTokenSyncTest {
    private fun fixture() = PushFixture().also {
        it.background = true
        it.journal.activate(NotificationBinding(WALLET, BINDING, TOKEN, active = true))
        it.journal.rotate("rotated_background_registration_token_000002")
    }
    private fun PushFixture.sync() = NotificationTokenSync(journal, api, { permitted }, "gg.pixelkingdomwars.twa.debug")
    @Test fun `closed app token rotation is durable and syncs without an account graph`() = runTest {
        val f = fixture(); val restarted = NotificationJournal(f.disk)
        assertFalse(restarted.read()!!.active)
        f.sync().sync()
        assertEquals(TOKEN, f.writes.single().second.string("previousToken")); assertTrue(restarted.read()!!.active)
    }
    @Test fun `background pending login never binds notification consent`() = runTest {
        val f = fixture(); f.loginRequired = true; f.sync().sync()
        assertTrue(f.writes.isEmpty()); assertFalse(f.journal.read()!!.consented)
    }
    @Test fun `background cookie must prove the original wallet`() = runTest {
        val f = fixture(); f.serverWallet = "11111111111111111111111111111111"; f.sync().sync()
        assertTrue(f.writes.isEmpty()); assertFalse(f.journal.read()!!.consented)
    }
    @Test fun `queued work cannot resubscribe after persisted opt out`() = runTest {
        val f = fixture(); f.journal.revoke(); f.sync().sync()
        assertTrue(f.writes.isEmpty()); assertEquals(0, f.reads)
    }
    @Test fun `lost background response retries the exact same capability`() = runTest {
        val f = fixture(); f.onPost = { throw java.io.IOException("lost") }
        assertTrue(runCatching { f.sync().sync() }.isFailure)
        f.onPost = {}; f.sync().sync()
        assertEquals(f.writes[0].second, f.writes[1].second); assertTrue(f.journal.read()!!.active)
    }
    @Test fun `late background response cannot undo durable logout`() = runTest {
        val f = fixture(); f.onPost = { f.journal.revoke() }
        assertTrue(runCatching { f.sync().sync() }.isFailure); assertFalse(f.journal.read()!!.active)
    }
    @Test fun `a newer rotated token cannot be overwritten by an old worker response`() = runTest {
        val f = fixture(); val latest = "latest_background_registration_token_0000003"
        f.onPost = { f.journal.rotate(latest) }
        assertTrue(runCatching { f.sync().sync() }.isFailure)
        assertEquals(latest, f.journal.read()!!.token); assertFalse(f.journal.read()!!.active)
    }
}
