package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ops.PendingIntentStore
import gg.pixelkingdomwars.nativeclient.ops.ReceiptObserver
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.ui.layout.*
import androidx.compose.ui.unit.IntOffset
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.*
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
class LayoutEditorMapperTest {
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


    @Test fun `unknown inventory and absent slots are not invented as zero or offered`() {
        val ui = LayoutEditorState().layoutEditorUi(anchor = null, showHint = false)
        assertNull(ui.ownedWalls); assertNull(ui.trayedWalls); assertTrue(ui.slots.isEmpty())
        assertEquals("building-wall", ui.wallArt); assertFalse(ui.showHint); assertNull(ui.stroke)
        assertFalse(ui.canSave); assertNotNull(ui.saveBlockedReason)
    }

    @Test fun `server slots keep HOME FARM names and distinguish locked slots from edited tab`() {
        val (_, model) = fixture(); model.open()
        val state = model.state.value
        val slots = state.layouts!!.slots.map { it.copy(locked = it.slot == "FARM") }
        val ui = state.copy(home = state.home.copy(layouts = state.layouts!!.copy(slots = slots)),
            local = state.local.copy(slot = "FARM")).layoutEditorUi(null, true)
        assertEquals(listOf("HOME", "FARM"), ui.slots.map { it.label })
        assertTrue(ui.slots[0].enabled); assertFalse(ui.slots[1].enabled)
        assertEquals("FARM", ui.activeSlot); assertFalse(ui.canSave)
    }

    @Test fun `wall levels use canonical WALL ART tiers and preserve owned tray counts`() {
        val (_, model) = fixture(); model.open(); model.selectBuilding("w1"); model.moveSelectedToTray()
        val state = model.state.value
        val base = state.base!!.copy(buildings = state.base!!.buildings.map { if (it.id == "w1") it.copy(level = 7) else it })
        val catalogue = buildJsonObject { put("constants", buildJsonObject { put("WALL_ART", buildJsonObject { put("tiers", 5); put("levelsPerTier", 2) }) }) }
        val ui = state.copy(home = state.home.copy(base = base), catalogue = catalogue,
            local = state.local.copy(wallPaintLevel = 7, wallTool = LayoutWallTool.PAINT)).layoutEditorUi(null, false)
        assertEquals(1, ui.ownedWalls); assertEquals(1, ui.trayedWalls)
        assertEquals(EditorTool.WALLS, ui.tool); assertEquals(7, ui.paintLevel)
        assertEquals(listOf(WallLevelUi(7, "wall5_t4_straight_intact_f1", 1)), ui.wallLevels)
        assertEquals("wall5_t4_straight_intact_f1", ui.wallArt)
    }

    @Test fun `live and pending strokes keep counts and only use a supplied anchor`() {
        val (_, model) = fixture(); model.open(); model.selectBuilding("w1"); model.moveSelectedToTray(); model.selectTrayItem("w1")
        val mode = model.state.value.wallStrokeMode!!
        model.wallStroke(WallStrokeEvent.Preview(mode.token, listOf(WallStrokeTile(9, 9))))
        val live = model.state.value.layoutEditorUi(null, false)
        assertEquals(WallStrokeUi(1, 1, 0, pending = false, anchor = null), live.stroke)
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(9, 9))))
        val anchor = IntOffset(120, 300)
        val pending = model.state.value.layoutEditorUi(anchor, true)
        assertEquals(WallStrokeUi(1, 1, 0, pending = true, anchor = anchor), pending.stroke)
        assertFalse(pending.canSave); assertTrue(pending.showHint)
    }

    @Test fun `save projection reports actual busy states and leaves unsupported checking unknown`() {
        val (_, model) = fixture(); model.open(); val state = model.state.value
        for (busy in listOf("save", "apply")) {
            val ui = state.copy(local = state.local.copy(busy = busy)).layoutEditorUi(null, false)
            assertEquals(EditorSaveState.SAVING, ui.saveState); assertFalse(ui.canSave)
        }
        val error = state.copy(local = state.local.copy(notice = "CONNECTION RESET")).layoutEditorUi(null, false)
        assertEquals(EditorSaveState.IDLE, error.saveState); assertEquals("CONNECTION RESET", error.notice)
        val unlock = state.copy(local = state.local.copy(busy = "unlock")).layoutEditorUi(null, false)
        assertEquals(EditorSaveState.IDLE, unlock.saveState); assertFalse(unlock.canSave)
        val paused = state.copy(local = state.local.copy(wallInputPaused = true)).layoutEditorUi(null, false)
        assertFalse(paused.canSave)
        // The existing Save controls must remain: this dirty empty server slot has no position delta.
        val empty = state.layoutEditorUi(null, false)
        assertTrue(state.draft!!.dirty); assertEquals(0, empty.changeCount)
        assertFalse(saveLook(empty.changeCount, empty.canSave, false, empty.saveState).sends)
    }

    @Test fun `action adapter confirms and undoes locally while navigation and explanations stay injected`() {
        val (repo, model) = fixture(); model.open(); model.selectBuilding("w1"); model.moveSelectedToTray()
        var navigations = 0; val explanations = mutableListOf<String>()
        val on = layoutEditorActions(model, { navigations++ }, { explanations += it })
        on.onPaint(); val mode = model.state.value.wallStrokeMode!!
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(9, 9))))
        on.onConfirm(); assertEquals(9, model.state.value.draft!!.position("w1")!!.tx)
        on.onUndo(); assertTrue(model.state.value.draft!!.inTray("w1"))
        on.onBuildMore(); on.onExplain("Place the Keep first")
        assertEquals(1, navigations); assertEquals(listOf("Place the Keep first"), explanations)
        assertEquals(listOf("layouts"), repo.calls)
    }

    @Test fun `action adapter rejects unknown slots pending tool changes and paused controls`() {
        val (repo, model) = fixture(); model.open(); model.selectBuilding("w1"); model.moveSelectedToTray(); model.selectTrayItem("w1")
        val on = layoutEditorActions(model, {}, {})
        on.onSlot("unknown"); assertEquals("HOME", model.state.value.slot)
        val mode = model.state.value.wallStrokeMode!!
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(9, 9))))
        val pending = model.state.value.wallPending
        on.onSlot("FARM"); on.onErase(); assertEquals(pending, model.state.value.wallPending)
        assertEquals("HOME", model.state.value.slot)
        on.onCancel(); assertNull(model.state.value.wallPending)
        model.pauseWallInput(); val local = model.state.value.local
        on.onSlot("FARM"); on.onPaint(); on.onPaintLevel(1); on.onMove(1, 0); on.onSave()
        assertEquals(local, model.state.value.local); assertEquals(listOf("layouts"), repo.calls)
    }

    @Test fun `adapter Save dispatches only explicit save and keeps the legacy apply path separate`() {
        val (repo, model) = fixture(); model.open()
        val on = layoutEditorActions(model, {}, {})
        on.onSave(); assertEquals(listOf("layouts"), repo.calls)
        model.selectBuilding("w1"); model.nudge(1, 0)
        repo.saveResult = LayoutSaveResult(BASE_ID, "HOME", 1, "sha256:n", "sha256:m", "HOME", moved = 0, unchanged = 3)
        on.onSave()
        assertEquals(listOf("layouts", "save:HOME:save:sha256:h:null:3", "layouts"), repo.calls)
        assertEquals("HOME SAVED", model.state.value.local.notice)
    }
}
