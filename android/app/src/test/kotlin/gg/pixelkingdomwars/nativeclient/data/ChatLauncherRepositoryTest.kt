package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.chatDecimal
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class ChatLauncherRepositoryTest {
    private val key = "eee0575f-6df7-4672-91ea-33f497d2e1d6"
    private val bounds = ChatBounds(2, 4, 1024, 4, 280, 2000, 20000)
    private fun event(id: String, messageId: String = id, mentioned: Boolean = false, redacted: Boolean = false) = buildJsonObject {
        put("id", id); put("messageId", messageId); put("type", if (redacted) "redaction" else "message")
        put("createdAt", "2026-09-13T00:00:00Z")
        if (!redacted) put("message", json("""{"id":"$messageId","clientMessageId":"$key","text":"hello @Player",
            "createdAt":"2026-09-13T00:00:00Z","author":{"name":"Player","avatarUrl":null,"seekerVerified":false},
            "canBlock":true,"mentioned":$mentioned,"mentions":[]}"""))
    }
    private fun page(cursor: String, vararg events: JsonObject) = buildJsonObject { put("events", JsonArray(events.toList())); put("nextAfter", cursor) }
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient(); val disk = MemoryStore()
        val outbox = ChatOutbox(disk, session.wallet, session.origin)
        val repo = LiveChatRepository(session, holder, api, outbox, { bounds })
        var enabled = true; var latest = "9"; var events = page("9")
        init {
            api.onGet("/chat/status") { status() }
            api.onGet("/chat/events") { events }
            api.onGet("/chat/messages") { json("""{"messages":[],"nextBefore":null}""") }
        }
        fun status() = json("""{"enabled":$enabled,"canSend":$enabled,"sendBlockedReason":${if (enabled) "null" else "\"DISABLED\""},
            "mutedUntil":null,"latestEventId":"$latest","pollOpenMs":2500,"pollClosedMs":25000}""")
    }

    @Test fun `initial capability starts after current history and filtered raw cursors remain lossless`(): Unit = runBlocking {
        val f = Fixture(); f.latest = "9007199254740993"; f.repo.pollLauncher()
        assertEquals(listOf("/chat/status"), f.api.gets.map { it.first })
        assertTrue(f.repo.launcher.value.enabled); assertEquals(0, f.repo.launcher.value.unread)
        assertEquals(25000L, f.repo.launcher.value.status!!.pollClosedMs)
        f.api.onGet("/chat/events") {
            assertEquals("9007199254740993", it["after"]); assertEquals("2", it["limit"])
            page("9007199254740998")
        }
        f.repo.pollLauncher()
        assertEquals("9007199254740998", f.repo.launcher.value.cursor)
        assertTrue(chatDecimal(f.repo.launcher.value.cursor!!) > chatDecimal("9007199254740993"))
        assertEquals(ChatState(), f.repo.state.value); assertTrue(f.api.posts.isEmpty())
    }

    @Test fun `bounded unread IDs deduplicate messages use server mentions and retire redactions`(): Unit = runBlocking {
        val f = Fixture(); f.repo.pollLauncher()
        f.events = page("11", event("10", mentioned = true), event("11")); f.repo.pollLauncher()
        assertEquals(2, f.repo.launcher.value.unread); assertEquals(1, f.repo.launcher.value.mentions)
        f.events = page("13", event("12", "10", mentioned = true), event("13", "12")); f.repo.pollLauncher()
        assertEquals(3, f.repo.launcher.value.unread)
        f.events = page("15", event("14"), event("15", mentioned = true)); f.repo.pollLauncher()
        assertEquals(4, f.repo.launcher.value.unread); assertEquals(1, f.repo.launcher.value.mentions)
        f.events = page("17", event("16", "15", redacted = true), event("17", "999", redacted = true))
        f.repo.pollLauncher()
        assertEquals(3, f.repo.launcher.value.unread); assertEquals(0, f.repo.launcher.value.mentions)
        assertTrue(f.repo.state.value.messages.isEmpty()); assertTrue(f.api.posts.isEmpty())
    }

    @Test fun `disabled capability polls only status and reenabling skips disabled interval history`(): Unit = runBlocking {
        val f = Fixture(); f.enabled = false
        f.repo.pollLauncher(); f.repo.pollLauncher()
        assertFalse(f.repo.launcher.value.enabled); assertNull(f.repo.launcher.value.cursor)
        assertEquals(listOf("/chat/status", "/chat/status"), f.api.gets.map { it.first })
        f.enabled = true; f.latest = "40"; f.repo.pollLauncher()
        assertEquals("40", f.repo.launcher.value.cursor); assertEquals(0, f.repo.launcher.value.unread)
        f.events = page("41", event("41", mentioned = true)); f.repo.pollLauncher()
        assertEquals(1, f.repo.launcher.value.mentions)
    }

    @Test fun `missing capability stays hidden until eligibility resets while events disabled reprobes status`(): Unit = runBlocking {
        val f = Fixture(); f.api.onGet("/chat/status") { throw ApiException(404, null, "Missing") }
        f.repo.pollLauncher(); f.repo.pollLauncher()
        assertTrue(f.repo.launcher.value.capabilityMissing); assertFalse(f.repo.launcher.value.enabled)
        assertEquals(1, f.api.gets.size)
        f.repo.clearLauncher(); f.api.onGet("/chat/status") { f.status() }; f.repo.pollLauncher()
        assertTrue(f.repo.launcher.value.enabled)
        f.api.onGet("/chat/events") { throw ApiException(503, "CHAT_DISABLED", "Disabled") }; f.repo.pollLauncher()
        assertFalse(f.repo.launcher.value.enabled); assertFalse(f.repo.launcher.value.capabilityMissing)
        f.latest = "50"; f.repo.pollLauncher(); assertEquals("50", f.repo.launcher.value.cursor)
    }

    @Test fun `open panel owns polling and closing adopts consumed cursor instead of newer status watermark`(): Unit = runBlocking {
        val f = Fixture(); f.repo.pollLauncher(); f.events = page("10", event("10", mentioned = true)); f.repo.pollLauncher()
        f.repo.setLauncherOpen(true); val reads = f.api.gets.size
        f.repo.pollLauncher(); assertEquals(reads, f.api.gets.size); assertEquals(0, f.repo.launcher.value.unread)
        f.latest = "20"; f.repo.refresh(); f.latest = "30"; f.events = page("25", event("25")); f.repo.poll()
        assertEquals("25", f.repo.state.value.cursor)
        f.repo.setLauncherOpen(false)
        assertEquals("25", f.repo.launcher.value.cursor); assertEquals("30", f.repo.launcher.value.status!!.latestEventId)
        assertEquals(0, f.repo.launcher.value.unread)
        f.api.onGet("/chat/events") { assertEquals("25", it["after"]); page("26", event("26", mentioned = true)) }
        f.repo.pollLauncher(); assertEquals(1, f.repo.launcher.value.mentions)
        assertEquals(listOf("25"), f.repo.state.value.messages.map { it.id })
    }

    @Test fun `launcher replies cannot publish after eligibility clear or opening and overlapping polls do not duplicate reads`(): Unit = runBlocking {
        for (open in listOf(false, true)) {
            val f = Fixture(); f.repo.pollLauncher()
            val entered = CompletableDeferred<Unit>(); val reply = CompletableDeferred<JsonObject>()
            f.api.onGet("/chat/events") { entered.complete(Unit); reply.await() }
            val poll = launch { f.repo.pollLauncher() }; entered.await(); val count = f.api.gets.size
            f.repo.pollLauncher(); assertEquals(count, f.api.gets.size)
            if (open) f.repo.setLauncherOpen(true) else f.repo.clearLauncher()
            reply.complete(page("10", event("10", mentioned = true))); poll.join()
            assertEquals(0, f.repo.launcher.value.unread)
            assertEquals(if (open) "9" else null, f.repo.launcher.value.cursor)
        }
    }

    @Test fun `superseded account cannot receive a late status or mention and new account inherits no badge`(): Unit = runBlocking {
        for (statusRead in listOf(false, true)) {
            val f = Fixture(); if (!statusRead) f.repo.pollLauncher()
            f.api.onGet(if (statusRead) "/chat/status" else "/chat/events") {
                signedIn(f.holder, "other-wallet")
                if (statusRead) f.status() else page("10", event("10", mentioned = true))
            }
            assertTrue(runCatching { f.repo.pollLauncher() }.exceptionOrNull() is CancellationException)
            assertEquals(0, f.repo.launcher.value.unread)
            val next = requireNotNull(f.holder.current)
            val other = LiveChatRepository(next, f.holder, f.api, ChatOutbox(MemoryStore(), next.wallet, next.origin), { bounds })
            assertEquals(ChatLauncherState(), other.launcher.value)
        }
    }

    @Test fun `cursor regression and transient errors retain unread and never jump to status watermark`(): Unit = runBlocking {
        val f = Fixture(); f.repo.pollLauncher(); f.events = page("10", event("10", mentioned = true)); f.repo.pollLauncher()
        f.latest = "99"; f.events = page("8")
        assertTrue(runCatching { f.repo.pollLauncher() }.exceptionOrNull() is ApiCompatibilityException)
        assertEquals("10", f.repo.launcher.value.cursor); assertEquals(1, f.repo.launcher.value.mentions)
        f.api.onGet("/chat/events") { throw IOException("interrupted") }
        assertTrue(runCatching { f.repo.pollLauncher() }.exceptionOrNull() is IOException)
        assertEquals("10", f.repo.launcher.value.cursor); assertEquals(1, f.repo.launcher.value.unread)
        f.repo.markLauncherRead(); assertEquals(0, f.repo.launcher.value.unread); assertEquals("10", f.repo.launcher.value.cursor)
    }

    @Test fun `launcher reads and reset cannot reconcile erase or retry an uncertain message`(): Unit = runBlocking {
        val f = Fixture(); val pending = SavedChatMessage(f.session.wallet, f.session.origin, key, "saved", true)
        f.outbox.create(pending); f.repo.pollLauncher()
        val own = event("10").toMutableMap(); own["message"] = JsonObject(own.getValue("message").jsonObject + ("canBlock" to JsonPrimitive(false)))
        f.events = page("10", JsonObject(own)); f.repo.pollLauncher(); f.repo.clearLauncher()
        assertEquals(pending, f.outbox.read()); assertEquals(ChatState(), f.repo.state.value)
        assertTrue(f.api.posts.isEmpty()); assertTrue(f.api.deletes.isEmpty())
    }
}
