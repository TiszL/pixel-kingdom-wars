package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.LayoutSaveResult
import gg.pixelkingdomwars.nativeclient.model.Layouts
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.objects
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ops.PendingIntentStore
import gg.pixelkingdomwars.nativeclient.ops.ReceiptObserver
import gg.pixelkingdomwars.nativeclient.renderer.HighlightColors
import gg.pixelkingdomwars.nativeclient.renderer.SceneHighlightKind
import gg.pixelkingdomwars.nativeclient.ui.layout.LayoutEditorViewModel
import gg.pixelkingdomwars.nativeclient.ui.layout.layoutErrorCopy
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

/** The layout editor edits a reversible draft over the live base and saves it with the server's ETags;
 * CANCEL sends nothing, a dirty draft asks first, and a changed base reloads the drafts. */
@OptIn(ExperimentalCoroutinesApi::class)
class LayoutEditorViewModelTest {
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
        val repo = FakeBaseRepository().also { it._state.value = BaseState(base = base()); it.layouts = layouts() }
        return repo to LayoutEditorViewModel(repo, FakeContentRepository(catalogue, render), ReceiptObserver(PendingIntentStore(MemoryStore())), actions)
    }

    @Test fun `plot or claim changes invalidate draft shape without moving building identities`() {
        val old=base();val changed=old.copy(plotVersion=2,claim=gg.pixelkingdomwars.nativeclient.model.Claim(-10,40))
        assertNotEquals(gg.pixelkingdomwars.nativeclient.ui.layout.baseShapeKey(old),gg.pixelkingdomwars.nativeclient.ui.layout.baseShapeKey(changed))
        assertEquals(old.buildings,changed.buildings)
    }
    @Test fun `opening reads the server layouts and drafts every unlocked slot from the live base`() {
        val (repo, model) = fixture()
        model.open()
        assertEquals(listOf("layouts"), repo.calls); assertTrue(model.state.value.open)
        assertEquals("Only HOME is drafted while FARM is locked", setOf("HOME"), model.state.value.local.drafts.keys)
        assertEquals(3, model.state.value.draft!!.positions.size); assertTrue("An empty slot starts dirty from the live base", model.state.value.draft!!.dirty)
        assertTrue(model.state.value.keepPlaced)
        assertTrue("Job scaffolds are suppressed in the draft scene", model.state.value.draftBase!!.objects("jobs").isEmpty())
        model.selectSlot("FARM"); assertTrue(model.state.value.locked); assertTrue(model.state.value.saveDisabled)
    }
    @Test fun `taps select a covered building or move the selection and refuse an invalid tile`() {
        val (_, model) = fixture(); model.open()
        model.tapTile(10.4f, 10.6f); assertEquals("cannon", model.state.value.selected!!.id)
        model.tapTile(12.5f, 10.5f)
        assertEquals("A 1×1 building lands on the tile under the tap", 12 to 10, model.state.value.draft!!.position("cannon")!!.let { it.tx to it.ty })
        // The scene shows the plot grid for the whole edit, then the moved footprint in the draft's own validity colour.
        val (grid, footprint) = model.state.value.highlights.filter { it.kind != SceneHighlightKind.FILL }.also { assertEquals(2, it.size) }
        assertEquals(SceneHighlightKind.GRID_OVERLAY, grid.kind); assertEquals(8f to 8f, grid.tileX to grid.tileY); assertEquals(14f to 14f, grid.width to grid.height)
        assertEquals(12f to 10f, footprint.tileX to footprint.tileY); assertEquals(SceneHighlightKind.FOOTPRINT_OVERLAY, footprint.kind)
        assertEquals("A tile the draft accepted is green, never neutral gold", HighlightColors.VALID, footprint.color)
        assertEquals("12", model.state.value.draftBase!!.objects("buildings").first { it.string("id") == "cannon" }.string("tx"))
        model.tapTile(18.5f, 18.5f); assertEquals("AN OBSTACLE BLOCKS THOSE TILES", model.state.value.local.notice)
        model.tapTile(14.9f, 14.9f); assertEquals("keep", model.state.value.selected!!.id)
        model.tapTile(30f, 30f); assertEquals("OUTSIDE THE ACTIVE CLAIM", model.state.value.local.notice)
        model.nudge(1, 0); assertEquals(15, model.state.value.draft!!.position("keep")!!.tx)
        model.undo(); assertEquals(14, model.state.value.draft!!.position("keep")!!.tx)
    }
    @Test fun `grid is cached within the immutable editor state and removed when editing closes`() {
        val (_, model) = fixture(); assertTrue(model.state.value.highlights.isEmpty())
        model.open()
        val before = model.state.value.highlights
        assertSame("Recomposition must not rebuild occupancy", before, model.state.value.highlights)
        model.selectBuilding("w1"); model.moveSelectedToTray()
        val after = model.state.value.highlights
        assertEquals(HighlightColors.BLOCKED, before.single { it.kind == SceneHighlightKind.FILL && it.tileX == 10f && it.tileY == 12f }.color)
        assertEquals(HighlightColors.VALID, after.single { it.kind == SceneHighlightKind.FILL && it.tileX == 10f && it.tileY == 12f }.color)
        assertSame(after, model.state.value.highlights)
        model.confirmDiscard(); assertTrue(model.state.value.highlights.isEmpty())
    }
    @Test fun `tray paint and save gating follow the web rules and the save carries the etags read`() {
        val (repo, model) = fixture(); model.open()
        model.selectBuilding("w1"); model.moveSelectedToTray()
        assertTrue(model.state.value.selectedInTray); assertTrue(model.state.value.saveDisabled)
        assertEquals("A trayed selection has no footprint on the plot; the grid alone stays up for the next tap", listOf(SceneHighlightKind.GRID_OVERLAY), model.state.value.highlights.filter { it.kind != SceneHighlightKind.FILL }.map { it.kind })
        assertEquals(mapOf(1 to listOf("w1")), model.state.value.trayedWallGroups)
        model.toggleWallPaint(1); assertEquals(1, model.state.value.local.wallPaintLevel)
        model.tapTile(9.5f, 9.5f)
        assertEquals(9 to 9, model.state.value.draft!!.position("w1")!!.let { it.tx to it.ty }); assertTrue(model.state.value.draft!!.trayIds.isEmpty())
        assertNull("The paint level clears once its walls are consumed", model.state.value.trayedWallGroups[1])
        model.clearWallPaint(); assertFalse(model.state.value.saveDisabled)
        repo.saveResult = LayoutSaveResult.from(json("""{"baseId":"$BASE_ID","slot":"HOME","geometryVersion":1,"slotEtag":"sha256:n","activeEtag":"sha256:m","activeSlot":"HOME","moved":1,"unchanged":2,"replayed":false}"""))
        model.save("save_apply")
        assertEquals("save:HOME:save_apply:sha256:h:sha256:a:3", repo.calls.first { it.startsWith("save:") })
        assertEquals("HOME APPLIED · 1 MOVED", model.state.value.local.notice); assertNull(model.state.value.local.busy)
        model.selectBuilding("keep"); model.moveSelectedToTray(); model.save("save")
        assertEquals("PLACE THE KEEP BEFORE SAVING", model.state.value.local.notice); assertEquals(1, repo.calls.count { it.startsWith("save:") })
    }
    @Test fun `cancel sends nothing a dirty draft asks first and a changed base reloads the drafts`() {
        val (repo, model) = fixture(); model.open()
        model.close(); assertTrue("An empty slot's draft is dirty, so Back asks first", model.state.value.local.discardOpen); assertTrue(model.state.value.open)
        model.cancelDiscard(); assertFalse(model.state.value.local.discardOpen)
        model.confirmDiscard(); assertFalse(model.state.value.open); assertTrue(repo.calls.none { it.startsWith("save") })
        model.open(); model.selectBuilding("cannon"); model.nudge(0, 1)
        repo._state.value = repo._state.value.copy(base = base(keepX = 12))
        assertEquals("BASE CHANGED — DRAFTS RELOADED FROM THE LIVE BASE", model.state.value.local.notice)
        assertEquals("The draft restarted from the changed live base", 10, model.state.value.draft!!.position("cannon")!!.ty)
    }
    @Test fun `server refusals speak in the editor's voice and a stale save reloads the server copy`() {
        assertEquals("THIS LAYOUT CHANGED ELSEWHERE — THE SERVER COPY WAS RELOADED", layoutErrorCopy(ApiException(409, "LAYOUT_STALE", "saved layout changed")))
        assertEquals("UNLOCK BASE BEFORE SAVING IT", layoutErrorCopy(ApiException(403, "LAYOUT_SLOT_LOCKED", "unlock")))
        assertEquals("NOT ENOUGH BASE SHARDS TO UNLOCK BASE", layoutErrorCopy(ApiException(422, "INSUFFICIENT_SHARDS", "costs 500")))
        assertEquals("LAYOUT BUILDINGS OVERLAP", layoutErrorCopy(ApiException(422, "LAYOUT_INVALID", "layout buildings overlap")))
        assertEquals("CONNECTION RESET", layoutErrorCopy(java.io.IOException("connection reset")))
        val (repo, model) = fixture(); model.open()
        repo.failWith = ApiException(409, "LAYOUT_STALE", "saved layout changed — refresh before saving")
        model.save("save")
        assertEquals("THIS LAYOUT CHANGED ELSEWHERE — THE SERVER COPY WAS RELOADED", model.state.value.local.notice)
        repo.failWith = null
        model.unlock(); assertEquals("BASE UNLOCKED · 500 SHARDS", model.state.value.local.notice)
        repo.unlockResult = gg.pixelkingdomwars.nativeclient.ops.LayoutUnlockAcceptance("0", "3020"); model.unlock(); assertEquals("BASE WAS ALREADY UNLOCKED", model.state.value.local.notice)
    }
    @Test fun `raid uncertainty locks layout save and slot purchases while preserving the reversible draft`() {
        val repo = FakeBaseRepository().also { it._state.value = BaseState(base = base()); it.layouts = layouts() }
        val interlock = kotlinx.coroutines.flow.MutableStateFlow(gg.pixelkingdomwars.nativeclient.network.RaidInterlockState())
        val model = LayoutEditorViewModel(repo, FakeContentRepository(catalogue, render), ReceiptObserver(PendingIntentStore(MemoryStore())), actions, interlock)
        model.open(); model.selectBuilding("cannon"); model.nudge(0, 1)
        val draft = model.state.value.draft
        for (lock in listOf(gg.pixelkingdomwars.nativeclient.network.RaidInterlockState(),
                gg.pixelkingdomwars.nativeclient.network.RaidInterlockState(gg.pixelkingdomwars.nativeclient.model.ActiveBaseRaid("6b993df1-1af2-41b4-9a65-638428c388a3", "live"), known = true))) {
            interlock.value = lock
            assertTrue(model.state.value.saveDisabled)
            model.save("save_apply"); model.unlock()
            assertEquals("No layout write or paid unlock while the deed is unavailable", listOf("layouts"), repo.calls)
            assertEquals("Reconnecting must not discard the player's unsent changes", draft, model.state.value.draft)
        }
        interlock.value = gg.pixelkingdomwars.nativeclient.network.RaidInterlockState(null, known = true)
        assertFalse(model.state.value.saveDisabled)
        model.unlock(); assertTrue(repo.calls.contains("unlock"))
    }

}
