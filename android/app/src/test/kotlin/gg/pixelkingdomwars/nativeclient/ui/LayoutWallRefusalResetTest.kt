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
class LayoutWallRefusalResetTest {
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


    private fun refuseRunMove(model: LayoutEditorViewModel) {
        model.setWallTool(LayoutWallTool.SELECT)
        val mode = requireNotNull(model.state.value.wallStrokeMode)
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(10, 12))))
        val before = model.state.value.draft
        model.moveSelectedWallRun(100, 0)
        assertEquals(before, model.state.value.draft)
        assertNotNull("the failed local move has a visible refusal", model.state.value.wallUi.refusal)
    }

    @Test fun `a refusal from HOME does not follow the editor into FARM or back`() {
        val (repo, model) = fixture(); model.open(); refuseRunMove(model)
        val home = model.state.value.draft
        model.selectSlot("FARM")
        assertEquals("FARM", model.state.value.wallUi.activeSlot)
        assertNull(model.state.value.wallUi.refusal); assertNull(model.state.value.wallUi.notice)
        model.selectSlot("HOME")
        assertNull(model.state.value.wallUi.refusal)
        assertEquals(home, model.state.value.draft)
        assertEquals(listOf("layouts"), repo.calls)
    }

    @Test fun `choosing a new wall operation clears a refused stroke without consuming inventory`() {
        val operations: List<Pair<String, (LayoutEditorViewModel) -> Unit>> = listOf(
            "paint toggle" to { model: LayoutEditorViewModel -> model.toggleWallPaint(1) },
            "clear tool" to { model: LayoutEditorViewModel -> model.clearWallPaint() },
            "tray item" to { model: LayoutEditorViewModel -> model.selectTrayItem("w1") },
            "erase" to { model: LayoutEditorViewModel -> model.setWallTool(LayoutWallTool.ERASE) },
            "building" to { model: LayoutEditorViewModel -> model.selectBuilding("keep") },
        )
        for ((name, operation) in operations) {
            val (repo, model) = fixture(); model.open()
            model.selectBuilding("w1"); model.moveSelectedToTray(); model.selectTrayItem("w1")
            val mode = requireNotNull(model.state.value.wallStrokeMode)
            model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(-999, -999))))
            assertNotNull(model.state.value.wallUi.refusal)
            val before = requireNotNull(model.state.value.draft)
            operation(model)
            assertNull(name, model.state.value.wallUi.refusal)
            val after = requireNotNull(model.state.value.draft)
            assertEquals(name, before.positions, after.positions)
            assertEquals(name, before.trayIds, after.trayIds)
            assertEquals(name, before.history, after.history)
            assertEquals(listOf("layouts"), repo.calls)
        }
    }

    @Test fun `accepted save and apply retain success notice without the earlier move refusal`() {
        for (mode in listOf("save", "save_apply")) {
            val (repo, model) = fixture(); model.open(); refuseRunMove(model)
            val positions = model.state.value.draft!!.positions
            repo.saveResult = LayoutSaveResult(BASE_ID, "HOME", 1, "sha256:n", "sha256:m", "HOME", moved = 0, unchanged = 3)
            model.save(mode)
            assertNull(model.state.value.wallUi.refusal)
            assertEquals(if (mode == "save") "HOME SAVED" else "HOME APPLIED · 0 MOVED", model.state.value.wallUi.notice)
            assertNull(model.state.value.local.busy)
            assertEquals(positions, model.state.value.draft!!.positions)
            assertEquals(listOf("layouts", "save:HOME:$mode:sha256:h:${if (mode == "save") null else "sha256:a"}:3", "layouts"), repo.calls)
        }
    }

    @Test fun `a refreshed or replaced base layout retires the old draft refusal`() {
        val (repo, model) = fixture(); model.open(); refuseRunMove(model)
        model.reload()
        assertNull(model.state.value.wallUi.refusal)
        refuseRunMove(model)
        repo._state.value = repo._state.value.copy(base = base(keepX = 12))
        assertNull(model.state.value.wallUi.refusal)
        assertEquals("BASE CHANGED — DRAFTS RELOADED FROM THE LIVE BASE", model.state.value.wallUi.notice)
        assertEquals(12, model.state.value.draft!!.position("keep")!!.tx)
        assertEquals(listOf("layouts", "layouts"), repo.calls)
    }
}
