package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class CommunityRepositoryTest {
    private val id = "eee0575f-6df7-4672-91ea-33f497d2e1d6"
    private val other = "c310a4a4-d7b5-424a-b8f8-cd77d01114a3"
    private fun mail(reward: String = "pending", base: String? = BASE_ID, keepOnly: Boolean = false, messageId: String = id): JsonObject = json("""{
        "id":"$messageId","sender":"system","kind":"reward","subject":"Gift","body":"Enjoy your reward",
        "attachments":[${if (keepOnly) """{"kind":"KEEP","amount":"9007199254740993"}""" else """{"kind":"SHARDS","amount":"40"},{"kind":"ITEM","itemId":"keg_of_haste","qty":1}"""}],
        "rewardState":"$reward","claimBaseId":${if (reward == "claimed" && !keepOnly) "\"$base\"" else "null"},
        "createdAt":"2026-09-12T00:00:00Z","expiresAt":"2026-10-12T00:00:00Z","readAt":null,"archivedAt":null,
        "claimedAt":${if (reward == "claimed") "\"2026-09-12T00:00:01Z\"" else "null"},
        "expiredAt":${if (reward == "expired") "\"2026-10-12T00:00:00Z\"" else "null"}}
    """)
    private inner class Fixture(val disk: MemoryStore = MemoryStore()) {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient(); var base: String? = BASE_ID
        var selectionGeneration = 0L
        val store = PendingIntentStore(disk); val observer = ReceiptObserver(store)
        val repository = LiveCommunityRepository(session, holder, api, store, observer, { base }, { MailBounds(20, 50) },
            selectionGeneration = { selectionGeneration })
        var message = mail()
        init {
            api.onGet("/mail/$id") { message }
            api.onGet("/mail/status") { json("""{"total":1,"unread":1,"pendingRewards":1}""") }
            api.onGet("/mail") { json("""{"messages":[$message],"nextCursor":null}""") }
        }
        suspend fun open() = repository.openMail(id)
        fun select(baseId: String?) { selectionGeneration++; base = baseId }
    }
    @Test fun `claim persists intrinsic ID and original deed before the only POST then hydrates exact mail`(): Unit = runBlocking {
        val f = Fixture(); f.open()
        f.api.onPost("/mail/$id/claim") { body ->
            val saved = requireNotNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET))
            assertEquals(id, saved.idempotencyKey); assertEquals(BASE_ID, saved.baseId); assertTrue(saved.attempted)
            assertEquals(json("""{"baseId":"$BASE_ID"}"""), body); f.message = mail("claimed"); f.message
        }
        f.repository.claim(id, BASE_ID)
        assertEquals(1, f.api.posts.size); assertNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET))
        assertEquals("claimed", f.repository.state.value.detail!!.rewardState)
        assertEquals(listOf("/mail/$id", "/mail/status"), f.api.gets.takeLast(2).map { it.first })
    }
    @Test fun `Back during read or archive keeps the acknowledged message closed`(): Unit = runBlocking {
        for (action in listOf("read", "archive")) {
            val f = Fixture(); f.open()
            f.api.onPost("/mail/$id/$action") {
                f.repository.closeMail()
                JsonObject(f.message + ((if (action == "read") "readAt" else "archivedAt") to JsonPrimitive("2026-09-12T01:00:00Z")))
            }
            if (action == "read") f.repository.markRead() else f.repository.archive()
            assertNull(f.repository.state.value.detail); assertEquals(1, f.api.posts.size)
            assertNotNull(f.repository.state.value.status)
        }
    }
    @Test fun `Back during claim POST or receipt hydration retires proof without reopening mail`(): Unit = runBlocking {
        for (duringPost in listOf(false, true)) {
            val f = Fixture(); f.open()
            f.api.onPost("/mail/$id/claim") {
                if (duringPost) f.repository.closeMail()
                f.message = mail("claimed"); f.message
            }
            if (!duringPost) f.api.onGet("/mail/$id") { f.repository.closeMail(); f.message }
            f.repository.claim(id, BASE_ID)
            assertNull(f.repository.state.value.detail); assertNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET))
            assertTrue(f.repository.state.value.claimNotice!!.contains(BASE_ID)); assertEquals(1, f.api.posts.size)
        }
    }
    @Test fun `KEEP-only mail omits base and preserves exact integers without a Land Deed`(): Unit = runBlocking {
        val f = Fixture(); f.base = null; f.message = mail(keepOnly = true); f.open()
        f.api.onPost("/mail/$id/claim") { assertTrue(it.isEmpty()); f.message = mail("claimed", keepOnly = true); f.message }
        f.repository.claim(id, null)
        assertEquals("9007199254740993", f.repository.state.value.detail!!.attachments.single().amount)
        assertNull(f.repository.state.value.detail!!.claimBaseId)
    }
    @Test fun `lost reply survives process death and later sale with GET-only exact terminal recovery`(): Unit = runBlocking {
        val disk = MemoryStore(); val f = Fixture(disk); f.open()
        f.api.onPost("/mail/$id/claim") { throw IOException("reply lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.claim(id, BASE_ID) } }
        val restored = Fixture(disk); restored.base = null; restored.message = mail("claimed")
        restored.repository.checkClaim()
        assertTrue(restored.api.posts.isEmpty()); assertNull(restored.store.get(IntentKind.MAIL_CLAIM, WALLET))
        assertEquals(BASE_ID, restored.repository.state.value.detail!!.claimBaseId)
    }
    @Test fun `another clients terminal claim reports actual destination instead of claiming selected deed delivery`(): Unit = runBlocking {
        val f = Fixture(); f.open(); f.api.onPost("/mail/$id/claim") { f.message = mail("claimed", other); f.message }
        f.repository.claim(id, BASE_ID)
        assertEquals(other, f.repository.state.value.detail!!.claimBaseId)
        assertTrue(f.repository.state.value.claimNotice!!.contains(other)); assertFalse(f.repository.state.value.claimNotice!!.contains(BASE_ID))
        assertNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET))
    }
    @Test fun `pending GET and local expiry time prove nothing and never post automatically`(): Unit = runBlocking {
        val f = Fixture(); f.open(); f.api.onPost("/mail/$id/claim") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.claim(id, BASE_ID) } }
        f.repository.checkClaim(); f.repository.refreshMail(false)
        assertEquals(1, f.api.posts.size); assertNotNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET))
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.claim(id, BASE_ID) } }
    }
    @Test fun `explicit retry retains frozen mail and base but selected-deed switch refuses before transport`(): Unit = runBlocking {
        val f = Fixture(); f.open(); f.api.onPost("/mail/$id/claim") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.claim(id, BASE_ID) } }
        f.base = other
        assertThrows(CancellationException::class.java) { runBlocking { f.repository.retryClaim() } }
        assertEquals(1, f.api.posts.size); assertNotNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET))
        f.base = BASE_ID; f.api.onPost("/mail/$id/claim") { assertEquals(BASE_ID, it.string("baseId")); f.message = mail("claimed"); f.message }
        f.repository.retryClaim(); assertEquals(2, f.api.posts.size); assertNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET))
    }
    @Test fun `definitive first refusal retires but later retry refusal cannot erase uncertain claim`(): Unit = runBlocking {
        val f = Fixture(); f.open(); f.api.onPost("/mail/$id/claim") { throw ApiException(422, "ITEM_STACK_OVERFLOW", "Full") }
        assertThrows(ApiException::class.java) { runBlocking { f.repository.claim(id, BASE_ID) } }; assertNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET))
        f.api.onPost("/mail/$id/claim") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.claim(id, BASE_ID) } }
        f.api.onPost("/mail/$id/claim") { throw ApiException(404, "BASE_NOT_OWNED", "sold") }
        assertThrows(ApiException::class.java) { runBlocking { f.repository.retryClaim() } }; assertNotNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET))
    }
    @Test fun `failed hydration keeps durable POST proof and subsequent observation never repeats claim`(): Unit = runBlocking {
        val f = Fixture(); f.open(); f.api.onPost("/mail/$id/claim") { f.message = mail("claimed"); f.message }
        f.api.onGet("/mail/status") { throw IOException("offline") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.claim(id, BASE_ID) } }
        assertNotNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET)!!.receipt)
        f.api.onGet("/mail/status") { json("""{"total":1,"unread":0,"pendingRewards":0}""") }
        f.repository.checkClaim(); assertEquals(1, f.api.posts.size); assertNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET))
    }
    @Test fun `wrong mail identity or changed attachments never resolve durable claim`(): Unit = runBlocking {
        val f = Fixture(); f.open(); f.api.onPost("/mail/$id/claim") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.claim(id, BASE_ID) } }
        f.message = mail("claimed", messageId = other)
        assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.repository.checkClaim() } }
        assertNotNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET))
        f.message = mail("claimed", keepOnly = true)
        assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.repository.checkClaim() } }
        assertNotNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET))
    }
    @Test fun `only a server expired receipt can retire an expired escrow`(): Unit = runBlocking {
        val f = Fixture(); f.open(); f.api.onPost("/mail/$id/claim") { f.message = mail("expired"); f.message }
        f.repository.claim(id, BASE_ID)
        assertNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET)); assertTrue(f.repository.state.value.claimNotice!!.contains("No reward was claimed"))
    }
    @Test fun `superseded identity cannot publish mail or release its saved request`(): Unit = runBlocking {
        val f = Fixture(); f.open(); f.api.onPost("/mail/$id/claim") { signedIn(f.holder, "different-wallet"); mail("claimed") }
        assertThrows(CancellationException::class.java) { runBlocking { f.repository.claim(id, BASE_ID) } }
        assertEquals("pending", f.repository.state.value.detail!!.rewardState); assertNotNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET))
    }
    @Test fun `stale consent for another mail or base fails before a claim journal is created`(): Unit = runBlocking {
        val f = Fixture(); f.open()
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.claim(other, BASE_ID) } }
        f.base = other
        assertThrows(CancellationException::class.java) { runBlocking { f.repository.claim(id, BASE_ID) } }
        assertTrue(f.api.posts.isEmpty()); assertNull(f.store.get(IntentKind.MAIL_CLAIM, WALLET))
    }
    @Test fun `paging uses canonical bounds and rejects repeated pages without duplicating messages`(): Unit = runBlocking {
        val f = Fixture(); f.api.onGet("/mail") { query ->
            assertEquals("20", query["limit"]); assertEquals("false", query["archived"])
            json("""{"messages":[${f.message}],"nextCursor":"$id"}""")
        }
        f.repository.refreshMail(false)
        assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.repository.moreMail() } }
        assertEquals(1, f.repository.state.value.mailbox!!.messages.size)
    }
    @Test fun `read and archive uncertain acknowledgements reconcile with GET without repeating mutations`(): Unit = runBlocking {
        val f = Fixture(); f.open()
        f.api.onPost("/mail/$id/read") { f.message = JsonObject(f.message + ("readAt" to JsonPrimitive("2026-09-12T00:00:01Z"))); throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.markRead() } }
        f.repository.openMail(id); assertNotNull(f.repository.state.value.detail!!.readAt); assertEquals(1, f.api.posts.size)
        f.api.onPost("/mail/$id/archive") { f.message = JsonObject(f.message + ("archivedAt" to JsonPrimitive("2026-09-12T00:00:02Z"))); f.message }
        f.repository.archive(); assertNotNull(f.repository.state.value.detail!!.archivedAt); assertEquals(2, f.api.posts.size)
    }
    @Test fun `closing an in-flight mail detail prevents a late response from reopening it`(): Unit = runBlocking {
        val f = Fixture(); f.api.onGet("/mail/$id") { f.repository.closeMail(); f.message }
        assertThrows(CancellationException::class.java) { runBlocking { f.open() } }
        assertNull(f.repository.state.value.detail)
    }
    @Test fun `malformed terminal reward cannot imply a claim without its timestamp or base destination`(): Unit = runBlocking {
        val claimed = mail("claimed")
        for (key in listOf("claimedAt", "claimBaseId")) {
            assertThrows(IllegalArgumentException::class.java) { MailMessage.from(JsonObject(claimed + (key to JsonNull))) }
        }
        assertThrows(Exception::class.java) { MailMessage.from(JsonObject(claimed - "rewardState")) }
    }
    private fun leagues() = json("""{"week":{"startsAt":"2026-09-07T00:00:00Z","closesAt":"2026-09-14T00:00:00Z","settlesAt":"2026-09-14T00:15:00Z"},
        "rewards":{"status":"scheduled","firstSettlementAt":"2026-09-14T00:15:00Z","minRatedAttacks":3,"maxRewardedBasesPerWallet":1},
        "trophyModel":"cumulative","you":null,"board":[],"lastSettlement":null}""")
    @Test fun `league rewards are server observations with no client claim or locally inferred eligibility`(): Unit = runBlocking {
        val f = Fixture(); f.api.onGet("/leagues") { assertEquals(BASE_ID, it["baseId"]); leagues() }
        f.repository.refreshLeagues(); assertEquals("scheduled", f.repository.state.value.leagues!!.rewards.status); assertTrue(f.api.posts.isEmpty())
        f.api.onGet("/leagues") { f.base = other; leagues() }
        assertThrows(CancellationException::class.java) { runBlocking { f.repository.refreshLeagues() } }
        assertEquals(BASE_ID, f.repository.state.value.leagueBaseId)
    }
    private fun leaguesWithSkr(wallet: String = WALLET) = JsonObject(leagues() + mapOf(
        "ladderVersion" to JsonPrimitive(2),
        "you" to json("""{"baseId":"$BASE_ID","trophies":3500,"tier":"sol","tierV2":"diamond",
            "currentWeekRatedAttacks":3,"participationMet":true,"rewardCandidate":true,"blockedByHigherBase":false,
            "weeklyScore":-3,"rewardV2":{"shards":"22500","gems":"500","pack":[]}}"""),
        "skr" to json("""{"status":"payout_deferred","mint":"$WALLET","label":"Devnet test SKR, not official SKR",
            "entitlement":{"week":"2026-09-07","amountRaw":"9007199254740993","baseId":"$other","wallet":"$wallet",
            "decimals":9,"place":11,"band":2,"weeklyScore":17,"payoutStatus":"not_implemented"}}"""),
    ))
    @Test fun `league in-flight A to B to A rejects the old selection generation`(): Unit = runBlocking {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val reply = CompletableDeferred<JsonObject>()
        f.api.onGet("/leagues") { query ->
            assertEquals(mapOf("baseId" to BASE_ID), query)
            entered.complete(Unit); reply.await()
        }
        val pending = async { runCatching { f.repository.refreshLeagues() } }
        entered.await(); f.select(other); f.select(BASE_ID)
        assertEquals(BASE_ID, f.base); assertEquals(2L, f.selectionGeneration)
        reply.complete(leaguesWithSkr())
        assertTrue(pending.await().exceptionOrNull() is CancellationException)
        assertNull(f.repository.state.value.leagues); assertFalse(f.repository.state.value.busy)
        assertTrue(f.api.posts.isEmpty()); assertEquals(1, f.api.gets.count { it.first == "/leagues" })
        f.api.onGet("/leagues") { leaguesWithSkr() }
        f.repository.refreshLeagues()
        assertEquals(2L, f.repository.state.value.leagueSelectionGeneration)
        assertEquals("diamond", f.repository.state.value.leagues!!.you!!.tierV2)
    }
    @Test fun `a new generation clears cached same-base leagues before its request even when refresh fails`(): Unit = runBlocking {
        val f = Fixture(); f.api.onGet("/leagues") { leaguesWithSkr() }
        f.repository.refreshLeagues(); assertNotNull(f.repository.state.value.leagues)
        f.select(other); f.select(BASE_ID)
        f.api.onGet("/leagues") {
            assertNull(f.repository.state.value.leagues)
            assertEquals(2L, f.repository.state.value.leagueSelectionGeneration)
            throw IOException("offline")
        }
        assertThrows(IOException::class.java) { runBlocking { f.repository.refreshLeagues() } }
        assertNull(f.repository.state.value.leagues); assertFalse(f.repository.state.value.busy)
        assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `league SKR accepts the signed-in wallets frozen allocation from another winning base`(): Unit = runBlocking {
        val f = Fixture(); f.api.onGet("/leagues") { leaguesWithSkr() }
        f.repository.refreshLeagues()
        val overview = requireNotNull(f.repository.state.value.leagues)
        val standing = requireNotNull(overview.you)
        val entitlement = requireNotNull(overview.skr?.entitlement)
        assertEquals(f.session.wallet, entitlement.wallet); assertEquals(other, entitlement.baseId)
        assertNotEquals(standing.baseId, entitlement.baseId)
        assertEquals("9007199254740993", entitlement.amountRaw); assertEquals("not_implemented", entitlement.payoutStatus)
        assertEquals(-3, standing.weeklyScore); assertNotNull(standing.rewardV2)
        assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `league SKR hides only a foreign wallet entitlement and preserves the rest of the overview`(): Unit = runBlocking {
        val foreignWallet = "11111111111111111111111111111111"
        val raw = leaguesWithSkr(foreignWallet)
        val decoded = LeagueOverview.from(raw)
        val decodedSkr = requireNotNull(decoded.skr)
        assertEquals(foreignWallet, decodedSkr.entitlement!!.wallet) // Valid wire identity, wrong signed-in account.
        val f = Fixture(); f.api.onGet("/leagues") { raw }
        f.repository.refreshLeagues()
        val overview = requireNotNull(f.repository.state.value.leagues)
        assertNull(overview.skr!!.entitlement)
        assertEquals(decodedSkr.copy(entitlement = null), overview.skr)
        assertEquals(decoded.copy(skr = decodedSkr.copy(entitlement = null)), overview)
        assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `missing mail constants fail closed before HTTP`(): Unit = runBlocking {
        assertNull(MailBounds.from(json("""{"constants":{}}""")))
        assertEquals(MailBounds(7, 11), MailBounds.from(json("""{"constants":{"MAIL":{"listLimitDefault":7,"listLimitMax":11}}}""")))
        val f = Fixture(); val repo = LiveCommunityRepository(f.session, f.holder, f.api, f.store, f.observer, { f.base }, { null })
        assertThrows(IllegalArgumentException::class.java) { runBlocking { repo.refreshMail(false) } }; assertTrue(f.api.gets.isEmpty())
    }
}
