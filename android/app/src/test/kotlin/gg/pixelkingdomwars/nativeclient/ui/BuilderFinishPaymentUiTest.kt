package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.kingdom.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class BuilderFinishPaymentUiTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private val jobId = "22222222-2222-4222-8222-222222222222"
    private val terms = BuilderJobSpeedupIntent(jobId, BASE_ID, "original-builder-key", GameCurrency.GEMS,
        BuilderJobSpeedupConsent("upgrade", "33333333-3333-4333-8333-333333333333", null,
            "2030-01-01T11:00:00.000Z", "2030-01-01T12:00:00.000Z", "37"))
    private fun model(repo: BaseRepository, observer: ReceiptObserver = ReceiptObserver(PendingIntentStore(MemoryStore())),
        account: MutableStateFlow<AccountState> = MutableStateFlow(AccountState(selectedBaseId = BASE_ID)),
        content: ContentRepository = FakeContentRepository(),
        interlock: MutableStateFlow<gg.pixelkingdomwars.nativeclient.network.RaidInterlockState>? = null) = KingdomViewModel(repo, content, observer,
        InterruptedActions({}, {}, {}), 1, wallet = WALLET, accountState = account, recoveryOnly = true, deedInterlock = interlock)

    @Test fun `paid job review never uses the legacy finish even with KEEP confirmation disabled`() = runTest {
        val legacy = FakeBaseRepository(); val calls = mutableListOf<String>()
        val repo = object : BaseRepository by legacy {
            override suspend fun reviewBuilderFinish(jobId: String) { calls += "review:$jobId" }
            override suspend fun reviewSavedBuilderFinish() { calls += "review-original" }
            override suspend fun confirmBuilderFinish() { calls += "confirm" }
        }
        val model = model(repo); model.setKeepConfirm(false)
        val job = BaseJob(jobId, "upgrade", finishCostKeep = "37")
        model.finishBuilderJob(job)?.join(); model.reviewSavedBuilderFinish()?.join(); model.confirmBuilderFinish()?.join()
        assertEquals(listOf("review:$jobId", "review-original", "confirm"), calls)
        model.finishJob(jobId)?.join(); assertTrue(legacy.calls.isEmpty()); assertNotNull(model.notice.value)
    }
    @Test fun `zero cost jobs keep direct finish while unknown and paid build prices cannot bypass review`() = runTest {
        val repo = FakeBaseRepository()
        repo._state.value = BaseState(base = BaseSnapshot.from(baseJson(BASE_ID, """[{"id":"$jobId","kind":"build","finishCostKeep":"0"}]""")))
        val model = model(repo); model.finishJob(jobId)?.join(); assertEquals(listOf("finish:$jobId"), repo.calls)
        for (kind in listOf("upgrade", "repair", "clear_obstacle")) {
            assertTrue(builderFinishCanReview(BaseJob(jobId, kind, finishCostKeep = "37")))
            assertFalse(builderFinishCanReview(BaseJob(jobId, kind)))
        }
        assertFalse(builderFinishCanReview(BaseJob(jobId, "build", finishCostKeep = "37")))
        assertFalse(builderFinishIsFree(BaseJob(jobId, "build")))
    }
    @Test fun `paused no-base entry resolves historical accepted proof by original wallet GET only`() = runTest {
        val holder = testHolder(); val session = signedIn(holder); val store = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(store)
        val original = ConstructionSpec.builderIntent(WALLET, terms).nextAttempt(); assertTrue(store.create(original))
        val foreign = original.copy(wallet = "11111111111111111111111111111111"); assertTrue(store.create(foreign))
        val api = FakeApiClient()
        api.onGet(BuilderJobSpeedup.RECEIPT) { query ->
            assertEquals(terms.query, query)
            buildJsonObject {
                put("version", 1); put("status", "accepted"); put("wallet", WALLET); put("request", terms.json)
                put("receiptId", jobId); put("acceptedAt", "2030-01-01T11:30:00.000Z")
                put("funding", json("""{"currency":"GEMS","amount":"36"}"""))
                put("result", buildJsonObject {
                    put("jobId", jobId); put("kind", terms.consent.kind); put("buildingId", terms.consent.buildingId)
                    put("obstacleId", JsonNull); put("completedAt", "2030-01-01T11:30:00.000Z")
                })
            }
        }
        val repo = LiveBaseRepository(session, holder, api, store, observer, { null }, builderActionsAllowed = { false })
        val model = model(repo, observer, MutableStateFlow(AccountState()), FakeContentRepository(minimumBuild = 99))
        assertTrue(api.gets.isEmpty()); model.refreshBuilderFinish()?.join()
        assertEquals(listOf(BuilderJobSpeedup.RECEIPT), api.gets.map { it.first }); assertTrue(api.posts.isEmpty())
        assertNull(store.get(IntentKind.CONSTRUCTION, WALLET)); assertEquals(foreign, store.get(IntentKind.CONSTRUCTION, foreign.wallet))
        assertNull(repo.state.value.base); model.refreshBuilderFinish()?.join(); assertEquals(1, api.gets.size)
    }
    @Test fun `ABA or permission change retires unsubmitted review while saved terms stay original`() = runTest {
        val legacy = FakeBaseRepository(); var dismissed = 0
        // The ABA / permission collectors now ask the repository to RETIRE (a screen close, deferred only under a payment in
        // flight; LiveBaseRepository tests cover that half). For an unsubmitted review it closes just like the player's dismiss.
        val repo = object : BaseRepository by legacy {
            override fun dismissBuilderFinishReview() { dismissed++ }
            override fun retireBuilderFinishReview() { dismissed++ }
        }
        val account = MutableStateFlow(AccountState(selectedBaseId = BASE_ID))
        val interlock = MutableStateFlow(gg.pixelkingdomwars.nativeclient.network.RaidInterlockState(null, known = true))
        val model = model(repo, account = account, interlock = interlock)
        val before = dismissed
        account.value = account.value.copy(selectedBaseId = jobId, baseSelectionGeneration = 1)
        account.value = account.value.copy(selectedBaseId = BASE_ID, baseSelectionGeneration = 2)
        assertTrue(dismissed >= before + 2); assertEquals(2L, model.state.value.baseGeneration)
        val original = ConstructionSpec.builderIntent(WALLET, terms)
        val ui = KingdomUiState(home = BaseState(builderFinishReview = ReviewedBuilderFinishSpend(original, 2, 1)),
            wallet = WALLET, selectedBaseId = BASE_ID, baseGeneration = 2)
        assertEquals(terms, builderFinishReviewTerms(ui)); assertNull(builderFinishReviewTerms(ui.copy(baseGeneration = 3)))
        assertNull(builderFinishReviewTerms(ui.copy(selectedBaseId = null))); assertNull(builderFinishReviewTerms(ui.copy(wallet = "other")))
        val beforePause = dismissed
        interlock.value = gg.pixelkingdomwars.nativeclient.network.RaidInterlockState(null, known = false)
        assertTrue(dismissed > beforePause); assertFalse(model.state.value.deedActionsAllowed)
        model.dismissBuilderFinishReview(); assertTrue(dismissed > beforePause + 1)
    }
    @Test fun `damaged modern markers cannot become legacy retry and cannot form payment consent`() {
        val original = ConstructionSpec.builderIntent(WALLET, terms)
        for (broken in listOf(original.copy(expectedCurrency = null), original.copy(quote = null), original.copy(body = JsonObject(emptyMap())))) {
            assertTrue(ConstructionSpec.modernBuilder(broken))
            val ui = KingdomUiState(home = BaseState(builderFinishReview = ReviewedBuilderFinishSpend(broken, 0, 0)), wallet = WALLET, selectedBaseId = BASE_ID)
            assertNull(builderFinishReviewTerms(ui))
        }
    }
    @Test fun `removed obstacle still has a selected running job without starting another clear`() {
        val repo = FakeBaseRepository(); val model = model(repo)
        model.selectJob(BaseJob(jobId, "clear_obstacle", obstacleId = terms.consent.buildingId, finishCostKeep = "37"))
        assertEquals(jobId, model.state.value.local.selectedJobId); assertTrue(repo.calls.isEmpty())
        model.clearSelection(); assertNull(model.state.value.local.selectedJobId)
    }
    @Test fun `live and no-base surfaces preserve payment isolation and GET-only foreground hooks`() {
        val root = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient")
        val screen = File(root, "ui/kingdom/KingdomScreen.kt").readText()
        assertTrue(screen.contains("!gg.pixelkingdomwars.nativeclient.ops.ConstructionSpec.modernBuilder(it.intent)"))
        assertTrue(screen.contains("Lifecycle.Event.ON_PAUSE")); assertTrue(screen.contains("model.refreshBuilderFinish()?.join()"))
        assertTrue(screen.contains("state.baseGeneration")); assertTrue(screen.contains("terms.consent.maxCostKeep"))
        val sheet = File(root, "ui/kingdom/BuildingSheet.kt").readText()
        assertFalse(sheet.contains("SheetConfirmation.KeepSpend(it, \"FINISH"))
        val nav = File(root, "ui/nav/PkwApp.kt").readText()
        assertTrue(nav.contains("composable<BuilderPaymentRoute>")); assertTrue(nav.contains("KingdomViewModel(graph, s, recoveryOnly = true)"))
        assertTrue(File(root, "ui/land/LandGateScreen.kt").readText().contains("CHECK BUILDER PAYMENT"))
    }
}
