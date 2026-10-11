package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.LiveBaseRepository
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * Owner 2026-10-06, his Seeker at 08:30 UTC: Home showed "Interrupted request · Build goldforge", RETRY CHECK answered "The
 * server has not confirmed this request. Check again later, or close it…", no CLOSE existed, and BUILD only toasted "check
 * the saved payment first" while its tray stayed shut. A saved request the server does not know blocked all building
 * forever. These cases drive the real construction owner (LiveBaseRepository + ReceiptObserver + MoneyOp) and the BUILD
 * door exactly as PkwApp / HomeScaffold mount it, so the way out cannot silently disappear again.
 */
class SavedConstructionCloseTest {
    private class Fixture {
        val api = FakeApiClient()
        val holder = testHolder()
        val session = signedIn(holder)
        val intents = PendingIntentStore(MemoryStore())
        val observer = ReceiptObserver(intents)
        var keys = 0
        val repository = LiveBaseRepository(session, holder, api, intents, observer, { BASE_ID }, newKey = { "key-${++keys}-0000" })
        init { api.onGet("/base") { baseJson() }; api.onGet("/balances") { balancesJson() }; api.onGet("/tutorial") { tutorialJson() } }
        /** What Home's Kingdom state derives from the owner (KingdomViewModel combines observer.interrupted the same way). */
        fun home() = KingdomUiState(interrupted = observer.interrupted.value)
        /** The BUILD tap as mounted: PkwApp's gates and reason, then HomeScaffold's dispatch with the recovery reveal. */
        fun tapBuild(): Pair<List<HomeRequest>, List<String>> {
            val state = home(); val requests = mutableListOf<HomeRequest>(); val toasts = mutableListOf<String>()
            val reason = homeBuildRefusalReason(savedConstruction = state.constructionBlocked, busy = false, baseLoaded = true,
                deedActionsAllowed = true, raidKnown = true, raidActive = false, ordersAllowed = true, savedClosable = state.constructionClosable)
            dispatchHomeBuildDoor(!state.constructionBlocked, false, reason, { requests += HomeRequest.BuildMenu }, { toasts += it },
                savedConstruction = state.constructionBlocked, showRecovery = { requests += HomeRequest.ShowRecovery })
            return requests to toasts
        }
    }
    private fun unknown(key: String) = buildJsonObject { put("version", 1); put("status", "unknown"); put("idempotencyKey", key) }
    private fun absent(key: String) = buildJsonObject { put("version", 1); put("status", "absent"); put("idempotencyKey", key) }

    // Rewritten 2026-10-06 (owner review M1/M2): these pinned CLOSE right after an `unknown` answer. The server's `unknown` is
    // "no matching evidence" and a lost POST can still commit while it runs, so CLOSE now needs the server's `absent` answer
    // for the exact key once the last attempt is SAVED_REQUEST_MIN_AGE_MS old, archives instead of deleting, and an
    // `unknown` answer of that age stops blocking BUILD instead (the request stays shown, the next order parks it).
    @Test fun `a saved request the server has no record of can be closed from the herald once it is old enough`() = runBlocking {
        val f = Fixture(); f.api.onPost("/base/buildings") { throw IOException("lost") }
        assertTrue(runCatching { f.repository.place("goldforge", 3, 4) }.isFailure)
        val saved = f.observer.interrupted.value.single().intent
        assertEquals("Build goldforge", saved.label)
        // Before the server has answered, BUILD keeps the recovery-first sentence, and brings the card into view.
        assertTrue(f.home().constructionBlocked); assertFalse(f.home().constructionClosable)
        assertEquals(listOf<HomeRequest>(HomeRequest.ShowRecovery) to listOf(SAVED_CONSTRUCTION_CHECK), f.tapBuild())
        // RETRY CHECK: one GET for the exact saved key; the server holds no record of it, but the POST may still be running.
        f.api.onGet(ConstructionSpec.RECEIPT) { query -> assertEquals("key-1-0000", query["idempotencyKey"]); absent("key-1-0000") }
        assertEquals(Receipt.Absent, f.observer.check(IntentKind.CONSTRUCTION, WALLET))
        assertTrue(f.home().constructionBlocked); assertFalse("no CLOSE before the minimum age", f.home().constructionClosable)
        f.intents.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS) // the last attempt is now older than the minimum age
        assertEquals(Receipt.Absent, f.observer.check(IntentKind.CONSTRUCTION, WALLET))
        val herald = f.observer.interrupted.value.single()
        assertTrue("RETRY CHECK and TRY AGAIN are kept", herald.retryable)
        assertTrue("the herald offers the CLOSE its sentence promises", herald.closable)
        assertTrue(f.home().constructionClosable); assertFalse("and BUILD is no longer blocked", f.home().constructionBlocked)
        assertEquals(listOf<HomeRequest>(HomeRequest.BuildMenu) to emptyList<String>(), f.tapBuild())
        // CLOSE: the herald's onClose is model.interrupted.close, i.e. the observer's close of this kind.
        assertTrue(f.observer.close(IntentKind.CONSTRUCTION, WALLET) is Receipt.Closed)
        assertNull(f.intents.get(IntentKind.CONSTRUCTION, WALLET))
        assertEquals("archived on this device, never deleted", listOf(KeptIntent(saved, closed = true)), f.intents.kept(WALLET))
        assertEquals("closing sent nothing; only the original POST exists", 1, f.api.posts.size)
    }

    @Test fun `BUILD opens once a check of the old enough request finds nothing and the next order parks it`() = runBlocking {
        val f = Fixture(); f.api.onPost("/base/buildings") { throw IOException("lost") }
        assertTrue(runCatching { f.repository.place("goldforge", 3, 4) }.isFailure)
        val saved = requireNotNull(f.intents.get(IntentKind.CONSTRUCTION, WALLET))
        f.api.onGet(ConstructionSpec.RECEIPT) { unknown("key-1-0000") }
        f.observer.check(IntentKind.CONSTRUCTION, WALLET)
        assertTrue("a fresh unknown keeps BUILD shut", f.home().constructionBlocked)
        f.intents.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS) // the last attempt is now older than the minimum age
        assertEquals(Receipt.Unknown, f.observer.check(IntentKind.CONSTRUCTION, WALLET))
        assertFalse(f.home().constructionBlocked); assertFalse("unknown is not absent: no CLOSE", f.home().constructionClosable)
        assertEquals(saved, f.observer.interrupted.value.single().intent)
        assertEquals("BUILD opens its tray with no toast and no reveal", listOf<HomeRequest>(HomeRequest.BuildMenu) to emptyList<String>(), f.tapBuild())
        // The owner admits a fresh order again (a new key); the saved request is parked on this device, never resent.
        f.api.onPost("/base/buildings") { json("""{"building":{"id":"new"}}""") }
        f.repository.place("mine", 3, 4)
        assertEquals(2, f.api.posts.size); assertEquals(JsonPrimitive("key-2-0000"), f.api.posts.last().second["idempotencyKey"])
        assertNull(f.intents.get(IntentKind.CONSTRUCTION, WALLET))
        assertEquals(listOf(saved), f.intents.parked(WALLET))
    }

    @Test fun `a never sent request blocks BUILD and BUILD names its CLOSE`() = runBlocking {
        // The attempted flag is durable before any byte leaves: a request saved but never sent (a crash in between) can be
        // closed at once. Until then it blocks BUILD, whose hint names that CLOSE.
        val f = Fixture()
        val unsent = PendingIntent(IntentKind.CONSTRUCTION, WALLET, BASE_ID, "key-9-0000", ConstructionSpec.PLACE,
            buildJsonObject { put("baseId", BASE_ID); put("type", "goldforge"); put("tx", 3); put("ty", 4); put("idempotencyKey", "key-9-0000") }, "Build goldforge")
        assertTrue(f.intents.create(unsent)); f.observer.refresh(WALLET)
        assertTrue(f.home().constructionBlocked); assertTrue(f.home().constructionClosable)
        assertEquals(listOf<HomeRequest>(HomeRequest.ShowRecovery) to listOf(SAVED_CONSTRUCTION_CLOSABLE), f.tapBuild())
        f.api.onGet(ConstructionSpec.RECEIPT) { unknown("key-9-0000") }
        assertTrue(f.observer.close(IntentKind.CONSTRUCTION, WALLET) is Receipt.Closed)
        assertNull(f.intents.get(IntentKind.CONSTRUCTION, WALLET)); assertTrue(f.api.posts.isEmpty())
        assertEquals(listOf<HomeRequest>(HomeRequest.BuildMenu) to emptyList<String>(), f.tapBuild())
    }

    @Test fun `the production mount wires CLOSE the reveal and the BUILD hint to the same owner`() {
        // The pure cases above are only worth something if Home actually calls them this way.
        fun source(path: String) = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()
        val herald = source("ui/Theme.kt").substringAfter("@Composable private fun InterruptedHerald(").substringBefore("/** A once-per-second wall clock")
        assertTrue(herald.contains("if (item.closable) SecondaryButton(Copy.CLOSE_REQUEST.uppercase(), { onClose(item.kind) }, Modifier.fillMaxWidth()"))
        assertTrue(herald.contains("if (item.retryable) SecondaryButton(Copy.RETRY_SAME.uppercase(), { onRetry(item.kind) }"))
        assertTrue(herald.contains("LaunchedEffect(reveal) { if (reveal > 0) folded = false }"))
        val screen = source("ui/kingdom/KingdomScreen.kt")
        assertTrue(screen.contains("model.interrupted.check, model.interrupted.close, model.interrupted.retry, reveal = recoveryReveal)"))
        assertTrue(screen.contains("HomeRequest.ShowRecovery -> {"))
        assertTrue("the reveal is always consumed so it never holds the request queue",
            screen.substringAfter("HomeRequest.ShowRecovery -> {").substringBefore("is HomeRequest.BaseTool").contains("requests.consume(r)"))
        assertTrue(source("ui/home/HomeScaffold.kt").contains("savedConstruction = buildSavedConstruction, showRecovery = { requests.request(HomeRequest.ShowRecovery) })"))
        val app = source("ui/nav/PkwApp.kt")
        assertTrue(app.contains("savedClosable = kingdomAudio.constructionClosable)"))
        assertTrue(app.contains("buildSavedConstruction = kingdomAudio.constructionBlocked,"))
        assertEquals(HomeTab.KINGDOM, HomeRequest.ShowRecovery.homeTab)
    }
}
