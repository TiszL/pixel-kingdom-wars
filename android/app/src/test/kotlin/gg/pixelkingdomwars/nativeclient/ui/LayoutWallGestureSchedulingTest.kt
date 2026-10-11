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
import kotlinx.coroutines.test.*
import kotlinx.coroutines.flow.MutableStateFlow
import gg.pixelkingdomwars.nativeclient.network.RaidInterlockState
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class LayoutWallGestureSchedulingTest {
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


    @Test fun `queued preview clear and release still prepare the same admitted stroke`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val (_, model) = fixture(); runCurrent(); model.open(); runCurrent()
        model.selectBuilding("w1"); runCurrent(); model.moveSelectedToTray(); runCurrent(); model.selectTrayItem("w1"); runCurrent()
        val mode = model.state.value.wallStrokeMode!!
        val before = model.state.value.draft
        model.wallStroke(WallStrokeEvent.Preview(mode.token, listOf(WallStrokeTile(9, 9))))
        model.wallStroke(WallStrokeEvent.Preview(mode.token, emptyList()))
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(9, 9))))
        runCurrent()
        assertEquals(before, model.state.value.draft)
        assertNotNull(model.state.value.wallPending)
        model.confirmWallStroke(); runCurrent()
        assertEquals(9, model.state.value.draft!!.position("w1")!!.tx)
    }
    @Test fun `raid interlock published before combine drain refuses pending confirmation`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val repo = FakeBaseRepository().also { it._state.value = BaseState(base = base()); it.layouts = layouts(false) }
        val gate = MutableStateFlow(RaidInterlockState(null, known = true))
        val model = LayoutEditorViewModel(repo, FakeContentRepository(catalogue, render), ReceiptObserver(PendingIntentStore(MemoryStore())), actions, gate)
        runCurrent(); model.open(); runCurrent(); model.setWallTool(LayoutWallTool.ERASE); runCurrent()
        val mode = model.state.value.wallStrokeMode!!
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(10, 12)))); runCurrent()
        val before = model.state.value.draft
        gate.value = RaidInterlockState()
        model.confirmWallStroke(); runCurrent()
        assertEquals(before, model.state.value.draft); assertNull(model.state.value.wallPending)
        gate.value = RaidInterlockState(null, known = true); runCurrent(); model.confirmWallStroke(); runCurrent()
        assertEquals(before, model.state.value.draft)
    }
    @Test fun `missing content before combine drain refuses pending confirmation`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val repo = FakeBaseRepository().also { it._state.value = BaseState(base = base()); it.layouts = layouts(false) }
        val content = FakeContentRepository(catalogue, render)
        val model = LayoutEditorViewModel(repo, content, ReceiptObserver(PendingIntentStore(MemoryStore())), actions)
        runCurrent(); model.open(); runCurrent(); model.setWallTool(LayoutWallTool.ERASE); runCurrent()
        val mode = model.state.value.wallStrokeMode!!
        model.wallStroke(WallStrokeEvent.Released(mode.token, listOf(WallStrokeTile(10, 12)))); runCurrent()
        val before = model.state.value.draft
        content.set { it.copy(catalogue = null) }
        model.confirmWallStroke(); runCurrent()
        assertEquals(before, model.state.value.draft); assertNull(model.state.value.wallPending)
    }
}
