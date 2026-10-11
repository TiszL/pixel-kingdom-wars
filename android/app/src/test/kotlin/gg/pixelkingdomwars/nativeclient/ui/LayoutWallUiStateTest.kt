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
class LayoutWallUiStateTest {
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


    @Test fun `UI reports authoritative owned inventory and server slots without invented third slot`() {
        val (_, model) = fixture(); model.open()
        val ui = model.state.value.wallUi
        assertEquals(1, ui.ownedWallCount); assertEquals(1, ui.placedWallCount); assertEquals(0, ui.trayedWallCount)
        assertEquals(listOf("HOME", "FARM"), ui.slotIds)
        assertNull(ui.proposal); assertNull(ui.tool)
    }
    @Test fun `UI reports pending affected count and unavailable blocked sample count distinctly`() {
        val (_, model) = fixture(); model.open(); model.setWallTool(LayoutWallTool.ERASE)
        val mode = model.state.value.wallStrokeMode!!
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(10, 12))))
        val ui = model.state.value.wallUi
        assertEquals(LayoutWallTool.ERASE, ui.tool); assertTrue(ui.requiresConfirmation)
        assertEquals(1, ui.proposal!!.affectedCount); assertEquals(1, ui.proposal!!.sampledCount)
        assertNull(ui.proposal!!.blockedCount)
        assertFalse(ui.canSave); assertEquals(1, ui.placedWallCount)
    }
    @Test fun `UI distinguishes changed owned positions and undo gestures from unsaved paint preview`() {
        val (_, model) = fixture(); model.open(); model.setWallTool(LayoutWallTool.ERASE)
        val mode = model.state.value.wallStrokeMode!!
        model.wallStroke(WallStrokeEvent.Preview(mode.token, listOf(WallStrokeTile(10, 12))))
        assertEquals(0, model.state.value.wallUi.changeCount)
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(10, 12)))); model.confirmWallStroke()
        assertEquals(1, model.state.value.wallUi.changeCount)
        assertEquals(1, model.state.value.wallUi.undoCount)
        assertEquals(1, model.state.value.wallUi.trayedWallCount)
        model.undo(); assertEquals(0, model.state.value.wallUi.changeCount)
    }
}
