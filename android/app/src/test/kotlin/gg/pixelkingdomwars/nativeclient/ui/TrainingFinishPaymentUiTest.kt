package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
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
class TrainingFinishPaymentUiTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private val terms = PaidTrainingFinishIntent(BASE_ID, "original-training-key", GameCurrency.GEMS,
        listOf(QueueConsentRow("22222222-2222-4222-8222-222222222222", "2030-01-01T11:00:00.000Z", "2030-01-01T12:00:00.000Z"),
            QueueConsentRow("33333333-3333-4333-8333-333333333333", "2030-01-01T12:00:00.000Z", "2030-01-01T13:00:00.000Z")), "37")
    private fun model(army: ArmyRepository, observer: ReceiptObserver, selected: () -> String? = { BASE_ID }, content: ContentRepository = FakeContentRepository()) =
        ArmyViewModel(army, FakeBaseRepository(), content, observer, { WALLET }, selected, InterruptedActions({}, {}, {}), 1)

    @Test fun `paid review confirm and saved review cannot fall through the free compatibility entry`() = runTest {
        val legacy = FakeArmyRepository(); val calls = mutableListOf<String>()
        val army = object : ArmyRepository by legacy {
            override suspend fun reviewTrainingFinish() { calls += "review" }
            override suspend fun confirmTrainingFinish() { calls += "confirm" }
            override suspend fun reviewTrainingFinishSaved() { calls += "review-original" }
            override fun dismissTrainingFinishReview() { calls += "dismiss" }
        }
        val model = model(army, ReceiptObserver(PendingIntentStore(MemoryStore())))
        model.reviewTrainingFinish()?.join(); assertEquals(listOf("review"), calls)
        model.dismissTrainingFinishReview(); model.reviewTrainingFinishSaved()?.join(); model.confirmTrainingFinish()?.join()
        assertEquals(listOf("review", "dismiss", "review-original", "confirm"), calls)
        model.finishAll(free = false, displayedCostKeep = "37")?.join()
        assertTrue(legacy.calls.none { it.startsWith("finishAll:") }); assertNotNull(model.notice.value)
        model.finishAll(free = true)?.join(); assertEquals("finishAll:true", legacy.calls.last())
    }
    @Test fun `paused last-base recovery observes the exact original payment without catalogue or any POST`() = runTest {
        val holder = testHolder(); val session = signedIn(holder); val store = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(store)
        val original = TrainingFinishSpec.intent(WALLET, terms).nextAttempt(); assertTrue(store.create(original))
        val other = original.copy(wallet = "11111111111111111111111111111111"); assertTrue(store.create(other))
        val api = FakeApiClient()
        api.onGet(TrainingFinish.RECEIPT) { query ->
            assertEquals(terms.query, query)
            buildJsonObject {
                put("version", 1); put("status", "accepted"); put("wallet", WALLET); put("request", terms.json)
                put("receiptId", BASE_ID); put("acceptedAt", "2026-09-23T18:00:00.000Z")
                put("funding", buildJsonObject { put("currency", "GEMS"); put("amount", "36") })
                put("result", buildJsonObject {
                    put("completedAt", "2026-09-23T18:00:00.000Z")
                    put("paidRows", JsonArray(terms.queue.map { row -> buildJsonObject {
                        put("id", row.id); put("startedAt", row.startedAt); put("finishesAt", row.finishesAt); put("troop", "highlander")
                    } }))
                    put("completed", buildJsonArray { add(buildJsonObject { put("troop", "highlander"); put("count", terms.queue.size) }) })
                })
            }
        }
        val army = LiveArmyRepository(session, holder, api, store, observer, { null }, { null }, { BaseState() }, {}, heroActionsAllowed = { false })
        val model = model(army, observer, selected = { null }, content = FakeContentRepository(minimumBuild = 99))
        assertTrue(api.gets.isEmpty())
        model.refreshTrainingFinish()?.join()
        assertEquals(listOf(TrainingFinish.RECEIPT), api.gets.map { it.first }); assertTrue(api.posts.isEmpty())
        assertNull(store.get(IntentKind.TRAINING_FINISH, WALLET)); assertEquals(other, store.get(IntentKind.TRAINING_FINISH, other.wallet))
        assertNull(army.state.value.army); assertTrue(army.state.value.message!!.contains("Select a kingdom"))
        model.refreshTrainingFinish()?.join(); assertEquals(1, api.gets.size)
    }
    @Test fun `original whole queue and currency survive changed current army and stripped markers fail closed`() {
        val original = TrainingFinishSpec.intent(WALLET, terms).nextAttempt()
        val ui = ArmyUiState(domain = ArmyDomainState(trainingFinishReview = ReviewedTrainingFinishSpend(original, 7, 2),
            army = ArmyState.from(json("""{"queue":[],"finishAllQuote":{"version":1,"maxCostKeep":"1"}}"""))))
        assertEquals(terms, trainingFinishReviewTerms(ui)); assertEquals(2, trainingFinishReviewTerms(ui)!!.queue.size)
        assertFalse(ui.composerEnabled)
        val stripped = original.copy(expectedCurrency = null)
        assertTrue(modernTrainingFinish(stripped))
        assertNull(trainingFinishReviewTerms(ui.copy(domain = ui.domain.copy(trainingFinishReview = ReviewedTrainingFinishSpend(stripped, 7, 2)))))
        val legacy = original.copy(expectedCurrency = null, quote = null)
        assertFalse(modernTrainingFinish(legacy))
    }
    @Test fun `paid entry requires explicit compatible quote and resolved free eligibility`() {
        val offered = json("""{"features":{"trainingFinishReceipts":{"version":1}},"finishAllQuote":{},"freeFinishAllOffer":null,"freeFinishAllReviewRequired":false}""")
        assertTrue(trainingFinishOffered(offered))
        for (change in listOf("freeFinishAllOffer" to JsonObject(emptyMap()), "freeFinishAllReviewRequired" to JsonPrimitive(true),
            "freeFinishAllReviewRequired" to JsonNull, "finishAllQuote" to JsonNull,
            "features" to json("""{"trainingFinishReceipts":{"version":2}}""")))
            assertFalse(trainingFinishOffered(JsonObject(offered + change)))
        assertFalse(trainingFinishOffered(JsonObject(offered - "freeFinishAllOffer")))
    }
    @Test fun `current training display cannot reuse another base or selection generation`() {
        val raw = ArmyState.from(json("{}"))
        val ui = ArmyUiState(domain = ArmyDomainState(army = raw, armyBaseId = BASE_ID, armyBaseGeneration = 7), baseId = BASE_ID)
        assertSame(raw, trainingCurrentArmy(ui, 7)); assertNull(trainingCurrentArmy(ui, 9))
        assertNull(trainingCurrentArmy(ui.copy(baseId = "another-base"), 7)); assertNull(trainingCurrentArmy(ui.copy(baseId = null), 7))
        assertNull(trainingCurrentArmy(ui.copy(domain = ArmyDomainState(army = raw)), 7))
    }
    @Test fun `live entry and last-base door preserve explicit consent and GET-only lifecycle recovery`() {
        val root = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui")
        val screen = File(root, "army/ArmyScreen.kt").readText()
        assertFalse(screen.contains("rememberKeepSpendConfirm")); assertFalse(screen.contains("KeepSpendConfirmDialog"))
        assertFalse(screen.contains("model.finishAll(free = false")); assertTrue(screen.contains("model.reviewTrainingFinish()"))
        assertTrue(screen.contains("Lifecycle.Event.ON_PAUSE")); assertTrue(screen.contains("repeatOnLifecycle(Lifecycle.State.RESUMED)"))
        assertTrue(screen.contains("model.refreshTrainingFinish()?.join()"))
        // Rewritten 2026-10-06 (owner 17:24, "a black developer interface"): this pinned the KEEP dialog's per-row ISO list. The
        // dialog still describes the whole reviewed queue, now in the Seal's player words (count + last finish, mapper-tested).
        assertTrue(screen.contains("trainingFinishConsentLines(terms, reviewed.intent.attempted, state.home.base,"))
        assertTrue(screen.indexOf("TrainingFinishPending(state") < screen.indexOf("if (army == null)"))
        assertTrue(screen.contains("val otherDialog = !recoveryOnly &&"))
        val unrelatedDialogs = screen.substring(screen.indexOf("    if (!recoveryOnly) {\n        state.domain.reviewed"), screen.indexOf("    TrainingFinishCurrencyConfirm(state"))
        assertTrue(unrelatedDialogs.contains("ReviewTrainingDialog")); assertTrue(unrelatedDialogs.contains("PresetEditorDialog"))
        val route = File(root, "nav/PkwApp.kt").readText()
        assertTrue(route.contains("composable<TrainingPaymentRoute>")); assertTrue(route.contains("recoveryOnly = true"))
        assertTrue(route.contains("IntentKind.TRAINING_FINISH && it.intent.wallet == current.session.wallet"))
        assertTrue(route.contains("onTrainingPayment = if (researchRecoveryError != null"))
        assertTrue(File(root, "land/LandGateScreen.kt").readText().contains("CHECK TRAINING PAYMENT"))
    }
}
