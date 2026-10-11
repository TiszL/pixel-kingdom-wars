package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/** The player card spends a per-wallet server bucket and shows another player's public face. It is read when a
 * player taps, once, and it fails to one neutral line without ever disturbing the chat behind it. */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatAuthorCardsTest {
    private val aldric = ChatAuthorCard("Aldric", null, true, 2, 9, 340, ChatAuthorClan("Iron Crest", "IRON"))
    private class Server(val answer: suspend (String) -> ChatAuthorCard) {
        val asked = mutableListOf<String>(); var cancelled = 0
        suspend fun fetch(id: String): ChatAuthorCard { asked += id; try { return answer(id) } catch (gone: CancellationException) { cancelled++; throw gone } }
    }
    private fun limited(message: String = "player card limit reached; try again in 12s", retryAfter: Long? = null) =
        ApiException(429, "CHAT_RATE_LIMITED", message, retryAfterSeconds = retryAfter)

    @Test fun `nothing is read until a player opens a card and a second tap on it is not a second GET`() = runTest {
        val gate = CompletableDeferred<ChatAuthorCard>(); val server = Server { gate.await() }
        val cards = ChatAuthorCards(backgroundScope, { 0L }, server::fetch)
        runCurrent(); assertTrue("never prefetched", server.asked.isEmpty()); assertNull(cards.open.value)
        cards.open("7"); cards.open("7"); runCurrent()
        assertEquals("the plate opens at once, before the facts", ChatCardView("7", ChatCardState.Loading), cards.open.value)
        cards.open("7"); runCurrent(); assertEquals("taps while it loads are one request", listOf("7"), server.asked)
        gate.complete(aldric); runCurrent()
        assertEquals(ChatCardView("7", ChatCardState.Loaded(aldric)), cards.open.value)
        cards.open("7"); runCurrent(); assertEquals(listOf("7"), server.asked)
    }
    @Test fun `a loaded card is reused while the chat is open and forgotten with its message`() = runTest {
        val server = Server { aldric }; val cards = ChatAuthorCards(backgroundScope, { 0L }, server::fetch)
        cards.open("7"); runCurrent(); cards.dismiss(); assertNull(cards.open.value)
        cards.open("7"); runCurrent()
        assertEquals(ChatCardView("7", ChatCardState.Loaded(aldric)), cards.open.value); assertEquals("every read spends the wallet's card bucket", listOf("7"), server.asked)
        cards.retain(setOf("8")); assertNull("redacted or blocked while open: the card leaves with the message", cards.open.value)
        cards.open("7"); runCurrent(); assertEquals(listOf("7", "7"), server.asked)
    }
    @Test fun `dismissing cancels the read in flight and a late answer opens nothing`() = runTest {
        val gate = CompletableDeferred<ChatAuthorCard>(); val server = Server { gate.await() }
        val cards = ChatAuthorCards(backgroundScope, { 0L }, server::fetch)
        cards.open("7"); runCurrent(); cards.dismiss(); runCurrent()
        assertEquals(1, server.cancelled); gate.complete(aldric); runCurrent(); assertNull(cards.open.value)
        cards.open("7"); runCurrent(); assertEquals("a cancelled read left nothing behind", listOf("7", "7"), server.asked)
    }
    @Test fun `opening another player cancels the first read and only the open card is filled`() = runTest {
        val gates = mapOf("7" to CompletableDeferred<ChatAuthorCard>(), "8" to CompletableDeferred())
        val server = Server { gates.getValue(it).await() }; val cards = ChatAuthorCards(backgroundScope, { 0L }, server::fetch)
        cards.open("7"); runCurrent(); cards.open("8"); runCurrent()
        assertEquals(1, server.cancelled); gates.getValue("7").complete(aldric); runCurrent()
        assertEquals(ChatCardView("8", ChatCardState.Loading), cards.open.value)
        val other = aldric.copy(name = "Newcomer", bases = 0, clan = null); gates.getValue("8").complete(other); runCurrent()
        assertEquals(ChatCardView("8", ChatCardState.Loaded(other)), cards.open.value)
    }
    @Test fun `every failure but a rate limit is one neutral unavailable and is asked again on the next tap`() = runTest {
        val failures = listOf<Exception>(ApiException(404, "CHAT_MESSAGE_NOT_FOUND", "chat message not found"),
            ApiException(404, null, "Route GET:/chat/messages/7/author not found"), ApiException(400, null, "invalid request: id"),
            ApiException(500, null, "internal"), ApiException(503, "CHAT_DISABLED", "global chat is temporarily disabled"), ApiException(401, null, "authentication required"),
            ApiCompatibilityException("/chat/messages/:id/author"), IOException("offline"), IllegalStateException("This message is no longer available"))
        for (failure in failures) {
            assertEquals(failure.toString(), ChatCardState.Unavailable, chatCardFailure(failure, 0))
            val server = Server { throw failure }; val cards = ChatAuthorCards(backgroundScope, { 0L }, server::fetch)
            cards.open("7"); runCurrent(); assertEquals(ChatCardView("7", ChatCardState.Unavailable), cards.open.value)
            cards.open("7"); runCurrent(); assertEquals("a failure is never cached: the route may exist a moment later", listOf("7", "7"), server.asked)
        }
    }
    @Test fun `a rate limit names its wait and no card is read again before it has passed`() = runTest {
        var now = 1_000L; var failing = true
        val server = Server { if (failing) throw limited() else aldric }; val cards = ChatAuthorCards(backgroundScope, { now }, server::fetch)
        cards.open("7"); runCurrent()
        assertEquals(ChatCardView("7", ChatCardState.RateLimited(13_000)), cards.open.value)
        advanceTimeBy(60_000); runCurrent(); assertEquals("never retried by itself", listOf("7"), server.asked)
        now = 12_999; cards.open("7"); cards.dismiss(); cards.open("8"); runCurrent()
        assertEquals("the bucket is the wallet's: another player's card waits too", ChatCardView("8", ChatCardState.RateLimited(13_000)), cards.open.value)
        assertEquals(listOf("7"), server.asked)
        now = 13_000; failing = false; cards.open("8"); runCurrent()
        assertEquals("the player's own tap after the wait", ChatCardView("8", ChatCardState.Loaded(aldric)), cards.open.value); assertEquals(listOf("7", "8"), server.asked)
    }
    @Test fun `the wait is the header's or the message's trailing seconds and never an absurd one`() {
        assertEquals(12L, chatCardWaitSeconds(limited()))
        assertEquals("a Retry-After header wins", 5L, chatCardWaitSeconds(limited(retryAfter = 5)))
        assertEquals(1L, chatCardWaitSeconds(limited("player card limit reached; try again in 0s")))
        assertEquals(3_600L, chatCardWaitSeconds(limited("player card limit reached; try again in 999999s")))
        assertNull("the per-IP floor names no wait", chatCardWaitSeconds(ApiException(429, null, "Rate limit exceeded")))
        assertEquals(ChatCardState.RateLimited(null), chatCardFailure(ApiException(429, null, "Rate limit exceeded"), 50))
        assertEquals("the code is not needed to back off from a 429", ChatCardState.RateLimited(12_050), chatCardFailure(limited(), 50))
    }

    // ---- the repository read behind the state machine
    private val bounds = ChatBounds(2, 4, 1024, 4, 280, 2000, 20000, maxBases = 5)
    private fun message(id: String, name: String = "Aldric") = """{"id":"$id","clientMessageId":"${java.util.UUID.nameUUIDFromBytes(id.toByteArray())}","text":"hi","createdAt":"2026-09-12T00:00:00Z",
        "author":{"name":"$name","avatarUrl":null,"seekerVerified":true},"canBlock":true,"mentions":[],"mentioned":false}"""
    private fun card(name: String = "Aldric", bases: Int = 2) = json("""{"version":1,"name":"$name","avatarUrl":null,"seekerVerified":true,"bases":$bases,"highestKeepLevel":9,"trophies":340,"clan":{"name":"Iron Crest","tag":"IRON"}}""")
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val repo = LiveChatRepository(session, holder, api, ChatOutbox(MemoryStore(), WALLET, session.origin), { bounds })
        init {
            api.onGet("/chat/status") { json("""{"enabled":true,"canSend":true,"sendBlockedReason":null,"mutedUntil":null,"latestEventId":"9","pollOpenMs":2500,"pollClosedMs":25000}""") }
            api.onGet("/chat/messages") { json("""{"messages":[${message("8", "Newcomer")},${message("7")}],"nextBefore":null}""") }
            api.onGet("/chat/events") { json("""{"events":[],"nextAfter":"9"}""") }
        }
    }
    @Test fun `loading and polling the log never read a card and a tap is one GET by message id only`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.repo.poll(); f.repo.pollLauncher()
        assertTrue("no prefetch for a page of messages", f.api.gets.none { it.first.endsWith("/author") })
        f.api.onGet("/chat/messages/7/author") { card() }
        assertEquals(ChatAuthorCard("Aldric", null, true, 2, 9, 340, ChatAuthorClan("Iron Crest", "IRON")), f.repo.authorCard("7"))
        assertEquals("the message id and nothing else: no wallet, no query", "/chat/messages/7/author" to emptyMap<String, String>(), f.api.gets.last())
        assertTrue("a card is a read: nothing is posted", f.api.posts.isEmpty())
        assertFalse("a card read does not grey the composer out", f.repo.state.value.busy)
    }
    @Test fun `a card is only read for a message in the open log and only shown under that message's name`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh()
        val before = f.api.gets.size
        assertTrue(runCatching { f.repo.authorCard("99") }.exceptionOrNull() is IllegalStateException); assertEquals("an id from anywhere else is never sent", before, f.api.gets.size)
        f.api.onGet("/chat/messages/8/author") { card(name = "Aldric") }
        assertTrue("another player's facts under this name", runCatching { f.repo.authorCard("8") }.exceptionOrNull() is ApiCompatibilityException)
        f.api.onGet("/chat/messages/7/author") { card(bases = 6) }
        assertTrue("above the catalogue's BASE_OWNERSHIP.maxActive", runCatching { f.repo.authorCard("7") }.exceptionOrNull() is ApiCompatibilityException)
        f.api.onGet("/chat/messages/7/author") { JsonObject(card() + ("version" to JsonPrimitive(2))) }
        assertEquals(ChatCardState.Unavailable, chatCardFailure(runCatching { f.repo.authorCard("7") }.exceptionOrNull() as Exception, 0))
    }
    @Test fun `a card that cannot be read leaves the chat exactly as it was`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh(); val before = f.repo.state.value
        f.api.onGet("/chat/messages/7/author") { throw ApiException(404, null, "Route GET:/chat/messages/7/author not found") }
        assertEquals(ChatCardState.Unavailable, chatCardFailure(runCatching { f.repo.authorCard("7") }.exceptionOrNull() as Exception, 0))
        assertEquals("production answers 404 until the route ships: messages, status and notice are untouched", before, f.repo.state.value)
        f.repo.poll(); assertEquals(before.messages, f.repo.state.value.messages)
    }
    @Test fun `the kingdom ceiling comes from the catalogue and an older pack simply has none`() {
        fun catalogue(extra: String) = json("""{"constants":{"CHAT":{"pageSize":50,"domMessageLimit":200,"maxUtf8Bytes":1024,"maxLines":4,"maxGraphemes":280,"pollOpenMs":2000,"pollClosedMs":20000}$extra}}""")
        assertEquals(5, ChatBounds.from(catalogue(""","BASE_OWNERSHIP":{"maxActive":5}"""))?.maxBases)
        assertNotNull(ChatBounds.from(catalogue(""))); assertNull(ChatBounds.from(catalogue(""))?.maxBases)
    }
}
