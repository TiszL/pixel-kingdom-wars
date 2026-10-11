package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException

class ProfileRepositoryTest {
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val fake = FakeApiClient()
        var name = "First"; var patches = 0; var uploads = 0; var refreshes = 0
        var patch: suspend (String, JsonObject) -> JsonObject = { _, body -> name = body["name"]!!.jsonPrimitive.content; profile() }
        var upload: suspend (String, String, ByteArray, String) -> JsonObject = { _, _, _, _ -> json("{}") }
        private val api = object : ApiClient by fake {
            override suspend fun patch(path: String, body: JsonObject): JsonObject { patches++; return this@Fixture.patch(path, body) }
            override suspend fun upload(path: String, method: String, bytes: ByteArray, contentType: String): JsonObject { uploads++; return this@Fixture.upload(path, method, bytes, contentType) }
        }
        val repo = LiveProfileRepository(api, WALLET, { holder.requireCurrent(session) }, { refreshes++ })
        init {
            fake.onGet("/me") { profile() }
            fake.onGet("/username/check") { q -> buildJsonObject { put("available", true); put("normalized", q.getValue("name").trim()) } }
            fake.onDelete("/me/avatar") { json("{}") }
        }
        fun profile() = json("""{"wallet":"$WALLET","name":"$name","avatarUrl":null,"avatarUpdatedAt":null,"nameCooldownDays":0}""")
    }
    private val bounds = ProfileBounds(12, 10, 2, 1) // Synthetic transport bounds; production reads shared catalogue.

    @Test fun `name availability is advisory and exact input is required before one PATCH`() = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.repo.checkName("  New  ")
        f.patch = { path, body -> assertEquals("/me", path); assertEquals("  New  ", body["name"]!!.jsonPrimitive.content); f.name = "New"; f.profile() }
        f.repo.rename("  New  ")
        assertEquals(1, f.patches); assertEquals(1, f.refreshes); assertEquals("New", f.repo.state.value.profile!!.name)
        assertFalse(f.repo.state.value.needsRefresh); assertNull(f.repo.state.value.availability)
    }
    @Test fun `editing checked input cannot submit another name`() = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.repo.checkName("Checked")
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repo.rename("Different") } }
        assertEquals(0, f.patches)
    }
    @Test fun `lost name response blocks more writes until current profile GET without replay`() = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.repo.checkName("New")
        f.patch = { _, _ -> f.name = "New"; throw IOException("lost acknowledgment") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.rename("New") } }
        assertTrue(f.repo.state.value.needsRefresh)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.clearAvatar() } }
        assertEquals(1, f.patches); assertTrue(f.fake.deletes.isEmpty())
        f.repo.refresh()
        assertEquals("New", f.repo.state.value.profile!!.name); assertFalse(f.repo.state.value.needsRefresh); assertEquals(1, f.patches)
    }
    @Test fun `server availability refusal never authorizes a name write`() = runBlocking {
        val f = Fixture(); f.repo.refresh()
        f.fake.onGet("/username/check") { json("""{"available":false,"normalized":"Taken","reason":"taken"}""") }
        f.repo.checkName("Taken")
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repo.rename("Taken") } }
        assertEquals(0, f.patches)
    }
    @Test fun `late identity observation and mutation cannot publish to a superseded profile`() = runBlocking {
        for (mutation in listOf(false, true)) {
            val f = Fixture(); f.repo.refresh()
            if (mutation) {
                f.repo.checkName("New")
                f.patch = { _, _ -> signedIn(f.holder, "other"); f.name = "New"; f.profile() }
            } else f.fake.onGet("/me") { signedIn(f.holder, "other"); f.name = "Other"; f.profile() }
            assertThrows(CancellationException::class.java) { runBlocking { if (mutation) f.repo.rename("New") else f.repo.refresh() } }
            assertEquals("First", f.repo.state.value.profile!!.name)
        }
    }
    @Test fun `a wrong wallet response cannot become the current profile`() = runBlocking {
        val f = Fixture(); f.fake.onGet("/me") { json("""{"wallet":"other","name":"Wrong","nameCooldownDays":0}""") }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repo.refresh() } }
        assertNull(f.repo.state.value.profile)
    }
    @Test fun `avatar upload sends bounded raw image bytes and never a selected base`() = runBlocking {
        val f = Fixture(); f.repo.refresh(); val bytes = byteArrayOf(0, -1, 1)
        f.upload = { path, method, actual, type ->
            assertEquals("/me/avatar", path); assertEquals("PATCH", method); assertEquals("image/png", type); assertArrayEquals(bytes, actual); json("{}")
        }
        f.repo.upload(bytes, "image/png", bounds)
        assertEquals(1, f.uploads); assertEquals(1, f.refreshes); assertFalse(f.repo.state.value.needsRefresh)
        assertTrue(f.fake.posts.isEmpty())
    }
    @Test fun `lost avatar response retains uncertainty and never automatically removes or uploads again`() = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.upload = { _, _, _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.upload(byteArrayOf(1), "image/png", bounds) } }
        assertEquals(1, f.uploads); assertTrue(f.repo.state.value.needsRefresh); assertTrue(f.fake.deletes.isEmpty())
        f.repo.refresh(); assertFalse(f.repo.state.value.needsRefresh); assertEquals(1, f.uploads)
    }
    @Test fun `oversized empty and interrupted picker streams stop before decoding or upload`() {
        assertArrayEquals(byteArrayOf(1, 2), readProfileImage(ByteArrayInputStream(byteArrayOf(1, 2)), 2))
        assertThrows(IllegalArgumentException::class.java) { readProfileImage(ByteArrayInputStream(byteArrayOf(1, 2, 3)), 2) }
        assertThrows(IllegalArgumentException::class.java) { readProfileImage(ByteArrayInputStream(byteArrayOf()), 2) }
        assertThrows(CancellationException::class.java) { readProfileImage(ByteArrayInputStream(byteArrayOf(1)), 2) { throw CancellationException() } }
    }
    @Test fun `current shared rules supply every profile bound and missing rules fail closed`() {
        val catalogue = json("""{"constants":{"PROFILE_AVATAR":{"maxUploadBytes":123,"maxNormalizedBytes":77,"outputSizePx":32},"USERNAMES":{"changeCooldownDays":4}}}""")
        assertEquals(ProfileBounds(123, 77, 32, 4), ProfileBounds.from(catalogue))
        assertThrows(IllegalArgumentException::class.java) { ProfileBounds.from(null) }
    }
}
