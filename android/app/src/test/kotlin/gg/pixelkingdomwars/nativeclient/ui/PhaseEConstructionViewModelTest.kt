package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.network.PhaseEConstructionArt
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File

/** Synthetic admission fixtures verify control boundaries; they do not admit new content or certify scene art. */
@OptIn(ExperimentalCoroutinesApi::class)
class PhaseEConstructionViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private val catalogue = json("""{"constants":{
        "PHASE_E_BUILDINGS":{"types":["workshop"]},
        "BUILD_COSTS":{"workshop":{"costShards":13,"buildSec":17,"requiresKeepLevel":3}},
        "STRUCTURES":{"workshop":{"hp":19,"maxLevel":2,"footprint":[2,1]}},
        "BUILD_COUNT_CAP_BY_KEEP":{"workshop":[0,0,1]}}}""")
    private val render = json("""{"entries":[
        {"type":"workshop","level":1,"phaseE":{"facility":"workshop","tier":1},"footprintWidth":2,"footprintHeight":1},
        {"type":"workshop","level":2,"phaseE":{"facility":"workshop","tier":2},"footprintWidth":2,"footprintHeight":1}]}""")
    private fun base(enabled: Boolean = true) = BaseSnapshot.from(json("""{"baseId":"$BASE_ID",
        "player":{"wallet":"$WALLET","name":"","keepLevel":3,"trophies":0,"league":"bronze","builders":1,"expansions":0},
        "energy":{"used":0,"free":6,"max":6},"claim":{"min":8,"max":22},
        "buildings":[{"id":"facility","type":"workshop","level":1,"tx":10,"ty":12,"underConstruction":false}],
        "obstacles":[],"jobs":[],"freeBuilders":1,"features":{"phaseEBuildings":{"version":1,"enabledTypes":${if (enabled) "[\"workshop\"]" else "[]"}}}}"""))
    private fun repository(enabled: Boolean = true) = FakeBaseRepository().also { it._state.value = BaseState(base = base(enabled)) }
    // Test-only control-boundary admission, never production residency evidence.
    private fun admittedArt() = MutableStateFlow<PhaseEConstructionArt?>(PhaseEConstructionArt { true })
    private fun model(repo: FakeBaseRepository, content: FakeContentRepository = FakeContentRepository(catalogue, render),
        observer: ReceiptObserver = ReceiptObserver(PendingIntentStore(MemoryStore())), actions: InterruptedActions = InterruptedActions({}, {}, {}),
        art: MutableStateFlow<PhaseEConstructionArt?> = admittedArt()) =
        KingdomViewModel(repo, content, observer, actions, versionCode = 1, wallet = WALLET, constructionArt = art)

    @Test fun `missing or refusing art capability preserves selection but blocks new mutations`() {
        listOf<PhaseEConstructionArt?>(null, PhaseEConstructionArt { false }).forEach { capability ->
            val repo = repository(); val model = model(repo, art = MutableStateFlow(capability))
            assertTrue(model.state.value.phaseEBuildingChoices.isEmpty())
            model.selectBuilding("facility"); assertEquals("facility", model.state.value.selectedBuilding!!.id)
            model.startPlacement("workshop"); assertNull(model.state.value.placement)
            model.upgrade("facility"); assertTrue(model.notice.value!!.error)
            assertFalse(repo.calls.any { it.startsWith("place:") || it.startsWith("upgrade:") })
            assertEquals("facility", model.state.value.selectedBuilding!!.id)
        }
    }

    @Test fun `dispatch rechecks revoked art before the UI catches up and never revives the draft`() {
        val scheduler = TestCoroutineScheduler(); Dispatchers.setMain(StandardTestDispatcher(scheduler))
        val art = admittedArt(); val repo = repository(); val model = model(repo, art = art); scheduler.runCurrent()
        model.startPlacement("workshop"); scheduler.runCurrent(); model.pickTile(15f, 17f); scheduler.runCurrent()
        art.value = null
        assertNotNull("The old combined UI still holds its admitted draft", model.state.value.placement)
        assertEquals(listOf("workshop"), model.state.value.phaseEBuildingChoices)
        model.confirmPlacement(); model.upgrade("facility"); scheduler.runCurrent()
        assertFalse(repo.calls.any { it.startsWith("place:") || it.startsWith("upgrade:") })
        assertTrue(model.notice.value!!.error); assertNull(model.state.value.placement)
        art.value = PhaseEConstructionArt { true }; scheduler.runCurrent()
        assertNull("Readmission requires a fresh player selection", model.state.value.placement)
        assertFalse(repo.calls.any { it.startsWith("place:") || it.startsWith("upgrade:") })
    }

    // Rule changed: this case was written (6ff7839a) when the bundled pack was the SIM17 pack without Phase E buildings, so
    // the shipped catalogue itself kept them dark. The bundle is now deliberately a Phase E pack (r12 export with
    // --phase-e-services, e47fc6f9; ae8104ad before it): it DECLARES the Phase E types with admitted entries. Darkness now
    // comes from the server's phaseEBuildings switch (and art admission, pinned above). Against the real shipped files:
    // switched off, nothing is offered or placed and server state is preserved; switched on, only the enabled type lights.
    @Test fun `the shipped catalogue stays dark until the server enables its Phase E buildings`() {
        fun file(name: String) = Json.parseToJsonElement(File("src/main/assets/native/$name").readText()).jsonObject
        fun shipped() = FakeContentRepository(file("catalogue.json"), file("render-catalog.json"))
        val repo = repository(enabled = false); val model = model(repo, shipped())
        assertTrue(model.state.value.phaseEBuildingChoices.isEmpty())
        model.startPlacement("workshop"); assertNull(model.state.value.placement)
        assertTrue(model.notice.value!!.error); assertFalse(repo.calls.any { it.startsWith("place:") })
        assertEquals("Existing server state is preserved", "workshop", model.state.value.base!!.buildings.single().type)
        val enabled = repository(); val lit = model(enabled, shipped())
        assertEquals(listOf("workshop"), lit.state.value.phaseEBuildingChoices)
        assertFalse(enabled.calls.any { it.startsWith("place:") })
    }

    @Test fun `an admitted start follows the existing repository construction path once`() {
        val repo = repository(); val model = model(repo)
        assertEquals(listOf("workshop"), model.state.value.phaseEBuildingChoices)
        model.startPlacement("workshop"); model.pickTile(15f, 17f); model.confirmPlacement(); model.confirmPlacement()
        assertEquals(listOf("place:workshop:15:17"), repo.calls.filter { it.startsWith("place:") })
    }

    @Test fun `known occupied tiles retain the draft and never dispatch a construction order`() {
        val repo = repository(); val model = model(repo)
        model.startPlacement("workshop"); model.pickTile(10f, 12f); model.confirmPlacement()
        assertEquals(10 to 12, model.state.value.placement?.tile)
        assertEquals("Spot is blocked", model.notice.value?.message)
        assertFalse(repo.calls.any { it.startsWith("place:") })
        model.pickTile(15f, 17f); model.confirmPlacement()
        assertEquals(listOf("place:workshop:15:17"), repo.calls.filter { it.startsWith("place:") })
    }

    @Test fun `outside claim retains the draft with a reason and no order`() {
        val repo = repository(); val model = model(repo)
        model.startPlacement("workshop"); model.pickTile(21f, 17f); model.confirmPlacement()
        assertEquals(21 to 17, model.state.value.placement?.tile)
        assertEquals("Outside your land", model.notice.value?.message)
        assertFalse(repo.calls.any { it.startsWith("place:") })
    }

    @Test fun `confirm sees a new obstacle in the repository before the UI collector advances`() {
        val scheduler = TestCoroutineScheduler(); Dispatchers.setMain(StandardTestDispatcher(scheduler))
        val repo = repository(); val model = model(repo); scheduler.runCurrent()
        model.startPlacement("workshop"); scheduler.runCurrent(); model.pickTile(15f, 17f); scheduler.runCurrent()
        val old = repo._state.value
        repo._state.value = old.copy(base = old.base!!.copy(obstacles = listOf(gg.pixelkingdomwars.nativeclient.model.Obstacle("new", "unknown", 15, 17))))
        assertTrue(model.state.value.base!!.obstacles.isEmpty())
        model.confirmPlacement(); scheduler.runCurrent()
        assertEquals(15 to 17, model.state.value.placement?.tile)
        assertFalse(repo.calls.any { it.startsWith("place:") })
        assertEquals("Spot is blocked", model.notice.value?.message)
    }

    @Test fun `pausing the feature retires a placement review permanently`() {
        val repo = repository(); val model = model(repo)
        model.startPlacement("workshop"); model.pickTile(15f, 17f)
        assertNotNull(model.state.value.placement!!.tile)
        repo._state.value = BaseState(base = base(false))
        assertNull(model.state.value.placement); model.confirmPlacement()
        repo._state.value = BaseState(base = base(true))
        assertNull("A reopened flag requires a new player selection", model.state.value.placement)
        assertFalse(repo.calls.any { it.startsWith("place:") })
    }

    @Test fun `losing the admitted scene art retires the draft without reviving it on content return`() {
        val repo = repository(); val content = FakeContentRepository(catalogue, render); val model = model(repo, content)
        model.startPlacement("workshop"); model.pickTile(15f, 17f)
        content.set { it.copy(renderCatalogue = json("""{"entries":[]}""")) }
        assertNull(model.state.value.placement)
        content.set { it.copy(renderCatalogue = render) }
        assertNull(model.state.value.placement); assertFalse(repo.calls.any { it.startsWith("place:") })
    }

    @Test fun `dispatch reads current feature state even before the UI flow catches up`() {
        val scheduler = TestCoroutineScheduler(); Dispatchers.setMain(StandardTestDispatcher(scheduler))
        val repo = repository(); val model = model(repo); scheduler.runCurrent()
        model.startPlacement("workshop"); scheduler.runCurrent(); model.pickTile(15f, 17f); scheduler.runCurrent()
        repo._state.value = BaseState(base = base(false))
        assertNotNull("The old combined UI still holds a draft at this instant", model.state.value.placement)
        model.confirmPlacement(); scheduler.runCurrent()
        assertFalse("A stale confirmation must not dispatch a new mutation", repo.calls.any { it.startsWith("place:") })
        assertTrue(model.notice.value!!.error)
    }

    @Test fun `paused existing structures keep selection and job recovery but refuse new upgrades`() {
        val repo = repository(false)
        repo._state.value = BaseState(base = BaseSnapshot.from(JsonObject(base(false).raw + ("jobs" to JsonArray(listOf(
            json("""{"id":"original-job","kind":"build","buildingId":"facility","finishCostKeep":"0","canCancel":true}""")
        ))))))
        val model = model(repo)
        model.selectBuilding("facility"); assertEquals("facility", model.state.value.selectedBuilding!!.id)
        assertFalse(model.state.value.constructionAvailable("workshop", 2))
        model.upgrade("facility"); assertFalse(repo.calls.contains("upgrade:facility"))
        model.finishJob("original-job"); model.cancelJob("original-job")
        assertTrue(repo.calls.contains("finish:original-job")); assertTrue(repo.calls.contains("cancel:original-job"))
        assertEquals("facility", model.state.value.selectedBuilding!!.id)
    }

    @Test fun `upgrade starts require the exact target level scene art`() {
        val upgradeTargets = mutableListOf<String?>()
        val art = MutableStateFlow<PhaseEConstructionArt?>(PhaseEConstructionArt { request ->
            if (request.level == 2) upgradeTargets += request.buildingId
            true
        })
        val repo = repository(); val content = FakeContentRepository(catalogue, render); val model = model(repo, content, art = art)
        model.upgrade("facility"); assertEquals(1, repo.calls.count { it == "upgrade:facility" })
        assertEquals("The dispatch callback receives the exact selected identity", listOf("facility"), upgradeTargets)
        content.set { it.copy(renderCatalogue = JsonObject(render + ("entries" to JsonArray(render.getValue("entries").jsonArray.take(1))))) }
        assertFalse(model.state.value.constructionAvailable("workshop", 2))
        model.upgrade("facility"); assertEquals(1, repo.calls.count { it == "upgrade:facility" })
        assertEquals("workshop", model.state.value.base!!.buildings.single().type)
    }

    @Test fun `a stale upgrade selection cannot dispatch after its current building or base disappears`() {
        val scheduler = TestCoroutineScheduler(); Dispatchers.setMain(StandardTestDispatcher(scheduler))
        val repo = repository(); val model = model(repo); scheduler.runCurrent()
        model.selectBuilding("facility"); scheduler.runCurrent()
        val withoutBuilding = BaseSnapshot.from(JsonObject(base().raw + ("buildings" to JsonArray(emptyList()))))
        repo._state.value = BaseState(base = withoutBuilding)
        assertNotNull("The combined UI still contains the selected old building", model.state.value.selectedBuilding)
        model.upgrade("facility"); scheduler.runCurrent()
        assertFalse(repo.calls.contains("upgrade:facility")); assertTrue(model.notice.value!!.error)
        repo._state.value = BaseState()
        model.upgrade("facility"); scheduler.runCurrent()
        assertFalse("Missing Home must also fail closed", repo.calls.contains("upgrade:facility")); assertTrue(model.notice.value!!.error)
    }

    @Test fun `berth placement uses current server capacity and never dispatches a stale sixth`() {
        // Synthetic artwork admits only this test; the shipped pack remains unchanged.
        val berthCatalogue = Json.parseToJsonElement(catalogue.toString().replace("workshop", "berth")).jsonObject
        val berthRender = Json.parseToJsonElement(render.toString().replace("workshop", "berth")).jsonObject
        fun berthBase(count: Int, cap: Int) = BaseSnapshot.from(JsonObject(
            Json.parseToJsonElement(base().raw.toString().replace("workshop", "berth")).jsonObject + mapOf(
                "constructionCapacity" to json("""{"version":1,"berth":{"max":$cap}}"""),
                "buildings" to JsonArray(List(count) { index -> json("""{"id":"berth-$index","type":"berth","level":1,"tx":10,"ty":12,"underConstruction":true}""") })
            )))
        val scheduler = TestCoroutineScheduler(); Dispatchers.setMain(StandardTestDispatcher(scheduler))
        val repo = repository(); repo._state.value = BaseState(base = berthBase(4, 5))
        val model = model(repo, FakeContentRepository(berthCatalogue, berthRender)); scheduler.runCurrent()
        assertEquals(listOf("berth"), model.state.value.phaseEBuildingChoices)
        model.startPlacement("berth"); scheduler.runCurrent(); model.pickTile(15f, 17f); scheduler.runCurrent()
        model.confirmPlacement(); scheduler.runCurrent()
        assertEquals(1, repo.calls.count { it.startsWith("place:berth:") })
        model.startPlacement("berth"); scheduler.runCurrent(); model.pickTile(17f, 17f); scheduler.runCurrent()
        repo._state.value = BaseState(base = berthBase(5, 5))
        assertNotNull("The UI still holds its previous draft", model.state.value.placement)
        model.confirmPlacement(); scheduler.runCurrent()
        assertEquals("The unfinished fifth identity fills capacity", 1, repo.calls.count { it.startsWith("place:berth:") })
        assertTrue(model.notice.value!!.error)
        assertNull("A capacity refusal retires the old selected tile", model.state.value.placement)
        repo._state.value = BaseState(base = berthBase(1, 1)); scheduler.runCurrent()
        model.startPlacement("berth"); scheduler.runCurrent()
        assertNull("Vehicle pause restores the original cap", model.state.value.placement)
        assertEquals(1, repo.calls.count { it.startsWith("place:berth:") })
        repo._state.value = BaseState(base = berthBase(0, 1)); scheduler.runCurrent()
        assertNull("Recovered capacity cannot revive the retired intent", model.state.value.placement)
        model.confirmPlacement(); scheduler.runCurrent()
        assertEquals(1, repo.calls.count { it.startsWith("place:berth:") })
    }

    @Test fun `a paused feature preserves the saved original construction receipt controls`() {
        val store = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(store); val checked = mutableListOf<String>()
        store.create(PendingIntent(IntentKind.CONSTRUCTION, WALLET, BASE_ID, "phase-e-original-key", "/base/buildings",
            json("""{"idempotencyKey":"phase-e-original-key","type":"workshop","tx":15,"ty":17}"""), "Build Workshop", attempted = true))
        runBlocking { observer.refresh(WALLET) }
        val repo = repository(false); val model = model(repo, observer = observer, actions = InterruptedActions({ checked += it }, {}, {}))
        assertTrue(model.state.value.constructionBlocked); assertEquals(IntentKind.CONSTRUCTION, model.state.value.interrupted.single().kind)
        model.interrupted.check(IntentKind.CONSTRUCTION)
        assertEquals(listOf(IntentKind.CONSTRUCTION), checked)
        assertTrue("No automatic mutation retries", repo.calls.none { it.startsWith("place:") || it.startsWith("upgrade:") })
    }
    @Test fun `cost supplier reads live owners before combined UI catches up and refuses old rendered facts`() {
        val scheduler = TestCoroutineScheduler(); Dispatchers.setMain(StandardTestDispatcher(scheduler))
        val holder = testHolder(); val session = signedIn(holder)
        val account = MutableStateFlow(AccountState(session = session, selectedBaseId = BASE_ID, baseSelectionGeneration = 1))
        val repo = repository().also { it.balanceRevision = 1L }
        val content = FakeContentRepository(catalogue, render)
        val model = KingdomViewModel(repo, content, ReceiptObserver(PendingIntentStore(MemoryStore())),
            InterruptedActions({}, {}, {}), 1, wallet = WALLET, accountState = account, recoveryOnly = true,
            constructionArt = admittedArt(), costAccount = session, costHolder = holder)
        scheduler.runCurrent(); model.selectBuilding("facility"); scheduler.runCurrent()
        val rendered = model.state.value
        val costs = model.buildingCosts(rendered)
        assertTrue(costs.reviewCurrent())
        repo.balanceRevision++ // Start fence need not wait for StateFlow delivery.
        assertFalse(costs.reviewCurrent())
        val freshCosts = model.buildingCosts(rendered)
        assertTrue(freshCosts.reviewCurrent())
        repo._state.value = repo._state.value.copy(loading = true)
        assertSame(rendered, model.state.value)
        assertFalse(freshCosts.reviewCurrent())
        assertFalse(model.buildingCosts(rendered).reviewCurrent())
        scheduler.runCurrent()
        repo._state.value = repo._state.value.copy(loading = false); repo.balanceRevision++; scheduler.runCurrent()
        assertTrue(model.buildingCosts(model.state.value).reviewCurrent())
        account.value = account.value.copy(baseSelectionGeneration = 2)
        assertFalse(model.buildingCosts(model.state.value).reviewCurrent())
        scheduler.runCurrent()
        val current = model.buildingCosts(model.state.value)
        assertTrue(current.reviewCurrent())
        signedIn(holder)
        assertFalse(current.reviewCurrent())
    }

    private class SavedCostFixture(val model: KingdomViewModel, val repo: FakeBaseRepository,
        val store: PendingIntentStore, val observer: ReceiptObserver, val checked: MutableList<String>) {
        fun save() {
            store.create(PendingIntent(IntentKind.CONSTRUCTION, WALLET, BASE_ID, "original-cost-key", "/base/buildings",
                json("""{"idempotencyKey":"original-cost-key","type":"workshop","tx":15,"ty":17}"""),
                "Build Workshop", attempted = true))
            runBlocking { observer.refresh(WALLET) }
        }
        fun assertOriginalRecovery() {
            val original = observer.interrupted.value.single().intent
            assertEquals("original-cost-key", original.idempotencyKey)
            model.interrupted.check(IntentKind.CONSTRUCTION)
            assertEquals(listOf(IntentKind.CONSTRUCTION), checked)
            assertEquals(original, observer.interrupted.value.single().intent)
            assertTrue(repo.calls.none { it.startsWith("place:") || it.startsWith("upgrade:") })
        }
    }

    private fun savedCostFixture(): SavedCostFixture {
        val holder = testHolder(); val session = signedIn(holder)
        val account = MutableStateFlow(AccountState(session = session, selectedBaseId = BASE_ID, baseSelectionGeneration = 1))
        val repo = repository().also { it.balanceRevision = 1L }
        val availableCatalogue = Json.parseToJsonElement(catalogue.toString().replace("[0,0,1]", "[0,0,2]")).jsonObject
        val store = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(store); val checked = mutableListOf<String>()
        val model = KingdomViewModel(repo, FakeContentRepository(availableCatalogue, render), observer,
            InterruptedActions({ checked += it }, {}, {}), 1, wallet = WALLET, accountState = account, recoveryOnly = true,
            constructionArt = admittedArt(), costAccount = session, costHolder = holder)
        return SavedCostFixture(model, repo, store, observer, checked)
    }

    @Test fun `saved construction payment keeps placement reason and cancel reaches original recovery`() {
        val f = savedCostFixture(); val model = f.model
        model.startPlacement("workshop"); model.pickTile(15f, 17f)
        assertNotNull(model.state.value.placement)
        f.save()
        val state = model.state.value
        val facts = gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.readPlacementFacts(state, false, 0L, false)!!
        val ui = gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.livePlacementUi(facts, model.buildingCosts(state))!!
        assertEquals("Check the saved payment first", ui.reason)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PlaceTap.NONE,
            gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.placeLook(ui.state, ui.price, ui.reason).tap)
        model.cancelPlacement() // Existing LivePlacementRoutes.onCancel binding.
        assertNull(model.state.value.placement)
        assertTrue(model.state.value.constructionBlocked)
        f.assertOriginalRecovery()
    }

    @Test fun `saved construction payment keeps BUILD reason and close reaches original recovery`() {
        val f = savedCostFixture(); val model = f.model
        model.openBuildMenu(); f.save()
        val state = model.state.value
        val facts = gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.readTrayFacts(state, false)!!
        val ui = gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.liveBuildTrayUi(facts,
            gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveTrayTabs.BUILDINGS, model.buildingCosts(state))
        val card = ui.sections.flatMap { it.cards }.single { it.type == "workshop" }
        assertEquals("Check the saved payment first", card.reason)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.UNAVAILABLE, card.state)
        model.closeBuildMenu() // Existing LiveTrayRoutes.onClose binding.
        assertFalse(model.state.value.buildMenu)
        assertTrue(model.state.value.constructionBlocked)
        f.assertOriginalRecovery()
    }

}
