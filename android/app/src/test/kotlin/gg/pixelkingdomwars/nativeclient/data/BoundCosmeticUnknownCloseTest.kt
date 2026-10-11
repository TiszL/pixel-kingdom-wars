package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Owner rule 2026-10-06 (dead-end audit): a saved request may close only after a fresh by-key GET in the same action
 * answered "unknown" for exactly its key, and never against an accepted proof. The bound-cosmetic store has ONE saved
 * slot per family, so an attempted Awning or Aurora Wake whose reply was lost and whose server record never existed
 * would otherwise block every new appearance craft forever once its resend is refused. */
class BoundCosmeticUnknownCloseTest {
    private val json = Json { encodeDefaults = true }
    private fun source() = requireNotNull(javaClass.getResourceAsStream("/boundcosmetics/final-actual-http.json")).use { json.parseToJsonElement(it.readBytes().toString(Charsets.UTF_8)).jsonObject }
    private val original get() = BoundCosmeticProof.from(source().getValue("originals").jsonArray.single().jsonObject)
    private fun rejects(block: suspend () -> Unit) { assertThrows(Exception::class.java) { runBlocking { block() } } }
    private fun another(command: BoundCosmeticCommand) = command.copy(request = command.request.copy(idempotencyKey = UUID.randomUUID().toString()))

    /** The captured Awning original, attempted with no reply saved; the by-key read answers [accepted] or "unknown". */
    private inner class Awning {
        val holder = testHolder(); val session = signedIn(holder, original.wallet); val memory = MemoryStore()
        val store = BoundCosmeticStore(memory, BoundCosmeticIdentity(session.origin, "devnet", session.wallet))
        val command = requireNotNull(original.receipt).let { BoundCosmeticCommand(it.request, it.recipe, it.appearance) }
        var accepted = false; var posts = 0
        fun unknown(key: String = command.key) = BoundCosmeticProof(1, session.wallet, key, original.serverNow, "unknown", null, null)
        val api = object : ApiClient by FakeApiClient() {
            override suspend fun getBoundCosmetic(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard(); assertEquals(command.receiptPath, path); assertTrue(query.isEmpty())
                val reply = if (accepted) original else unknown()
                return json.encodeToJsonElement(BoundCosmeticProof.serializer(), reply).jsonObject.also { requireNotNull(evidence)(it) }
            }
            override suspend fun postBoundCosmetic(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit): JsonObject {
                posts++; throw IOException("Closing or checking must never resend the original")
            }
        }
        // Paused orders and no selected kingdom: the saved request cannot be reviewed or resent.
        val repository = BoundCosmeticWorkshopRepository(session, holder, api, store,
            BoundCosmeticWorkshopRules(1) { error("No catalogue is needed to close") }, { null }, { 0L }, { null }, {}, { guard -> guard() },
            { false }, { false }, { _, _ -> error("No preview is needed to close") })
        init { store.begin(store.read(), command); store.attempt(store.read()) }
    }

    @Test fun `a saved Awning the server does not know cannot block the Workshop forever`() = runBlocking<Unit> {
        val a = Awning()
        // The dead end: the single saved slot refuses a new craft, and admission refuses the same request again.
        rejects { a.store.begin(a.store.read(), another(a.command)) }; rejects { a.repository.reviewSaved() }; assertEquals(0, a.posts)
        a.repository.archive()
        val closed = a.store.read().archives.single(); assertEquals(a.command, closed.command); assertTrue(closed.attempted && closed.closedUnknown); assertNull(closed.proof)
        assertNull(a.store.read().operation); assertEquals(0, a.posts)
        // The Workshop's single saved slot accepts a new appearance request again.
        a.store.begin(a.store.read(), another(a.command))
    }

    @Test fun `closing a saved Awning is refused when its by-key read shows acceptance`() = runBlocking<Unit> {
        val a = Awning(); a.accepted = true
        rejects { a.repository.archive() }
        val kept = requireNotNull(a.store.read().operation); assertNotNull(kept.proof); assertFalse(kept.closedUnknown)
        assertTrue(a.store.read().archives.isEmpty()); assertEquals(0, a.posts)
    }

    @Test fun `only a same-key unknown reply can close an attempted original and older bytes still decode`() {
        val a = Awning(); val journal = a.store.read(); val before = requireNotNull(a.memory.value)
        assertFalse(before.contains("closedUnknown"))
        rejects { a.store.archive(journal) }; rejects { a.store.archive(journal, a.unknown(UUID.randomUUID().toString())) }
        rejects { a.store.archive(journal, original) }; assertEquals(journal, a.store.read())
        a.store.archive(journal, a.unknown()); assertTrue(requireNotNull(a.memory.value).contains("\"closedUnknown\":true"))
        assertEquals(a.store.read(), BoundCosmeticStore(MemoryStore(a.memory.value), a.store.identity).read())
    }

    @Test fun `a saved Aurora Wake the server does not know cannot block its Workshop forever`() = runBlocking<Unit> {
        val f = BoundCosmeticWakeWorkshopRepositoryTest().Fixture(); val review = f.review()
        f.onPost = { throw IOException("lost reply") }; rejects { f.repository.confirm(review) }; assertEquals(1, f.posts)
        val lost = requireNotNull(f.store.read().operation); assertTrue(lost.attempted); assertNull(lost.proof)
        f.allowed = false; rejects { f.repository.reviewSaved() }; rejects { f.store.begin(f.store.read(), another(lost.command)) }
        f.repository.archive()
        val closed = f.store.read().archives.single(); assertEquals(lost.command, closed.command); assertTrue(closed.closedUnknown); assertNull(closed.proof)
        assertEquals(1, f.posts); f.store.begin(f.store.read(), another(lost.command))
    }

    @Test fun `closing a saved Aurora Wake is refused when its by-key read shows acceptance`() = runBlocking<Unit> {
        val f = BoundCosmeticWakeWorkshopRepositoryTest().Fixture(); val review = f.review()
        f.onPost = { throw IOException("lost reply") }; rejects { f.repository.confirm(review) }
        f.accepted = true; rejects { f.repository.archive() }
        val kept = requireNotNull(f.store.read().operation); assertNotNull(kept.proof); assertFalse(kept.closedUnknown)
        assertTrue(f.store.read().archives.isEmpty()); assertEquals(1, f.posts)
    }
}
