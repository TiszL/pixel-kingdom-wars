package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.LiveBaseRepository
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.InterruptedActions
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomViewModel
import java.io.File
import java.io.IOException
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.job
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Owner field result 2026-10-06 (Seeker, build 607a9c37 = night/android 33db92ff with 745c21e9): the saved "Build goldforge"
 * request was checked (one GET /base/buildings/receipt, 200, `status: "unknown"` for the same key), the herald printed the
 * server's answer, yet no CLOSE was visible, and after a restart the answer was gone again. Root cause: the CLOSE row was
 * composed but sat below the Home status column's height cap (KingdomScreen `heightIn(max = chromeLimit).verticalScroll`)
 * under two four-line sentences; and the answer lived only in memory. This replays that exact sequence through the real
 * owners: LiveBaseRepository → MoneyOp.observe → ReceiptObserver → KingdomViewModel state → the herald's closable rule.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SavedConstructionFieldResultTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    // night/android 913967ff cycle: when an assertion here failed mid-sequence, the Home models were left mid-read; their
    // work came back after resetMain on the real (absent) Main dispatcher and threw outside any test, which kotlinx-coroutines
    // -test then reported in the next runTest (MiningClaimsUiTest: UncaughtExceptionsBeforeTest). Every model this class
    // creates is cancelled and joined on the test Main before it is reset, whatever the test's outcome.
    private val models = mutableListOf<KingdomViewModel>()
    @After fun reset() {
        try { runBlocking { kotlinx.coroutines.withTimeoutOrNull(5_000) { models.forEach { model ->
            val job = model.viewModelScope.coroutineContext.job; job.cancelChildren(); job.children.forEach { it.join() } } } } }
        finally { Dispatchers.resetMain() }
    }
    private fun file(path: String) = Json.parseToJsonElement(File(path).readText()).jsonObject
    private val catalogue = file("src/main/assets/native/catalogue.json")
    private val render = file("src/main/assets/native/render-catalog.json")
    private val key = "fe158ad1-257c-44ab-a3d6-9863c90b1686"

    /** One process: its own journal reader over the shared [disk], its own observer, repository and Home model. */
    private inner class Process(disk: MemoryStore, status: String = "unknown") {
        val api = FakeApiClient()
        val holder = testHolder(); val session = signedIn(holder)
        val intents = PendingIntentStore(disk); val observer = ReceiptObserver(intents)
        val repository = LiveBaseRepository(session, holder, api, intents, observer, { BASE_ID }, newKey = { key })
        init {
            api.onGet("/base") { baseJson() }; api.onGet("/balances") { balancesJson() }; api.onGet("/tutorial") { tutorialJson() }
            // apps/api constructionReceipt.ts: every non-matching case answers exactly this, for the key it was asked about
            // (`unknown`; a server that proves it holds no ledger row for the key answers `absent` the same way).
            api.onGet(ConstructionSpec.RECEIPT) { query -> buildJsonObject { put("version", 1); put("status", status); put("idempotencyKey", query.getValue("idempotencyKey")) } }
        }
        val model = KingdomViewModel(repository, FakeContentRepository(catalogue, render), observer, InterruptedActions({}, {}, {}), versionCode = 1, wallet = WALLET)
            .also(models::add)
        suspend fun herald() = withTimeout(5_000) { model.state.first { state -> state.interrupted.any { it.kind == IntentKind.CONSTRUCTION } } }
            .interrupted.single { it.kind == IntentKind.CONSTRUCTION }
    }

    // Rewritten 2026-10-06 (owner review M1/M2): this pinned CLOSE at once on that `unknown` answer. `unknown` is "no matching
    // evidence" and the lost POST may still be running, so: `unknown` never offers CLOSE but, once the last attempt is
    // SAVED_REQUEST_MIN_AGE_MS old, frees BUILD (the request stays shown with RETRY CHECK); `absent` offers CLOSE at that age.
    // Both answers are persisted with the request, so neither is lost by a restart (the field result's second half).
    @Test fun `an unknown answer for the saved goldforge frees BUILD once old enough and again after a restart`() = runBlocking {
        val disk = MemoryStore()
        val first = Process(disk)
        first.api.onPost("/base/buildings") { throw IOException("reply lost") }
        assertTrue(runCatching { first.repository.place("goldforge", 12, 18) }.isFailure)
        val saved = first.herald().intent
        assertEquals("Build goldforge", saved.label)
        assertFalse("nothing is offered before the server answered", first.herald().closable)
        // RETRY CHECK: the herald's onCheck is the observer's check of this kind (ScreenViewModel.interruptedActions).
        assertEquals(Receipt.Unknown, first.observer.check(IntentKind.CONSTRUCTION, WALLET))
        val checked = first.api.gets.single { it.first == ConstructionSpec.RECEIPT }.second
        assertEquals(mapOf("type" to "goldforge", "tx" to "12", "ty" to "18", "baseId" to BASE_ID, "idempotencyKey" to key), checked)
        assertTrue("a fresh answer keeps BUILD shut", first.herald().blocking); assertFalse(first.herald().closable)
        first.intents.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS) // the last attempt is now older than the minimum age
        assertEquals(Receipt.Unknown, first.observer.check(IntentKind.CONSTRUCTION, WALLET))
        val freed = withTimeout(5_000) { first.model.state.first { s -> !s.constructionBlocked && s.interrupted.any { it.kind == IntentKind.CONSTRUCTION } } }
        assertFalse("unknown is not absent: never CLOSE", freed.constructionClosable)
        // Process restart: a new journal reader, observer, repository and Home model over the same disk. The answer was
        // persisted with the request, so BUILD stays free and the herald still prints it, with no tap.
        val second = Process(disk)
        second.observer.refresh(WALLET) // the account scope publishes the saved journal at sign-in
        val restored = second.herald()
        assertEquals(saved, restored.intent); assertEquals(Receipt.Unknown, restored.lastObservation)
        assertFalse(restored.blocking); assertFalse(restored.closable); assertTrue("RETRY CHECK stays offered", restored.retryable)
        assertNotNull(second.intents.get(IntentKind.CONSTRUCTION, WALLET)); assertTrue(second.api.posts.isEmpty())
        assertEquals(1, first.api.posts.size)
    }

    @Test fun `an absent answer for the saved goldforge offers CLOSE once old enough and again after a restart`() = runBlocking {
        val disk = MemoryStore()
        val first = Process(disk, status = "absent")
        first.api.onPost("/base/buildings") { throw IOException("reply lost") }
        assertTrue(runCatching { first.repository.place("goldforge", 12, 18) }.isFailure)
        val saved = first.herald().intent
        assertEquals(Receipt.Absent, first.observer.check(IntentKind.CONSTRUCTION, WALLET))
        assertFalse("no CLOSE before the minimum age", first.herald().closable)
        first.intents.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS) // the last attempt is now older than the minimum age
        assertEquals(Receipt.Absent, first.observer.check(IntentKind.CONSTRUCTION, WALLET))
        val answered = withTimeout(5_000) { first.model.state.first { s -> s.interrupted.any { it.kind == IntentKind.CONSTRUCTION && it.closable } } }
        assertTrue("CLOSE right after the answer", answered.constructionClosable)
        // Process restart: the persisted answer offers CLOSE at once; the Home resume (KingdomScreen →
        // refreshConstructionReceipts) reads the saved request again and keeps it.
        val second = Process(disk, status = "absent")
        second.observer.refresh(WALLET)
        assertTrue("the answer survives a restart", second.herald().closable)
        withTimeout(5_000) { second.model.busy.first { !it } } // KingdomScreen waits the same way before its resume read
        requireNotNull(second.model.refreshConstructionReceipts()) { "the resume read was dropped" }.join()
        val restored = withTimeout(5_000) { second.model.state.first { s -> s.interrupted.any { it.kind == IntentKind.CONSTRUCTION && it.closable } } }
        assertTrue(restored.constructionClosable)
        // CLOSE: one more GET, then the saved request is archived and BUILD is free; nothing was ever POSTed after the original.
        assertTrue(second.observer.close(IntentKind.CONSTRUCTION, WALLET) is Receipt.Closed)
        withTimeout(5_000) { second.model.state.first { !it.constructionBlocked } }
        assertNull(second.intents.get(IntentKind.CONSTRUCTION, WALLET)); assertTrue(second.api.posts.isEmpty())
        assertEquals("archived on this device, never deleted", listOf(KeptIntent(saved, closed = true)), second.intents.kept(WALLET))
        assertEquals(1, first.api.posts.size)
    }

    @Test fun `a saved goldforge written by an older build frees BUILD at the first Home resume check`() = runBlocking {
        // Owner field result 2026-10-06 (Seeker build 880a7e7a, QA answering `unknown`): the request was sent hours earlier by
        // an older build, so its journal has the intent and no timing facts. The resume check answered and the herald printed
        // "The server has not confirmed this request.", yet BUILD still toasted: the first answer stamped the send as "now".
        // A request an older build sent counts as sent before this build, so that first answer frees BUILD (the card stays
        // with RETRY CHECK).
        val original = PendingIntent(IntentKind.CONSTRUCTION, WALLET, BASE_ID, key, ConstructionSpec.PLACE,
            buildJsonObject { put("baseId", BASE_ID); put("type", "goldforge"); put("tx", 12); put("ty", 18); put("idempotencyKey", key) },
            "Build goldforge", attempted = true, attemptRevision = 1)
        val disk = MemoryStore(buildJsonObject {
            put("schemaVersion", PendingIntentStore.SCHEMA_VERSION); put("intents", buildJsonArray { add(Json.encodeToJsonElement(original)) })
        }.toString())
        val app = Process(disk)
        app.observer.refresh(WALLET) // the account scope publishes the saved journal at sign-in
        assertTrue("before the resume check it blocks BUILD", app.herald().blocking)
        withTimeout(5_000) { app.model.busy.first { !it } }
        requireNotNull(app.model.refreshConstructionReceipts()) { "the resume read was dropped" }.join()
        val freed = withTimeout(5_000) { app.model.state.first { s -> !s.constructionBlocked && s.interrupted.any { it.kind == IntentKind.CONSTRUCTION } } }
        val herald = freed.interrupted.single { it.kind == IntentKind.CONSTRUCTION }
        assertEquals(original, herald.intent); assertEquals(Receipt.Unknown, herald.lastObservation)
        // Rewritten the same day (owner: "get me rid of interrupted request build goldforge"): an older build's send counts as
        // long ago, so its settled `unknown` is a day-old one: CLOSE archives it (re-read on every resume).
        assertTrue("its CLOSE is offered", freed.constructionClosable); assertTrue("RETRY CHECK stays", herald.retryable)
        assertEquals("the answer time is recorded for the legacy record", SavedRequestFacts.UNKNOWN, app.intents.facts(original).answer)
        assertNull("its send time is never invented", app.intents.facts(original).attemptedAtMs)
        assertTrue(app.api.posts.isEmpty())
    }

    @Test fun `a kept unknown request never disables MOVE UPGRADE or BUILD`() = runBlocking {
        // Owner 2026-10-06, build 05a72df2: "why the fuck I am not able to move the buildings?" and "get me rid of interrupted
        // request build goldforge". Every construction door (BUILD tray, MOVE / carry, UPGRADE, the placement ghost) reads the
        // one flag KingdomUiState.constructionBlocked; a kept request (parked by a newer order) never sets it, and its CLOSE
        // archives it on this device without touching anything else.
        val older = "0aa5c2e1-6f3b-4c0e-9d5f-1b2c3d4e5f60"
        val original = PendingIntent(IntentKind.CONSTRUCTION, WALLET, BASE_ID, older, ConstructionSpec.PLACE,
            buildJsonObject { put("baseId", BASE_ID); put("type", "goldforge"); put("tx", 12); put("ty", 18); put("idempotencyKey", older) },
            "Build goldforge", attempted = true, attemptRevision = 1)
        val disk = MemoryStore(buildJsonObject {
            put("schemaVersion", PendingIntentStore.SCHEMA_VERSION); put("intents", buildJsonArray { add(Json.encodeToJsonElement(original)) })
        }.toString())
        val app = Process(disk)
        app.observer.refresh(WALLET)
        withTimeout(5_000) { app.model.busy.first { !it } }
        requireNotNull(app.model.refreshConstructionReceipts()) { "the resume read was dropped" }.join()
        // A new BUILD is admitted and parks the old request (kept on this device, never resent).
        app.api.onPost("/base/buildings") { json("""{"building":{"id":"new"}}""") }
        app.repository.place("mine", 3, 4)
        assertEquals(listOf(original), app.intents.parked(WALLET)); assertNull(app.intents.get(IntentKind.CONSTRUCTION, WALLET))
        // Rewritten at the night/android merge (913967ff): the move lane's owner rule (field result 2026-10-06) took the saved
        // construction out of carryMode, so "carry offered" no longer implied the parked request had been published, and this
        // wait returned the state from before BUILD (the original still active). It now waits for the kept request itself;
        // a kept request that disabled MOVE would still time out here, and every assertion below is unchanged.
        val home = withTimeout(5_000) { app.model.state.first { s -> s.base != null && s.carryMode != null &&
            s.interrupted.any { it.kind == IntentKind.CONSTRUCTION && it.kept } } }
        assertFalse("BUILD, MOVE and UPGRADE read this flag", home.constructionBlocked)
        assertNotNull("MOVE: the carry mode is offered", home.carryMode)
        assertNull("BUILD opens its tray", homeBuildRefusalReason(savedConstruction = home.constructionBlocked, busy = false, baseLoaded = true,
            deedActionsAllowed = true, raidKnown = true, raidActive = false, ordersAllowed = true, savedClosable = home.constructionClosable))
        val kept = home.interrupted.single { it.kind == IntentKind.CONSTRUCTION }
        assertTrue(kept.kept); assertFalse(kept.blocking); assertTrue("it can be got rid of", kept.closable)
        assertTrue(app.observer.close(IntentKind.CONSTRUCTION, WALLET) is Receipt.Closed)
        withTimeout(5_000) { app.model.state.first { s -> s.interrupted.none { it.kind == IntentKind.CONSTRUCTION } } }
        assertEquals("archived, still re-read on every resume", listOf(KeptIntent(original, closed = true)), app.intents.kept(WALLET))
        assertEquals("only the new order was posted", 1, app.api.posts.size)
    }

    @Test fun `the herald shows CLOSE in view and its sentences fit without an ellipsis`() {
        // The answer replaces the long "interrupted" sentence, every line wraps fully, and the action rows (CLOSE included)
        // are scrolled into view inside Home's height-capped status column whenever CLOSE appears or BUILD reveals the line.
        val herald = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/Theme.kt").readText()
            .substringAfter("@Composable private fun InterruptedHerald(").substringBefore("/** Herald sentences wrap fully")
        assertTrue(herald.contains("LaunchedEffect(item.closable, reveal) { if (item.closable || reveal > 0) actionsLocation.bringIntoView() }"))
        assertTrue(herald.contains("Column(Modifier.fillMaxWidth().bringIntoViewRequester(actionsLocation)"))
        assertTrue(herald.indexOf("bringIntoViewRequester(actionsLocation)") < herald.indexOf("if (item.closable) SecondaryButton(Copy.CLOSE_REQUEST"))
        assertTrue(herald.contains("answer != null -> answer"))
        assertFalse("no four-line cap on a herald sentence", herald.contains("maxLines = 4"))
        // A toast shows two lines (kit Toast maxLines = 2): every recovery sentence fits about 64 characters.
        for (line in listOfNotNull(Copy.observation(Receipt.Unknown), Copy.observation(Receipt.Absent), Copy.observation(Receipt.Unsupported), Copy.observation(Receipt.Closed("now")),
                SAVED_CONSTRUCTION_CHECK, SAVED_CONSTRUCTION_CLOSABLE))
            assertTrue("fits two toast lines: $line", line.length <= 64)
    }
}
