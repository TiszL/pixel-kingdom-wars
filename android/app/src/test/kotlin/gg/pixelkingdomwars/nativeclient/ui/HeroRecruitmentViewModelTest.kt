package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.HeroAltarDefinition
import gg.pixelkingdomwars.nativeclient.network.buildingPrice
import gg.pixelkingdomwars.nativeclient.ui.home.*
import gg.pixelkingdomwars.nativeclient.ui.kingdom.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class HeroRecruitmentViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private fun model(f: HeroRecruitmentFixture, base: FakeBaseRepository = FakeBaseRepository()) =
        KingdomViewModel(base, FakeContentRepository(f.catalogue), f.observer, InterruptedActions({}, {}, {}), 1,
            wallet = WALLET, heroRecruitment = f.repo)
    private suspend fun TestScope.review(model: KingdomViewModel, f: HeroRecruitmentFixture) {
        runCurrent()
        model.startPlacement("heroaltar"); model.pickTile(10f, 11f)
        runCurrent(); model.reviewHeroPlacement()
        f.repo.state.first { it.review != null && !it.busy }; model.busy.first { !it }
    }
    @Test fun `Inventory and roster hero requests reach the Heroes category without consuming or placing anything`() = runTest {
        val f = HeroRecruitmentFixture(); val model = model(f); val requests = HomeRequests()
        requests.request(HomeRequest.HeroBuildMenu); assertEquals(HomeTab.KINGDOM, requests.pending.value!!.homeTab)
        requests.consume(HomeRequest.Tab(HomeTab.KINGDOM)); assertEquals(HomeRequest.HeroBuildMenu, requests.pending.value)
        model.openBuildMenu(true); requests.consume(HomeRequest.HeroBuildMenu)
        assertTrue(model.state.value.local.heroesOnly); assertTrue(model.state.value.buildMenu); assertTrue(f.posts.isEmpty())
        model.openBuildMenu(); assertFalse(model.state.value.local.heroesOnly)
    }
    @Test fun `tile selection and review cannot reach ordinary construction and Back cannot buy a hero`() = runTest {
        val f = HeroRecruitmentFixture(); val base = FakeBaseRepository(); val model = model(f, base)
        review(model, f); val original = f.repo.state.value.review!!
        model.dismissHeroReview(); model.confirmHeroPlacement(original)?.join()
        assertNull(f.repo.state.value.review); assertTrue(f.posts.isEmpty()); assertNull(f.saved())
        assertTrue(base.calls.none { it.startsWith("place:") }); assertNotNull(model.notice.value)
    }
    @Test fun `explicit confirmation clears placement only after accepted recruitment and hydration`() = runTest {
        // Model callbacks and simulated user actions share one queue, as they do on Android's main thread.
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val f = HeroRecruitmentFixture(); val model = model(f); review(model, f)
        assertNotNull(model.state.value.placement)
        // Subscribe before durable IO; a virtual-time deadline can outrun the separately collected UI update.
        val cleared = async(start = CoroutineStart.UNDISPATCHED) { model.state.first { it.placement == null } }
        model.confirmHeroPlacement(f.repo.state.value.review!!)?.join()
        assertNull(model.notice.value)
        assertEquals(1, f.posts.size); assertNotNull(f.repo.state.value.receipt); assertNull(f.saved())
        assertNull(cleared.await().placement)
        assertNull(model.state.value.placement)
    }
    // Owner Seeker 2026-10-06 16:45: "The altar review closed. Check the original saved request." after CONFIRM PLACEMENT.
    // The confirm hides the review before its POST, but the placement draft is cleared only when the confirm returns, so for
    // the whole send + hydration (~8 s on QA, K-night-07) Home redrew the tile dialog (CHOOSE ANOTHER TILE, scrim = BACK) and
    // the placement band exactly where the review was; a tap there is clearTile/cancelPlacement -> dismiss(), which fenced
    // the accepted request. The consumed review must keep holding those surfaces until the confirm is over.
    @Test fun `a confirmed altar keeps the placement dialog and band undrawn until its request is sent and hydrated`() = runTest {
        val f = HeroRecruitmentFixture(); val model = model(f); review(model, f)
        val reviewed = f.repo.state.value; val placement = model.state.value.local.placement
        assertTrue(heroReviewHeld(reviewed)); assertFalse(legacyPlacementDialogVisible(placement, true, heroReviewHeld(reviewed), false))
        val held = mutableListOf<Boolean>(); val send = f.postHandler
        f.postHandler = { path, body -> f.repo.state.value.let { s ->
            assertNull("The review is consumed before the POST", s.review); assertTrue(s.confirming)
            assertNotNull(model.state.value.local.placement)
            held += !legacyPlacementDialogVisible(model.state.value.local.placement, true, heroReviewHeld(s), false)
        }; send(path, body) }
        f.beforeGet = { if (it == "/heroes" && f.posts.isNotEmpty()) held += heroReviewHeld(f.repo.state.value) }
        model.confirmHeroPlacement(f.repo.state.value.review!!)?.join()
        assertTrue(held.isNotEmpty()); assertTrue("POST and hydration keep the surfaces held", held.all { it })
        assertNull(model.notice.value); assertNotNull(f.repo.state.value.receipt); assertNull(f.saved()); assertEquals(1, f.posts.size)
        // The draft itself clearing after the confirm is pinned (with its own dispatcher) by the test above.
        assertFalse("the surfaces are released once the confirm is over", f.repo.state.value.confirming)
    }
    @Test fun `a refused confirm releases the surfaces so the player can choose again`() = runTest {
        val f = HeroRecruitmentFixture(); val model = model(f); review(model, f)
        f.contracts = 0; f.transform = { path, raw -> if (path != "/heroes") raw else JsonObject(raw + ("heroes" to JsonArray(raw.getValue("heroes").jsonArray.map {
            JsonObject(it.jsonObject + ("recruitCostKeep" to JsonPrimitive("38"))) }))) }
        model.confirmHeroPlacement(f.repo.state.value.review!!)?.join()
        assertTrue(f.posts.isEmpty()); assertNotNull(model.notice.value)
        assertFalse(f.repo.state.value.confirming); assertNotNull(model.state.value.local.placement)
    }
    @Test fun `pause during preflight invalidates consent before any durable command`() = runTest {
        val f = HeroRecruitmentFixture(); val model = model(f); review(model, f)
        val entered = CompletableDeferred<Unit>(); val wait = CompletableDeferred<Unit>()
        f.onAccount = { entered.complete(Unit); wait.await() }
        val job = model.confirmHeroPlacement(f.repo.state.value.review!!); entered.await()
        model.dismissHeroReview(); wait.complete(Unit); job?.join()
        assertTrue(f.posts.isEmpty()); assertNull(f.saved()); assertNotNull(model.notice.value)
    }
    @Test fun `navigation during a submitted request holds its original key and refuses late success`() = runTest {
        val f = HeroRecruitmentFixture(); val model = model(f); review(model, f)
        val entered = CompletableDeferred<Unit>(); val wait = CompletableDeferred<Unit>()
        f.postHandler = { _, _ -> entered.complete(Unit); wait.await(); f.proof(f.saved()!!) }
        val job = model.confirmHeroPlacement(f.repo.state.value.review!!); entered.await()
        val original = f.saved()!!; model.closeSurfaces(); wait.complete(Unit); job?.join()
        assertEquals(original, f.saved()); assertNull(f.repo.state.value.receipt); assertEquals(1, f.posts.size)
    }
    @Test fun `recreated Kingdom foreground checks the saved receipt without replaying placement`() = runTest {
        val f = HeroRecruitmentFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        try { f.recruit() } catch (_: IOException) { }
        val restored = HeroRecruitmentFixture(f.disk); val model = model(restored)
        repeat(3) { model.refreshHeroRecruitment()?.join() }
        assertTrue(restored.posts.isEmpty()); assertEquals(f.saved(), restored.repo.state.value.pending)
    }
    @Test fun `actual shipped hero terms stay separate from unsupported ordinary paid construction`() {
        val catalogue = Json.parseToJsonElement(File("src/main/assets/native/catalogue.json").readText()).jsonObject
        val constants = catalogue.getValue("constants").jsonObject; val definitions = HeroAltarDefinition.all(catalogue)
        assertEquals(2, definitions.size)
        for (definition in definitions) {
            val source = constants.getValue("HEROES").jsonObject.getValue(definition.hero).jsonObject
            assertEquals(source.getValue("recruitCostKeep").jsonPrimitive.content, definition.costKeep)
            assertEquals(source.getValue("recruitItemId").jsonPrimitive.content, definition.itemId)
            assertNull("A generic null-price exemption must not make a hero spend", buildingPrice(catalogue, baseJson(), definition.type))
            assertTrue(HeroAltarOffer(definition, 1, false).priceLabel().contains("no KEEP"))
            assertTrue(HeroAltarOffer(definition, 0, false).priceLabel().contains("KEEP"))
        }
    }
}
