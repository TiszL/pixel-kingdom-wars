package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Dead-end audit 2026-10-06 (shape B). A chat message whose acknowledgement was lost, and whose retry the server then
 * refused, blocked SEND forever: no GET lists one exact clientMessageId completely and nothing else cleared it. Chat
 * moves no money, so the door no longer blocks: the saved message keeps its RETRY and a new one sends under a new UUID. */
class ChatOutboxShapeBTest {
    private val first = "eee0575f-6df7-4672-91ea-33f497d2e1d6"
    private val second = "c310a4a4-d7b5-424a-b8f8-cd77d01114a3"
    private val bounds = ChatBounds(2, 4, 1024, 4, 280, 2000, 20000)
    private fun message(id: String, client: String, text: String) = json("""{"id":"$id","clientMessageId":"$client","text":${JsonPrimitive(text)},
        "createdAt":"2026-09-12T00:00:00Z","author":{"name":"Player","avatarUrl":null,"seekerVerified":true},"canBlock":false,"mentions":[],"mentioned":false}""")
    private inner class Fixture(ids: List<String> = listOf(first, second)) {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient(); val disk = MemoryStore()
        val outbox = ChatOutbox(disk, WALLET, session.origin); private val next = ids.iterator()
        val repo = LiveChatRepository(session, holder, api, outbox, { bounds }, { next.next() })
        var lose = setOf(first)
        init {
            api.onGet("/chat/status") { json("""{"enabled":true,"canSend":true,"sendBlockedReason":null,"mutedUntil":null,"latestEventId":"9","pollOpenMs":2500,"pollClosedMs":25000}""") }
            api.onGet("/chat/messages") { json("""{"messages":[],"nextBefore":null}""") }
            api.onPost("/chat/messages") { body ->
                val client = body.getValue("clientMessageId").jsonPrimitive.content
                if (client in lose) throw IOException("reply lost")
                message(if (client == first) "1" else "2", client, body.getValue("text").jsonPrimitive.content)
            }
        }
    }

    @Test fun `an unconfirmed saved message never blocks a new one which sends under its own UUID`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh()
        assertTrue(runCatching { f.repo.send("Hello") }.isFailure); assertEquals(first, f.repo.state.value.pending?.clientMessageId)
        assertFalse(f.repo.state.value.outboxFull)
        f.repo.send("Another")
        assertEquals("the new message reached the server under its own UUID", listOf(first, second), f.api.posts.map { it.second.getValue("clientMessageId").jsonPrimitive.content })
        assertEquals("the unconfirmed message stays saved and shown with its RETRY", listOf(first), f.outbox.all().map { it.clientMessageId })
        assertEquals("Hello", f.repo.state.value.pending?.text); assertEquals(listOf("Another"), f.repo.state.value.messages.map { it.text })
        f.lose = emptySet(); f.repo.retry()
        assertEquals("RETRY resends the exact saved UUID and text", first, f.api.posts.last().second.getValue("clientMessageId").jsonPrimitive.content)
        assertTrue(f.outbox.all().isEmpty()); assertNull(f.repo.state.value.pending)
    }
    @Test fun `older single-message outbox bytes still decode and only a full outbox holds SEND`(): Unit = runBlocking {
        val ids = (1..ChatOutbox.MAX_SAVED + 1).map { java.util.UUID.nameUUIDFromBytes("chat-$it".toByteArray()).toString() }
        val f = Fixture(ids); val legacy = SavedChatMessage(WALLET, f.session.origin, first, "Saved before the update", attempted = true)
        f.disk.value = Json.encodeToString(legacy); assertEquals(listOf(legacy), f.outbox.all()); assertEquals(legacy, f.outbox.read())
        f.lose = ids.toSet(); f.repo.refresh()
        repeat(ChatOutbox.MAX_SAVED - 1) { assertTrue(runCatching { f.repo.send("Lost $it") }.isFailure) }
        assertEquals(ChatOutbox.MAX_SAVED, f.outbox.all().size); assertEquals(legacy, f.outbox.read()); assertTrue(f.repo.state.value.outboxFull)
        val posts = f.api.posts.size; assertTrue(runCatching { f.repo.send("One too many") }.isFailure); assertEquals(posts, f.api.posts.size)
    }
}
