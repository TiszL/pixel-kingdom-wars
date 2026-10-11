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
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class LayoutEditorMountTest {
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
    private fun fixture(compatibility: String = "empty", farmLocked: Boolean = false): Pair<FakeBaseRepository, LayoutEditorViewModel> {
        val repo = FakeBaseRepository().also { it._state.value = BaseState(base = base()); it.layouts = layouts(farmLocked = farmLocked).let { value -> value.copy(slots = value.slots.map { slot -> slot.copy(compatibility = compatibility, positions = if (compatibility == "ready") base().buildings.map { LayoutPosition(it.id, it.tx, it.ty) } else emptyList()) }) } }
        return repo to LayoutEditorViewModel(repo, FakeContentRepository(catalogue, render), ReceiptObserver(PendingIntentStore(MemoryStore())), actions)
    }


    @Test fun `absent server data offers no compatibility write or FARM recovery`() {
        val ui = LayoutEditorState().layoutEditorCompatibilityUi()
        assertFalse(ui.showSavePreset); assertFalse(ui.canSavePreset); assertFalse(ui.canSaveApply)
        assertFalse(ui.showLockedFarm); assertFalse(ui.canOpenLockedFarm); assertFalse(ui.canEditBuildings)
    }

    @Test fun `empty and repair presets keep zero changes and get a secondary SAVE PRESET`() {
        for (compatibility in listOf("empty", "needs_repair")) {
            val (_, model) = fixture(compatibility); model.open()
            val state = model.state.value
            val kit = state.layoutEditorUi(null, false)
            val legacy = state.layoutEditorCompatibilityUi()
            assertTrue(state.draft!!.dirty); assertEquals(0, kit.changeCount)
            assertFalse(saveLook(kit.changeCount, kit.canSave, false, kit.saveState).sends)
            assertTrue(legacy.showSavePreset); assertTrue(legacy.canSavePreset)
        }
    }

    @Test fun `ready unchanged preset has no invented special save or positional changes`() {
        val (_, model) = fixture("ready"); model.open()
        assertFalse(model.state.value.draft!!.dirty)
        assertEquals(0, model.state.value.layoutEditorUi(null, false).changeCount)
        assertFalse(model.state.value.layoutEditorCompatibilityUi().showSavePreset)
        assertTrue(model.state.value.layoutEditorCompatibilityUi().canSaveApply)
    }

    @Test fun `positional edits use kit SAVE without duplicating SAVE PRESET`() {
        val (_, model) = fixture(); model.open(); model.selectBuilding("w1"); model.nudge(1, 0)
        val state = model.state.value; val kit = state.layoutEditorUi(null, false)
        assertEquals(1, kit.changeCount)
        assertTrue(saveLook(kit.changeCount, kit.canSave, false, kit.saveState).sends)
        assertFalse(state.layoutEditorCompatibilityUi().showSavePreset)
    }

    @Test fun `SAVE PRESET sends only the existing save with its slot ETag then refreshes`() {
        val (repo, model) = fixture(); model.open()
        repo.saveResult = LayoutSaveResult(BASE_ID, "HOME", 1, "sha256:n", "sha256:m", "HOME", moved = 0, unchanged = 3)
        layoutEditorCompatibilityActions(model).onSavePreset()
        assertEquals(listOf("layouts", "save:HOME:save:sha256:h:null:3", "layouts"), repo.calls)
        assertEquals("HOME SAVED", model.state.value.local.notice)
    }

    @Test fun `retained SAVE AND APPLY carries both slot and active ETags`() {
        val (repo, model) = fixture("ready"); model.open()
        repo.saveResult = LayoutSaveResult(BASE_ID, "HOME", 1, "sha256:n", "sha256:m", "HOME", moved = 0, unchanged = 3)
        layoutEditorCompatibilityActions(model).onSaveApply()
        assertEquals(listOf("layouts", "save:HOME:save_apply:sha256:h:sha256:a:3", "layouts"), repo.calls)
    }

    @Test fun `stored buildings and missing Keep refuse both compatibility writes`() {
        for (building in listOf("w1", "keep")) {
            val (repo, model) = fixture(); model.open(); model.selectBuilding(building); model.moveSelectedToTray()
            val on = layoutEditorCompatibilityActions(model)
            assertFalse(model.state.value.layoutEditorCompatibilityUi().canSavePreset)
            assertFalse(model.state.value.layoutEditorCompatibilityUi().canSaveApply)
            on.onSavePreset(); on.onSaveApply()
            assertEquals(listOf("layouts"), repo.calls)
        }
    }

    @Test fun `paused busy discard and deed refusal project all compatibility edits as unavailable`() {
        val (_, model) = fixture(); model.open(); val state = model.state.value
        val blocked = listOf(
            state.copy(local = state.local.copy(wallInputPaused = true)),
            state.copy(local = state.local.copy(busy = "save")),
            state.copy(local = state.local.copy(discardOpen = true)),
            state.copy(deedActionsAllowed = false),
            state.copy(local = state.local.copy(open = false)),
        )
        blocked.forEach { value ->
            val ui = value.layoutEditorCompatibilityUi()
            assertFalse(ui.canSavePreset); assertFalse(ui.canSaveApply)
            assertFalse(ui.canEditBuildings); assertFalse(ui.canOpenLockedFarm)
        }
    }

    @Test fun `pause fences old compatibility callbacks before derived state drains`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val (repo, model) = fixture(farmLocked = true); runCurrent(); model.open(); runCurrent()
        val on = layoutEditorCompatibilityActions(model)
        model.pauseWallInput()
        val draft = model.currentEditorState().draft
        on.onSavePreset(); on.onSaveApply(); on.onLockedFarm(); on.onPickUpAll()
        on.onNudge(1, 0); on.onMoveToTray(); on.onTrayItem("w1")
        runCurrent()
        assertEquals("HOME", model.state.value.slot); assertEquals(draft, model.state.value.draft)
        assertEquals(listOf("layouts"), repo.calls)
    }

    @Test fun `released proposal fences footer writes recovery and tools before state drains`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val (repo, model) = fixture(farmLocked = true); runCurrent(); model.open(); runCurrent()
        model.selectBuilding("w1"); model.moveSelectedToTray(); model.selectTrayItem("w1"); runCurrent()
        val on = layoutEditorCompatibilityActions(model)
        val mode = model.state.value.wallStrokeMode!!
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(9, 9))))
        val pending = model.currentEditorState().wallPending
        on.onSavePreset(); on.onSaveApply(); on.onLockedFarm(); on.onPickUpAll(); on.onTrayItem("w1")
        runCurrent()
        assertNotNull(pending); assertEquals(pending, model.state.value.wallPending)
        assertEquals("HOME", model.state.value.slot); assertEquals(listOf("layouts"), repo.calls)
    }

    @Test fun `locked FARM recovery selects only the offered slot and never purchases`() {
        val (repo, model) = fixture(farmLocked = true); model.open()
        val on = layoutEditorCompatibilityActions(model)
        assertFalse(model.state.value.layoutEditorUi(null, false).slots.single { it.id == "FARM" }.enabled)
        assertTrue(model.state.value.layoutEditorCompatibilityUi().canOpenLockedFarm)
        on.onLockedFarm()
        assertEquals("FARM", model.state.value.slot); assertTrue(model.state.value.locked)
        assertFalse(model.state.value.layoutEditorCompatibilityUi().canSaveApply)
        assertEquals(listOf("layouts"), repo.calls)
        layoutEditorActions(model, {}, {}).onSlot("HOME")
        assertEquals("HOME", model.state.value.slot)
    }

    @Test fun `absent and unlocked FARM do not offer locked recovery`() {
        val (repo, model) = fixture(); model.open()
        assertFalse(model.state.value.layoutEditorCompatibilityUi().showLockedFarm)
        layoutEditorCompatibilityActions(model).onLockedFarm()
        assertEquals("HOME", model.state.value.slot)
        val state = model.state.value
        val noFarm = state.copy(home = state.home.copy(layouts = state.layouts!!.copy(slots = state.layouts!!.slots.filter { it.slot == "HOME" })))
        assertFalse(noFarm.layoutEditorCompatibilityUi().showLockedFarm)
        assertEquals(listOf("layouts"), repo.calls)
    }

    @Test fun `building nudge tray placement and pickup all remain local and Keep refusal survives`() {
        val (repo, model) = fixture(); model.open(); model.selectBuilding("cannon")
        val on = layoutEditorCompatibilityActions(model)
        on.onNudge(1, 0); assertEquals(11, model.state.value.draft!!.position("cannon")!!.tx)
        on.onMoveToTray(); assertTrue(model.state.value.selectedInTray)
        on.onTrayItem("cannon"); model.tapTile(11f, 10f)
        assertFalse(model.state.value.draft!!.inTray("cannon"))
        on.onPickUpAll(); assertFalse(model.state.value.keepPlaced)
        assertTrue(model.state.value.draft!!.inTray("keep"))
        on.onSavePreset(); on.onSaveApply(); assertEquals(listOf("layouts"), repo.calls)
    }

    @Test fun `kit close opens one discard flow and compatibility callbacks refuse until resolved`() {
        val (repo, model) = fixture(); model.open()
        val kit = layoutEditorActions(model, {}, {}); val legacy = layoutEditorCompatibilityActions(model)
        kit.onClose(); assertTrue(model.state.value.local.discardOpen)
        legacy.onSavePreset(); legacy.onSaveApply(); legacy.onPickUpAll()
        assertEquals(listOf("layouts"), repo.calls)
        kit.onCancelDiscard(); assertTrue(model.state.value.open); assertFalse(model.state.value.local.discardOpen)
        kit.onClose(); kit.onConfirmDiscard(); assertFalse(model.state.value.open)
        assertEquals(listOf("layouts"), repo.calls)
    }

    @Test fun `short landscape reserves a side panel and keeps a usable fit rectangle`() {
        val safe = CameraInsets(left = 24, top = 24, right = 24, bottom = 24)
        val insets = layoutEditorCameraInsets(safe, kitTop = 122, kitBottom = 101, statusHeight = 24,
            panel = androidx.compose.ui.unit.IntSize(280, 360), sidePanel = true)
        val visible = insets.visible(800, 360)
        assertNotNull("Expanded building tools must not remove the camera-fit rectangle", visible)
        assertTrue(visible!!.width >= 400); assertTrue(visible.height >= 48)
        assertTrue(visible.left >= safe.left + 280)
    }

    @Test fun `portrait fit clears measured two line notices status and bottom compatibility panel`() {
        val safe = CameraInsets(top = 24, bottom = 24)
        val insets = layoutEditorCameraInsets(safe, kitTop = 122, kitBottom = 101, statusHeight = 36,
            panel = androidx.compose.ui.unit.IntSize(400, 240), sidePanel = false)
        val visible = insets.visible(400, 800)
        assertNotNull(visible)
        assertTrue(visible!!.top >= 24 + 122 + 36)
        assertTrue(visible.bottom <= 800 - 24 - 101 - 240)
        assertTrue(visible.height >= 200)
    }

    @Test fun `narrow landscape keeps full canvas width instead of clipping kit and building controls`() {
        assertNull(layoutEditorSidePanelWidth(widthDp = 480f, horizontalInsetDp = 0f, short = true))
        assertNull(layoutEditorSidePanelWidth(widthDp = 600f, horizontalInsetDp = 48f, short = true))
        assertNull(layoutEditorSidePanelWidth(widthDp = 800f, horizontalInsetDp = 0f, short = false))
    }

    @Test fun `side panel width leaves safe space for all four nudge buttons and the kit strip`() {
        for ((width, safe) in listOf(550f to 0f, 600f to 0f, 700f to 48f, 800f to 48f)) {
            val panel = layoutEditorSidePanelWidth(widthDp = width, horizontalInsetDp = safe, short = true)
            assertNotNull(panel)
            assertTrue("Four 48dp nudge controls, gaps and padding must fit", panel!! - safe >= 224f)
            assertTrue("Four kit tools and SAVE must fit", width - panel - safe >= 326f)
        }
    }

    @Test fun `kit SAVE retains the ruled save-only mode while explicit apply stays separate`() {
        val (repo, model) = fixture("ready"); model.open(); model.selectBuilding("w1"); model.nudge(1, 0)
        repo.saveResult = LayoutSaveResult(BASE_ID, "HOME", 1, "sha256:n", "sha256:m", "HOME", moved = 0, unchanged = 3)
        layoutEditorActions(model, {}, {}).onSave()
        assertEquals(listOf("save:HOME:save:sha256:h:null:3"), repo.calls.filter { it.startsWith("save:") })
    }

    @Test fun `discard wording covers repair drafts without claiming zero lost changes`() {
        val (_, model) = fixture(); model.open(); model.close()
        assertTrue(model.state.value.local.discardOpen)
        val ui = model.state.value.layoutEditorUi(null, false)
        assertEquals("Unsaved layout drafts will be discarded. Your saved layouts stay as they were.", ui.discardMessage)
        assertFalse(ui.discardMessage!!.contains("0 changes"))
    }

    @Test fun `closing from locked FARM preserves the dirty HOME draft behind one confirmation`() {
        val (_, model) = fixture("ready", farmLocked = true); model.open()
        model.selectBuilding("w1"); model.nudge(1, 0); model.selectSlot("FARM"); model.close()
        assertTrue(model.state.value.open); assertTrue(model.state.value.local.discardOpen)
        assertEquals(11, model.state.value.local.drafts.getValue("HOME").position("w1")!!.tx)
        model.cancelDiscard(); assertTrue(model.state.value.open)
    }

    @Test fun `ERASE and SELECT fallback taps cannot select or move a building`() {
        for (tool in listOf(LayoutWallTool.ERASE, LayoutWallTool.SELECT)) {
            val (repo, model) = fixture("ready"); model.open(); model.setWallTool(tool)
            val before = model.state.value.draft
            model.tapTile(10f, 10f); model.tapTile(12f, 10f)
            assertEquals(before, model.state.value.draft)
            assertEquals(tool, model.state.value.local.wallTool)
            assertEquals(listOf("layouts"), repo.calls)
        }
    }

    @Test fun `BUILD more opens immediately from a clean editor and never writes`() {
        val (repo, model) = fixture("ready"); model.open(); var opened = 0
        val exit = LayoutBuildExit(model) { opened++ }
        exit.request(); assertFalse(model.state.value.open); assertEquals(1, opened)
        assertEquals(listOf("layouts"), repo.calls)
    }

    @Test fun `BUILD more waits for explicit discard and opens once`() {
        val (repo, model) = fixture("ready"); model.open(); model.selectBuilding("w1"); model.nudge(1, 0); var opened = 0
        val exit = LayoutBuildExit(model) { opened++ }
        exit.request(); assertTrue(model.state.value.local.discardOpen); assertEquals(0, opened)
        exit.confirmDiscard(); exit.confirmDiscard()
        assertFalse(model.state.value.open); assertEquals(1, opened); assertEquals(listOf("layouts"), repo.calls)
    }

    @Test fun `cancelling BUILD discard removes the navigation intent`() {
        val (_, model) = fixture(); model.open(); var opened = 0
        val exit = LayoutBuildExit(model) { opened++ }
        exit.request(); exit.cancelDiscard(); model.close(); exit.confirmDiscard()
        assertFalse(model.state.value.open); assertEquals(0, opened)
    }

    @Test fun `host disposal drops BUILD navigation without discarding the local draft`() {
        val (_, model) = fixture(); model.open(); var opened = 0
        val exit = LayoutBuildExit(model) { opened++ }
        exit.request(); exit.clear(); assertTrue(model.state.value.open)
        exit.confirmDiscard(); assertEquals(0, opened)
    }

    @Test fun `Home routes editor strokes and lifecycle while preserving ordinary BUILD sampler`() {
        fun source(path: String) = listOf(File("src/main/kotlin/gg/pixelkingdomwars/nativeclient", path), File("app/src/main/kotlin/gg/pixelkingdomwars/nativeclient", path)).first { it.isFile }.readText()
        val home = source("ui/kingdom/KingdomScreen.kt")
        // The ordinary drawing now comes through homeWallStroke (2026-10-06: the same rule for landless kingdoms).
        assertTrue(home.contains("wallStroke = if (editing) editor.wallStrokeMode else homeWallStroke(state, wallState, editing, busy)"))
        assertTrue(home.contains("onWallStroke = { if (editing) layout.wallStroke(it) else model.wallStroke(it) }"))
        assertTrue(home.contains("layout.resumeWallInput()")); assertTrue(home.contains("layout.pauseWallInput()"))
        assertTrue(home.contains("onBuildMore = { model.openBuildMenu() }"))
        val host = source("ui/layout/LayoutEditorScreen.kt")
        assertTrue(host.contains("LayoutEditor(ui, on,")); assertFalse(host.contains("LayoutEditorHead("))
        assertTrue(host.contains("buildExit::cancelDiscard"))
    }

}
