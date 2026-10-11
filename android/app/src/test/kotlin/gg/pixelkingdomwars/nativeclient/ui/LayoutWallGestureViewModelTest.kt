package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ops.PendingIntentStore
import gg.pixelkingdomwars.nativeclient.ops.ReceiptObserver
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.ui.layout.*
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

@OptIn(ExperimentalCoroutinesApi::class)
class LayoutWallGestureViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private fun file(path: String) = Json.parseToJsonElement(File(path).readText()).jsonObject
    private val catalogue = file("src/main/assets/native/catalogue.json")
    private val render = file("src/main/assets/native/render-catalog.json")
    private val actions = InterruptedActions({}, {}, {})
    private fun base(keepX: Int = 14) = BaseSnapshot.from(json("""{"baseId":"$BASE_ID","player":{"wallet":"$WALLET","name":"","keepLevel":3,"trophies":0,"league":"bronze","builders":1,"expansions":0},
        "energy":{"used":0,"free":6,"max":6},"claim":{"min":8,"max":22},
        "buildings":[{"id":"keep","type":"keep","level":1,"tx":$keepX,"ty":14,"underConstruction":false},{"id":"cannon","type":"cannon","level":1,"tx":10,"ty":10,"underConstruction":false},
        {"id":"w1","type":"wall","level":1,"tx":10,"ty":12,"underConstruction":false}],"obstacles":[{"id":"rock","spriteKey":"boulder","tx":18,"ty":18}],"jobs":[{"id":"j","kind":"upgrade","buildingId":"cannon","startedAt":"2026-09-11T00:00:00Z","finishesAt":"2026-09-11T01:00:00Z"}],"freeBuilders":0}"""))
    private fun layouts(farmLocked: Boolean = true) = Layouts.from(json("""{"baseId":"$BASE_ID","geometryVersion":1,"claim":{"min":8,"max":22,"size":14},"active":{"slot":null,"etag":"sha256:a"},
        "farmUnlock":{"locked":$farmLocked,"costShards":500},"slots":[{"slot":"HOME","locked":false,"etag":"sha256:h","positions":[],"compatibility":"empty","unplacedBuildingIds":[],"removedBuildingIds":[]},
        {"slot":"FARM","locked":$farmLocked,"etag":"sha256:f","positions":[],"compatibility":"empty","unplacedBuildingIds":[],"removedBuildingIds":[]}]}"""))
    private fun fixture(): Pair<FakeBaseRepository, LayoutEditorViewModel> {
        val repo = FakeBaseRepository().also { it._state.value = BaseState(base = base()); it.layouts = layouts(farmLocked = false) }
        return repo to LayoutEditorViewModel(repo, FakeContentRepository(catalogue, render), ReceiptObserver(PendingIntentStore(MemoryStore())), actions)
    }


    private fun paint(model: LayoutEditorViewModel): WallStrokeMode {
        model.selectBuilding("w1"); model.moveSelectedToTray(); model.selectTrayItem("w1")
        return requireNotNull(model.state.value.wallStrokeMode)
    }
    @Test fun `selecting a trayed wall enables the reused drawing lease by default`() {
        val (_, model) = fixture(); model.open()
        val mode = paint(model)
        assertEquals(BASE_ID, mode.baseId)
        assertTrue(WallStrokeTile(9, 9) in mode.validTiles)
        assertFalse(WallStrokeTile(14, 14) in mode.validTiles)
    }
    @Test fun `preview and release require one local confirm and never call a repository mutation`() {
        val (repo, model) = fixture(); model.open(); val mode = paint(model)
        val before = model.state.value.draft!!
        val cells = listOf(WallStrokeTile(9, 9))
        model.wallStroke(WallStrokeEvent.Preview(mode.token, cells))
        assertEquals(1, model.state.value.wallPreviewCount)
        assertEquals(mode.token, model.state.value.wallStrokeMode!!.token)
        assertEquals(before, model.state.value.draft)
        model.wallStroke(WallStrokeEvent.Released(mode.token, cells))
        assertEquals(before, model.state.value.draft)
        assertTrue(model.state.value.wallPending != null)
        assertNull(model.state.value.wallStrokeMode)
        model.confirmWallStroke(); model.confirmWallStroke()
        assertEquals(9, model.state.value.draft!!.position("w1")!!.tx)
        assertEquals(before.history.size + 1, model.state.value.draft!!.history.size)
        assertEquals(listOf("layouts"), repo.calls)
        model.undo(); assertEquals(before.positions, model.state.value.draft!!.positions)
        assertEquals(before.trayIds, model.state.value.draft!!.trayIds)
    }
    @Test fun `cancel and duplicate release cannot consume another owned wall`() {
        val (_, model) = fixture(); model.open(); val mode = paint(model)
        val before = model.state.value.draft
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(9, 9))))
        model.cancelWallStroke()
        val next = model.state.value.wallStrokeMode!!
        assertNotEquals(mode.token, next.token)
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(9, 9))))
        assertNull(model.state.value.wallPending); assertEquals(before, model.state.value.draft)
        model.wallStroke(WallStrokeEvent.Released(next.token, listOf(WallStrokeTile(9, 9))))
        model.confirmWallStroke(); assertEquals(9, model.state.value.draft!!.position("w1")!!.tx)
    }
    @Test fun `slot switch and discard reject late release and old confirmation`() {
        val (_, model) = fixture(); model.open(); val mode = paint(model)
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(9, 9))))
        model.selectSlot("FARM"); val farm = model.state.value.draft
        model.confirmWallStroke(); model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(9, 9))))
        assertEquals(farm, model.state.value.draft); assertNull(model.state.value.wallPending)
        model.confirmDiscard(); model.confirmWallStroke(); assertFalse(model.state.value.open)
    }
    @Test fun `obstacle change invalidates preview and pending confirmation without moving identities`() {
        val (repo, model) = fixture(); model.open(); val mode = paint(model)
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(9, 9))))
        val before = model.state.value.draft
        repo._state.value = repo._state.value.copy(base = repo._state.value.base!!.copy(obstacles = listOf(Obstacle("new", "boulder", 9, 9))))
        model.confirmWallStroke(); assertEquals(before, model.state.value.draft)
        assertNull(model.state.value.wallPending)
    }
    @Test fun `erase moves only draft walls into inventory with a single reversible confirmation`() {
        val (repo, model) = fixture(); model.open(); val before = model.state.value.draft!!
        model.setWallTool(LayoutWallTool.ERASE)
        val mode = model.state.value.wallStrokeMode!!
        assertTrue(WallStrokeTile(10, 12) in mode.validTiles)
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(10, 12))))
        model.confirmWallStroke()
        assertEquals(listOf("w1"), model.state.value.draft!!.trayIds)
        assertEquals(before.history.size + 1, model.state.value.draft!!.history.size)
        assertEquals(listOf("layouts"), repo.calls)
        model.undo(); assertEquals(before.positions, model.state.value.draft!!.positions)
    }
    @Test fun `select stroke and nudge move owned draft run without live base calls`() {
        val (repo, model) = fixture(); model.open()
        model.setWallTool(LayoutWallTool.SELECT); val mode = model.state.value.wallStrokeMode!!
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(10, 12))))
        assertEquals(listOf("w1"), model.state.value.local.wallSelectedIds)
        assertNull(model.state.value.wallPending)
        model.nudge(1, 0)
        assertEquals(11, model.state.value.draft!!.position("w1")!!.tx)
        assertEquals(10, repo._state.value.base!!.buildings.single { it.id == "w1" }.tx)
        assertEquals(listOf("layouts"), repo.calls)
    }
    @Test fun `save cannot race an unconfirmed stroke`() {
        val (repo, model) = fixture(); model.open(); model.setWallTool(LayoutWallTool.ERASE)
        val mode = model.state.value.wallStrokeMode!!
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(10, 12))))
        assertTrue(model.state.value.saveDisabled)
        model.save("save"); assertEquals(listOf("layouts"), repo.calls)
    }
    @Test fun `release with a tile not admitted by the current lease refuses the entire draft edit`() {
        val (_, model) = fixture(); model.open(); val mode = paint(model); val before = model.state.value.draft
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(9, 9), WallStrokeTile(14, 14))))
        assertNull(model.state.value.wallPending); assertEquals(before, model.state.value.draft)
        assertNotEquals(mode.token, model.state.value.wallStrokeMode!!.token)
    }
}
