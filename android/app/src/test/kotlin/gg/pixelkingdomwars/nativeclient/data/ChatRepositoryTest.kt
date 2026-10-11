package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class ChatRepositoryTest {
    private val key = "eee0575f-6df7-4672-91ea-33f497d2e1d6"
    private val otherKey = "c310a4a4-d7b5-424a-b8f8-cd77d01114a3"
    private val bounds = ChatBounds(2, 4, 1024, 4, 280, 2000, 20000)
    private fun message(id: String = "1", client: String = key, canBlock: Boolean = false, text: String = "Hello") = json("""{
        "id":"$id","clientMessageId":"$client","text":${JsonPrimitive(text)},"createdAt":"2026-09-12T00:00:00Z",
        "author":{"name":"Player","avatarUrl":null,"seekerVerified":true},"canBlock":$canBlock,"mentions":[],"mentioned":false}""")
    private inner class Fixture(val disk: MemoryStore = MemoryStore()) {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val outbox = ChatOutbox(disk, WALLET, session.origin)
        val repo = LiveChatRepository(session, holder, api, outbox, { bounds }, { key })
        var messages = "[]"; var before: String? = null; var enabled = true
        init {
            api.onGet("/chat/status") { json("""{"enabled":$enabled,"canSend":$enabled,"sendBlockedReason":${if (enabled) "null" else "\"DISABLED\""},
                "mutedUntil":null,"latestEventId":"9","pollOpenMs":2500,"pollClosedMs":25000}""") }
            api.onGet("/chat/messages") { json("""{"messages":$messages,"nextBefore":${before?.let { "\"$it\"" } ?: "null"}}""") }
            api.onGet("/chat/events") { json("""{"events":[],"nextAfter":"9"}""") }
        }
    }
    @Test fun `send freezes normalized text and UUID in encrypted outbox before only POST`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh()
        f.api.onPost("/chat/messages") { body ->
            val saved = requireNotNull(f.outbox.read()); assertTrue(saved.attempted); assertEquals(key, saved.clientMessageId)
            assertEquals("é\nHello", saved.text); assertEquals(saved.text, body.string("text")); message(text = saved.text)
        }
        f.repo.send(" e\u0301\r\nHello ")
        assertNull(f.outbox.read()); assertEquals(1, f.api.posts.size); assertEquals("é\nHello", f.repo.state.value.messages.single().text)
    }
    @Test fun `process death recovers own exact client UUID from GET without resending`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.api.onPost("/chat/messages") { throw IOException("reply lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.send("Hello") } }
        val restored = Fixture(f.disk); restored.messages = "[${message()}]"; restored.repo.refresh()
        assertNull(restored.outbox.read()); assertTrue(restored.api.posts.isEmpty())
    }
    @Test fun `another authors same client UUID cannot clear pending message`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.api.onPost("/chat/messages") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.send("Hello") } }
        f.messages = "[${message(canBlock = true)}]"; f.repo.refresh(); assertNotNull(f.outbox.read())
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.send("Another") } }; assertEquals(1, f.api.posts.size)
    }
    @Test fun `explicit retry retains exact text and key despite updated composer`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.api.onPost("/chat/messages") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.send("Hello") } }
        f.api.onPost("/chat/messages") { body -> assertEquals(key, body.string("clientMessageId")); assertEquals("Hello", body.string("text")); message() }
        f.repo.retry(); assertEquals(f.api.posts[0].second, f.api.posts[1].second); assertNull(f.outbox.read())
    }
    @Test fun `first definitive refusal clears outbox but uncertain replay refusal preserves it`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.api.onPost("/chat/messages") { throw ApiException(403, "CHAT_MUTED", "Muted") }
        assertThrows(ApiException::class.java) { runBlocking { f.repo.send("Hello") } }; assertNull(f.outbox.read())
        f.api.onPost("/chat/messages") { throw IOException("lost") }; assertThrows(IOException::class.java) { runBlocking { f.repo.send("Hello") } }
        f.api.onPost("/chat/messages") { throw ApiException(503, "CHAT_DISABLED", "Disabled") }
        assertThrows(ApiException::class.java) { runBlocking { f.repo.retry() } }; assertNotNull(f.outbox.read())
    }
    @Test fun `canonical redacted replay closes only saved message and does not claim delivery`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.api.onPost("/chat/messages") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.send("Hello") } }
        f.api.onPost("/chat/messages") { throw ApiException(409, "CHAT_MESSAGE_REDACTED", "Removed") }
        f.repo.retry(); assertNull(f.outbox.read()); assertTrue(f.repo.state.value.notice!!.contains("removed by moderation"))
    }
    @Test fun `filtered event page advances raw cursor even when every message is invisible`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh()
        f.api.onGet("/chat/events") { assertEquals("9", it["after"]); json("""{"events":[],"nextAfter":"17"}""") }
        f.repo.poll(); assertEquals("17", f.repo.state.value.cursor)
        f.api.onGet("/chat/events") { assertEquals("17", it["after"]); json("""{"events":[],"nextAfter":"19"}""") }
        f.repo.poll(); assertEquals("19", f.repo.state.value.cursor); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `redaction removes existing message and decimal IDs remain lossless beyond JS integer range`(): Unit = runBlocking {
        val f = Fixture(); val big = "9007199254740993"; f.messages = "[${message(big)}]"; f.repo.refresh()
        f.api.onGet("/chat/events") { json("""{"events":[{"id":"10","type":"redaction","createdAt":"2026-09-12T00:00:01Z","messageId":"$big"}],"nextAfter":"10"}""") }
        f.repo.poll(); assertTrue(f.repo.state.value.messages.isEmpty())
        assertTrue(chatDecimal(big) > chatDecimal("9007199254740992"))
    }
    @Test fun `cursor regression is refused without dropping current visible messages`(): Unit = runBlocking {
        val f = Fixture(); f.messages = "[${message()}]"; f.repo.refresh()
        f.api.onGet("/chat/events") { json("""{"events":[],"nextAfter":"8"}""") }
        assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.repo.poll() } }
        assertEquals("9", f.repo.state.value.cursor); assertEquals(1, f.repo.state.value.messages.size)
    }
    @Test fun `status capture before history has no event gap and events deduplicate visible history`(): Unit = runBlocking {
        val f = Fixture(); f.messages = "[${message()}]"; f.repo.refresh()
        assertEquals(listOf("/chat/status", "/chat/messages"), f.api.gets.map { it.first })
        f.api.onGet("/chat/events") { json("""{"events":[{"id":"10","type":"message","createdAt":"2026-09-12T00:00:01Z","messageId":"1","message":${message()}}],"nextAfter":"10"}""") }
        f.repo.poll(); assertEquals(1, f.repo.state.value.messages.size)
    }
    @Test fun `disabled chat stops message reads and send while status remains refreshable`(): Unit = runBlocking {
        val f = Fixture(); f.enabled = false; f.repo.refresh(); assertEquals(listOf("/chat/status"), f.api.gets.map { it.first })
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.send("Hello") } }; assertTrue(f.api.posts.isEmpty())
        f.enabled = true; f.repo.poll(); assertNotNull(f.repo.state.value.cursor)
    }
    @Test fun `late response cannot publish a superseded wallet or erase its outbox`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.api.onPost("/chat/messages") { signedIn(f.holder, "other-wallet"); message() }
        assertThrows(CancellationException::class.java) { runBlocking { f.repo.send("Hello") } }
        assertNotNull(f.outbox.read()); assertTrue(f.repo.state.value.messages.isEmpty())
    }
    @Test fun `corrupt or other-origin outbox fails closed without an outgoing message`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.disk.value = "corrupt"
        assertThrows(Exception::class.java) { runBlocking { f.repo.send("Hello") } }; assertTrue(f.api.posts.isEmpty())
        f.disk.value = Json.encodeToString(SavedChatMessage(WALLET, "https://other", key, "Hello"))
        assertThrows(IllegalStateException::class.java) { f.outbox.read() }
    }
    @Test fun `server UTF16 mention spans style exact substrings and reject split surrogate offsets`(): Unit = runBlocking {
        val raw = message(text = "🐉 @Player")
        val valid = ChatMessage.from(JsonObject(raw + ("mentions" to Json.parseToJsonElement("[{\"start\":3,\"end\":10}]"))))
        assertEquals("@Player", valid.text.substring(valid.mentions.single().start, valid.mentions.single().end))
        assertThrows(IllegalArgumentException::class.java) { ChatMessage.from(JsonObject(raw + ("mentions" to Json.parseToJsonElement("[{\"start\":1,\"end\":2}]")))) }
        assertTrue(ChatMessage.from(raw).mentions.isEmpty())
    }
    @Test fun `blocks and reports use opaque public IDs and never disclose wallets`(): Unit = runBlocking {
        val f = Fixture(); f.messages = "[${message(canBlock = true)}]"; f.repo.refresh()
        f.api.onPost("/chat/messages/1/report") { assertEquals("spam", it.string("reason")); json("{}") }
        f.repo.report("1", "spam")
        f.api.onPost("/chat/messages/1/block") { assertTrue(it.isEmpty()); f.messages = "[]"; json("{}") }
        f.api.onGet("/chat/blocks") { json("""{"blocks":[{"id":"7","createdAt":"2026-09-12T00:00:00Z","author":{"name":"Player","avatarUrl":null,"seekerVerified":false}}],"nextBefore":null}""") }
        f.repo.block("1"); assertTrue(f.repo.state.value.messages.isEmpty()); assertEquals("7", f.repo.state.value.blocks!!.blocks.single().id)
        f.api.onDelete("/chat/blocks/7") { json("{}") }; f.repo.unblock("7"); assertEquals(listOf("/chat/blocks/7"), f.api.deletes)
    }
    @Test fun `chat bounds are imported and oversized body refuses before persistence or POST`(): Unit = runBlocking {
        assertNull(ChatBounds.from(json("""{"constants":{}}""")))
        val f = Fixture(); f.repo.refresh()
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repo.send("a".repeat(bounds.maxUtf8Bytes + 1)) } }
        assertTrue(f.api.posts.isEmpty()); assertNull(f.outbox.read())
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repo.avatar("https://attacker/avatar.webp", 1024) } }
    }
    // ---- 0.5.5 composer convenience (owner: "chatbox is not convenient to use")
    @Test fun `a send pressed while the open poll is reading waits its turn instead of being dropped`(): Unit = runBlocking {
        // The poll holds admission for a moment every cadence. Refusing there made SEND do nothing several times a minute.
        val f = Fixture(); f.repo.refresh(); val gate = CompletableDeferred<Unit>()
        f.api.onGet("/chat/events") { gate.await(); json("""{"events":[],"nextAfter":"9"}""") }
        f.api.onPost("/chat/messages") { message() }
        val poll = launch(Dispatchers.Default) { f.repo.poll() }
        while (!f.repo.state.value.busy) delay(1)
        val send = async(Dispatchers.Default) { f.repo.send("Hello") }
        delay(100); assertTrue("the message is not posted into the middle of a read", f.api.posts.isEmpty()); assertTrue(send.isActive)
        gate.complete(Unit); send.await(); poll.join()
        assertEquals(1, f.api.posts.size); assertEquals("Hello", f.repo.state.value.messages.single().text); assertNull(f.outbox.read())
    }
    @Test fun `the poll itself never queues so the cadence cannot pile up behind a slow request`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh(); val gate = CompletableDeferred<Unit>(); val reading = CompletableDeferred<Unit>()
        f.api.onGet("/chat/events") { reading.complete(Unit); gate.await(); json("""{"events":[],"nextAfter":"9"}""") }
        val first = launch(Dispatchers.Default) { f.repo.poll() }
        // Wait on the read's own signal: iterating the fake's plain list while the other thread appends to it threw a
        // ConcurrentModificationException now and then (seen 2026-09-19). The rule under test is unchanged.
        reading.await()
        val reads = f.api.gets.size
        f.repo.poll(); assertEquals("a second poll returns at once without a request", reads, f.api.gets.size)
        gate.complete(Unit); first.join(); assertFalse(f.repo.state.value.busy)
    }
    // Rewritten 2026-10-06 (dead-end audit): renamed from "...the saved-message recovery still guards the next send".
    // A saved message no longer blocks a new one (shape B, pinned in ChatOutboxShapeBTest); this fixture's newId is
    // fixed, so the same assertions now pin that one message UUID is never saved twice.
    @Test fun `a failed send keeps the typed draft and a reused message UUID is never saved twice`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.api.onPost("/chat/messages") { throw IOException("reply lost") }
        val field = "Hello"
        val result = gg.pixelkingdomwars.nativeclient.ui.community.chatSubmit(field, { field }) { f.repo.send(it) }
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.community.ChatSubmit.Failed("Hello", "reply lost"), result)
        assertEquals("Hello", f.repo.state.value.pending?.text); assertFalse("the composer is free to be edited", f.repo.state.value.busy)
        val refused = assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.send("Another") } }
        assertTrue(refused.message!!.contains("Resolve your interrupted message")); assertEquals(1, f.api.posts.size)
    }
    @Test fun `a notice belongs to the request that produced it and is gone with the next one`(): Unit = runBlocking {
        // The composer shows notices as a passing line. A notice that lived forever owned a permanent row.
        val f = Fixture(); f.repo.refresh(); f.api.onPost("/chat/messages") { message() }
        f.repo.send("Hello"); assertEquals(LiveChatRepository.SENT_NOTICE, f.repo.state.value.notice)
        f.repo.poll(); assertNull(f.repo.state.value.notice)
    }
}
