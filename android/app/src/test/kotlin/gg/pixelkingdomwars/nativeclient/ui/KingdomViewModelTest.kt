package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.WallRowQuote
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.renderer.HighlightColors
import gg.pixelkingdomwars.nativeclient.renderer.SceneHighlightKind
import gg.pixelkingdomwars.nativeclient.scene.BaseGeometry
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomSheet
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomViewModel
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** The Kingdom screen's selection, wall row and cache state against the shipped catalogues. */
@OptIn(ExperimentalCoroutinesApi::class)
class KingdomViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private fun file(path: String) = Json.parseToJsonElement(File(path).readText()).jsonObject
    private val catalogue = file("src/main/assets/native/catalogue.json")
    private val render = file("src/main/assets/native/render-catalog.json")
    private val actions = InterruptedActions({}, {}, {})
    private val W1 = "11111111-1111-4111-8111-111111111111"; private val W2 = "22222222-2222-4222-8222-222222222222"; private val W3 = "33333333-3333-4333-8333-333333333333"
    private fun base() = BaseSnapshot.from(json("""{"baseId":"$BASE_ID","player":{"wallet":"$WALLET","name":"","keepLevel":3,"trophies":0,"league":"bronze","builders":1,"expansions":0},
        "energy":{"used":0,"free":6,"max":6},"claim":{"min":8,"max":22},
        "buildings":[{"id":"keep","type":"keep","level":1,"tx":14,"ty":14,"underConstruction":false},{"id":"$W1","type":"wall","level":1,"tx":10,"ty":12,"underConstruction":false},
        {"id":"$W2","type":"wall","level":1,"tx":11,"ty":12,"underConstruction":false},{"id":"$W3","type":"wall","level":2,"tx":10,"ty":13,"underConstruction":false}],
        "obstacles":[{"id":"rock","spriteKey":"boulder","tx":18,"ty":18}],"jobs":[],"freeBuilders":1}"""))
    private fun model(repo: FakeBaseRepository = FakeBaseRepository().also { it._state.value = BaseState(base = base()) }, observer: ReceiptObserver = ReceiptObserver(PendingIntentStore(MemoryStore())), preferences: DevicePreferences = MemoryDevicePreferences()) =
        KingdomViewModel(repo, FakeContentRepository(catalogue, render), observer, actions, versionCode = 1, preferences = preferences, wallet = WALLET)

    @Test fun `a plot tap selects the covered building then the covered obstacle then nothing`() {
        val model = model()
        model.tapGround(15.5f, 15.2f)
        assertEquals("The Keep covers its 2×2 footprint", "keep", model.state.value.selectedBuildingId)
        assertEquals(listOf(14f to 14f), model.state.value.highlights.map { it.tileX to it.tileY }); assertEquals(2f, model.state.value.highlights.single().width)
        // Message rewritten 2026-10-06: the outline + corner ticks this named were replaced by the designed frame (owner:
        // the yellow tile "looks ugly"); the pinned kind is unchanged.
        assertEquals("A selection is the designed frame + sprite outline, not a flat tint", SceneHighlightKind.SELECTION, model.state.value.highlights.single().kind)
        assertEquals(HighlightColors.GOLD, model.state.value.highlights.single().color); assertEquals(BaseGeometry.SELECTION_ALPHA, model.state.value.highlights.single().alpha)
        model.tapGround(19.9f, 19.9f)
        assertEquals("A 2-tile boulder covers 18..19", "rock", model.state.value.selectedObstacle!!.id); assertNull(model.state.value.selectedBuildingId)
        model.tapGround(3f, 3f)
        assertNull(model.state.value.selectedObstacle); assertNull(model.state.value.selectedBuildingId); assertTrue(model.state.value.highlights.isEmpty())
    }
    @Test fun `placement shows the plot grid and the picked footprint in neutral gold until the server answers`() {
        val model = model()
        model.selectBuilding("keep"); model.startPlacement("cannon")
        assertNull("Placement drops the selection", model.state.value.selectedBuildingId)
        val grid = model.state.value.highlights.single()
        assertEquals(SceneHighlightKind.GRID, grid.kind); assertEquals(8f to 8f, grid.tileX to grid.tileY); assertEquals(14f to 14f, grid.width to grid.height)
        model.pickTile(10.7f, 11.2f)
        val (_, picked) = model.state.value.highlights.also { assertEquals(2, it.size) }
        assertEquals(SceneHighlightKind.FOOTPRINT, picked.kind); assertEquals(10f to 11f, picked.tileX to picked.tileY); assertEquals(1f to 1f, picked.width to picked.height)
        assertEquals("The app has no local placement check here; only the server answers, so the tint stays gold", HighlightColors.GOLD, picked.color)
        model.clearTile(); assertEquals(listOf(SceneHighlightKind.GRID), model.state.value.highlights.map { it.kind })
        model.cancelPlacement(); assertTrue(model.state.value.highlights.isEmpty())
    }
    @Test fun `the wall row highlight is the run the server prices and resets with the selection`() {
        val model = model()
        model.selectBuilding(W1); model.toggleWallRow()
        assertEquals("Horizontal run of two wins the tie against the vertical run of two", setOf(W1, W2), model.state.value.wallRowIds.toSet())
        assertEquals(2, model.state.value.highlights.size)
        model.selectBuilding(W3)
        assertFalse("A new selection drops the row mode", model.state.value.local.wallRow); assertTrue(model.state.value.wallRowIds.isEmpty())
    }
    @Test fun `the selection names the sprite it outlines and a priced row is outlined wall by wall without frames`() {
        val model = model()
        model.selectBuilding("keep")
        assertEquals("The renderer outlines the Keep's own sprite", "keep", model.state.value.highlights.single().targetId)
        model.tapGround(19.9f, 19.9f)
        assertEquals("An obstacle is outlined by its row id", "rock", model.state.value.highlights.single().targetId)
        model.selectBuilding(W1); model.toggleWallRow()
        val row = model.state.value.highlights
        assertEquals("buildings/wall-row.png: each wall gets the rim, none gets a frame of its own (a chain of boxes)",
            listOf(SceneHighlightKind.OUTLINE, SceneHighlightKind.OUTLINE), row.map { it.kind })
        assertEquals(setOf(W1, W2), row.mapNotNull { it.targetId }.toSet())
        assertTrue("No SELECTION while the row is priced: the single-wall frame steps aside", row.none { it.kind == SceneHighlightKind.SELECTION })
    }
    @Test fun `quote purchase and re-pricing drive the dialog and a saved key offers RETRY SAME UPGRADE`() {
        val repo = FakeBaseRepository().also { it._state.value = BaseState(base = base()) }
        val store = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(store)
        val model = model(repo, observer)
        val quote = WallRowQuote.from(json("""{"baseId":"$BASE_ID","selectedWallId":"$W1","quoteId":"${"ab".repeat(32)}","keepLevel":3,"walls":[{"id":"$W1","tx":10,"ty":12,"level":1,"targetLevel":2,"costShards":48,"excluded":null}],"totalCostShards":48,"balanceShards":"3520","canAfford":true}"""))
        repo.wallRowQuote = quote
        model.selectBuilding(W1); model.toggleWallRow(); model.quoteWallRow()
        assertEquals(quote.quoteId, model.state.value.local.wallRowQuote!!.quoteId); assertFalse(model.state.value.wallRowRetry)
        repo.wallRowOutcome = WallRowOutcome.Repriced(WallRowQuote.from(JsonObject(quote.raw + ("canAfford" to JsonPrimitive(false)))), "Not enough SHARDS for the whole quoted row.")
        model.purchaseWallRow()
        assertFalse("The replacement quote is re-presented", model.state.value.local.wallRowQuote!!.canAfford); assertTrue(model.notice.value!!.error)
        repo.wallRowOutcome = WallRowOutcome.Upgraded(WallRowAcceptance(emptyList(), "48", false))
        model.purchaseWallRow(); assertNull("An accepted purchase closes the dialog", model.state.value.local.wallRowQuote)
        // A lost reply leaves the key in the journal: the same quote stays open and the button becomes RETRY SAME UPGRADE.
        model.quoteWallRow()
        store.create(WallRowSpec.intent(WALLET, BASE_ID, quote, "wall-row-key-1").copy(attempted = true)); kotlinx.coroutines.runBlocking { observer.refresh(WALLET) }
        assertTrue(model.state.value.wallRowRetry); assertTrue(model.state.value.wallRowBlocked)
        model.quoteWallRow(); assertTrue("A new quote is refused while the key is unresolved", model.notice.value!!.message.contains("interrupted"))
    }
    @Test fun `the daily cache sheet reads mining on open and the keep confirmation preference persists on the device`() {
        val repo = FakeBaseRepository().also { it._state.value = BaseState(base = base()) }
        val preferences = MemoryDevicePreferences()
        val model = model(repo, preferences = preferences)
        model.openDailyCache()
        assertEquals(KingdomSheet.DAILY_CACHE, model.state.value.local.sheet); assertEquals("mine", repo.calls.last())
        model.claimDailyCache(); assertEquals("claimCache", repo.calls.last())
        model.closeSheet(); assertNull(model.state.value.local.sheet)
        assertTrue(model.state.value.local.keepConfirm)
        model.setKeepConfirm(false); assertFalse(preferences.keepConfirm); assertFalse(model.state.value.local.keepConfirm)
        model.selectBuilding("keep"); model.toggleInfo(); assertEquals("The compact Keep tray starts collapsed; the first Details tap opens it", true, model.state.value.local.infoOpen)
        model.clearObstacle("rock"); assertEquals("clear:rock", repo.calls.last())
    }
    @Test fun `army and kingdom confirmations share the player's latest preference across retained screens`() {
        val preferences = MemoryDevicePreferences()
        val kingdom = model(preferences = preferences)
        val army = DeviceKeepConfirmPreference(preferences)
        army.set(false)
        assertFalse("A retained Home must observe the opt-out made in Army", kingdom.keepConfirmationRequired())
        kingdom.setKeepConfirm(true)
        assertTrue("Re-enabling confirmations in Home must apply to heroes and army too", army.on())
    }

    /** A Home read and an order that wait for the test, standing in for a phone network under the 20 s cadence tick. */
    private class SlowHomeRepository(val fake: FakeBaseRepository) : BaseRepository by fake {
        var homeGate: kotlinx.coroutines.CompletableDeferred<Unit>? = null
        var orderGate: kotlinx.coroutines.CompletableDeferred<Unit>? = null
        var homeReads = 0
        override suspend fun refresh() { homeReads++; homeGate?.await(); fake.refresh() }
        override suspend fun clearObstacle(obstacleId: String) { orderGate?.await(); fake.clearObstacle(obstacleId) }
    }
    private fun slowModel(repo: SlowHomeRepository) = KingdomViewModel(repo, FakeContentRepository(catalogue, render),
        ReceiptObserver(PendingIntentStore(MemoryStore())), actions, versionCode = 1, wallet = WALLET)

    // Owner 2026-10-06 "always loading": the tick held the screen's busy slot for four reads every 20 s, which closed
    // BUILD, ATTACK, the tools and every Home door, and an order tapped meanwhile was dropped without a word.
    @Test fun `a cadence tick re-reads Home without busy and an order tapped during it proceeds`() {
        val repo = SlowHomeRepository(FakeBaseRepository().also { it._state.value = BaseState(base = base()) })
        val model = slowModel(repo)
        val refreshes = repo.fake.calls.count { it == "refresh" }
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>(); repo.homeGate = gate
        model.tick()
        assertEquals("The tick is reading Home", 2, repo.homeReads)
        assertFalse("A background re-read never raises busy", model.busy.value)
        model.clearObstacle("rock")
        assertEquals("The order is not dropped behind the tick", "clear:rock", repo.fake.calls.last())
        gate.complete(Unit)
        assertEquals("The order cancelled the older read, so it cannot publish over the order's own re-read",
            refreshes, repo.fake.calls.count { it == "refresh" })
        assertFalse(model.busy.value); assertNull(model.notice.value)
    }
    @Test fun `a cadence tick never overlaps an order and keeps the order's notice`() {
        val repo = SlowHomeRepository(FakeBaseRepository().also { it._state.value = BaseState(base = base()) })
        val model = slowModel(repo)
        val order = kotlinx.coroutines.CompletableDeferred<Unit>(); repo.orderGate = order
        model.clearObstacle("rock")
        assertTrue(model.busy.value)
        val reads = repo.homeReads
        model.tick()
        assertEquals("No Home read starts under a running order (it re-reads Home itself)", reads, repo.homeReads)
        repo.fake.failWith = IllegalStateException("all builders are busy")
        order.complete(Unit)
        assertEquals("all builders are busy", model.notice.value?.message); assertFalse(model.busy.value)
        repo.fake.failWith = null; repo.orderGate = null
        model.tick()
        assertEquals("The next tick runs once the order is done", reads + 1, repo.homeReads)
        assertEquals("A tick no longer wipes the player's notice", "all builders are busy", model.notice.value?.message)
        repo.fake.failWith = java.io.IOException("offline")
        model.tick()
        assertEquals("A failed background read adds no notice; the last good Home stays", "all builders are busy", model.notice.value?.message)
        assertNotNull(model.state.value.base); assertFalse(model.busy.value)
    }

}
