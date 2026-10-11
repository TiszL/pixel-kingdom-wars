package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.army.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class ResearchPaymentUiTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private val terms = ResearchSpeedupIntent("highlander", BASE_ID, "original-research-key", GameCurrency.GEMS, 1, 2,
        "2030-01-01T12:00:00Z", null, "37")
    private fun model(army: ArmyRepository, observer: ReceiptObserver, selected: () -> String? = { BASE_ID }, content: ContentRepository = FakeContentRepository()) =
        ArmyViewModel(army, FakeBaseRepository(), content, observer, { WALLET }, selected, InterruptedActions({}, {}, {}), 1)

    @Test fun `review confirm dismissal and retry dispatch only their explicit repository actions`() = runTest {
        val legacy = FakeArmyRepository(); val calls = mutableListOf<String>()
        val army = object : ArmyRepository by legacy {
            override suspend fun reviewResearchFinish(troop: String) { calls += "review:$troop" }
            override suspend fun confirmResearchFinish() { calls += "confirm" }
            override suspend fun reviewResearchSaved() { calls += "review-original" }
            override fun dismissResearchReview() { calls += "dismiss" }
        }
        val model = model(army, ReceiptObserver(PendingIntentStore(MemoryStore())))
        model.reviewResearchFinish("highlander")?.join(); assertEquals(listOf("review:highlander"), calls)
        model.dismissResearchReview(); assertEquals(listOf("review:highlander", "dismiss"), calls)
        model.reviewResearchSaved()?.join(); model.confirmResearchFinish()?.join()
        assertEquals(listOf("review:highlander", "dismiss", "review-original", "confirm"), calls)
        model.submitResearch(json("""{"action":"finish","price":"37"}"""))?.join()
        assertTrue(legacy.calls.none { it.startsWith("research:") }); assertNotNull(model.notice.value)
        model.submitResearch(json("""{"action":"start"}"""))?.join(); model.submitResearch(json("""{"action":"cancel"}"""))?.join()
        assertEquals(listOf("research:\"start\"", "research:\"cancel\""), legacy.calls.filter { it.startsWith("research:") })
    }
    @Test fun `last base lost entry checks actual original receipt without catalogue or current army reads`() = runTest {
        val holder = testHolder(); val session = signedIn(holder); val store = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(store)
        val original = ResearchSpec.intent(WALLET, terms).nextAttempt(); assertTrue(store.create(original))
        val other = original.copy(wallet = "11111111111111111111111111111111"); assertTrue(store.create(other))
        val api = FakeApiClient()
        api.onGet(ResearchSpeedup.RECEIPT) { query ->
            assertEquals(terms.query, query)
            buildJsonObject {
                put("version", 1); put("status", "accepted"); put("wallet", WALLET); put("request", terms.json)
                put("receiptId", BASE_ID); put("acceptedAt", "2026-09-21T13:00:00Z")
                put("funding", buildJsonObject { put("currency", "GEMS"); put("amount", "36") })
                put("result", buildJsonObject { put("troop", "highlander"); put("fromLevel", 1); put("toLevel", 2) })
            }
        }
        val army = LiveArmyRepository(session, holder, api, store, observer, { null }, { null }, { BaseState() }, {}, heroActionsAllowed = { false })
        val model = model(army, observer, selected = { null }, content = FakeContentRepository(minimumBuild = 99))
        assertTrue("Entry cannot trigger a land redirect through /army", api.gets.isEmpty())
        assertNull(refreshResearchRecoveryEntry(observer, WALLET)); assertEquals(listOf(original), observer.interrupted.value.map { it.intent })
        model.refreshResearch()?.join()
        assertEquals(listOf(ResearchSpeedup.RECEIPT), api.gets.map { it.first }); assertTrue(api.posts.isEmpty())
        assertNull(store.get(IntentKind.RESEARCH, WALLET)); assertEquals(other, store.get(IntentKind.RESEARCH, other.wallet))
        assertNull(army.state.value.army); assertTrue(army.state.value.message!!.contains("Select a kingdom"))
        model.refreshResearch()?.join(); assertEquals(1, api.gets.size)
    }
    @Test fun `land recovery read reports corrupt unsupported and unavailable journals without replacing saved bytes`() = runTest {
        for (raw in listOf("broken-json", """{"schemaVersion":999,"intents":[]}""", null)) {
            var writes = 0
            val disk = object : SecretStore {
                override fun read(): String? = raw ?: throw java.io.IOException("storage unavailable")
                override fun write(value: String) { writes++ }
                override fun clear() { writes++ }
            }
            val observer = ReceiptObserver(PendingIntentStore(disk))
            assertNotNull("Unreadable data must leave an explicit recovery entry", refreshResearchRecoveryEntry(observer, WALLET))
            assertEquals(0, writes); assertTrue(observer.interrupted.value.isEmpty())
            if (raw != null) assertEquals(raw, disk.read())
        }
    }
    @Test fun `land recovery refresh preserves cancellation and successful wallet isolation`() = runTest {
        val cancelled = object : SecretStore {
            override fun read(): String? = throw CancellationException("land entry left")
            override fun write(value: String) { error("Must not write") }
            override fun clear() { error("Must not clear") }
        }
        try {
            refreshResearchRecoveryEntry(ReceiptObserver(PendingIntentStore(cancelled)), WALLET)
            fail("Leaving the route must cancel the journal read")
        } catch (_: CancellationException) { /* Navigation cancellation must not become a storage error. */ }
        val store = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(store)
        val other = ResearchSpec.intent("11111111111111111111111111111111", terms).nextAttempt()
        assertTrue(store.create(other))
        assertNull(refreshResearchRecoveryEntry(observer, WALLET)); assertTrue(observer.interrupted.value.isEmpty())
        assertEquals(other, store.get(other.kind, other.wallet))
    }
    @Test fun `current army display requires atomic base and generation provenance`() {
        val raw = ArmyState.from(json("""{"levels":{"highlander":2}}"""))
        val state = ArmyUiState(domain = ArmyDomainState(army = raw, armyBaseId = BASE_ID, armyBaseGeneration = 7), baseId = BASE_ID)
        assertSame(raw, researchCurrentArmy(state, 7))
        assertNull(researchCurrentArmy(state, 9)); assertNull(researchCurrentArmy(state.copy(baseId = "another-base"), 7))
        assertNull(researchCurrentArmy(state.copy(baseId = null), 7))
        assertNull(researchCurrentArmy(state.copy(domain = ArmyDomainState(army = raw)), 7))
    }
    @Test fun `dialog reads unchanged original terms and never mutable current research or preferred currency`() {
        val original = ResearchSpec.intent(WALLET, terms).nextAttempt()
        val ui = ArmyUiState(domain = ArmyDomainState(researchReview = ReviewedResearchSpend(original, 1, 2),
            army = ArmyState.from(json("""{"levels":{"highlander":8},"research":[]}"""))))
        assertEquals(terms, researchReviewTerms(ui)); assertEquals(GameCurrency.GEMS, researchReviewTerms(ui)?.expectedCurrency)
        assertNull(researchReviewTerms(ui.copy(domain = ui.domain.copy(researchReview = ReviewedResearchSpend(original.copy(expectedCurrency = "KEEP"), 1, 2)))))
        val missing = json("""{"features":{"researchSpeedupReceipts":{"version":2}}}""")
        assertFalse(researchFinishOffered(missing, json("""{"finishQuote":{}}""")))
        assertFalse(researchFinishOffered(json("""{"features":{"researchSpeedupReceipts":{"version":1}}}"""), json("""{"finishQuote":null}""")))
    }
    @Test fun `live research entry uses exact review lifecycle and reachable pending door without KEEP opt out`() {
        val root = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui")
        val screen = File(root, "army/ResearchScreen.kt").readText()
        assertFalse(screen.contains("researchSpeedupPrice")); assertFalse(screen.contains("KeepSpendConfirmDialog")); assertFalse(screen.contains("keepConfirm"))
        assertFalse(screen.contains("action(\"finish\"")); assertTrue(screen.contains("model.reviewResearchFinish(troop)"))
        assertTrue(screen.contains("Lifecycle.Event.ON_PAUSE")); assertTrue(screen.contains("repeatOnLifecycle(Lifecycle.State.RESUMED)"))
        assertTrue(screen.contains("model.refreshResearch()?.join()")); assertTrue(screen.contains("gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog"))
        val route = File(root, "nav/PkwApp.kt").readText()
        assertTrue(route.contains("it.intent.wallet == current.session.wallet")); assertTrue(route.contains("onResearchPayment = if (researchRecoveryError != null || pendingResearch.any"))
        assertTrue(route.contains("refreshResearchRecoveryEntry(current.observer, current.session.wallet)"))
        assertTrue(File(root, "land/LandGateScreen.kt").readText().contains("CHECK RESEARCH PAYMENT"))
    }
}
