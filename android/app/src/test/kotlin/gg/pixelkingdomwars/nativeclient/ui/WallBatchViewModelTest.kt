package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.WallBatchTerms
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeEvent
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeTile
import gg.pixelkingdomwars.nativeclient.scene.wallStrokeMode
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomViewModel
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
class WallBatchViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private fun model(f: WallBatchFixture, base: FakeBaseRepository = FakeBaseRepository()): KingdomViewModel {
        base._state.value = BaseState(base = BaseSnapshot.from(f.snapshot))
        return KingdomViewModel(base, FakeContentRepository(f.catalogue), f.observer, InterruptedActions({}, {}, {}), 1,
            wallet = WALLET, wallBatch = f.repo)
    }
    private suspend fun prepare(model: KingdomViewModel, f: WallBatchFixture): String {
        model.startPlacement("wall"); f.repo.state.first { it.drawing != null && !it.busy }
        model.busy.first { !it }; model.state.first { it.placement?.type == "wall" }
        return f.repo.state.value.drawing!!.mode.token
    }
    @Test fun `Build walls opens drawing and ordinary ground taps cannot bypass the atomic v1 route`() = runTest {
        val f = WallBatchFixture(); val base = FakeBaseRepository(); val model = model(f, base); prepare(model, f)
        model.tapGround(8f, 8f); model.pickTile(8f, 8f); model.confirmPlacement(); model.busy.first { !it }
        assertTrue(f.posts.isEmpty()); assertTrue(base.calls.none { it.startsWith("place:") }); assertNull(f.saved())
        assertNotNull(f.repo.state.value.drawing)
    }
    @Test fun `renderer preview and release route a whole stroke once and clear local drawing after accepted hydration`() = runTest {
        val f = WallBatchFixture(); val model = model(f); val token = prepare(model, f)
        model.wallStroke(WallStrokeEvent.Preview(token, f.tiles)); assertEquals(f.tiles, f.repo.state.value.preview)
        model.wallStroke(WallStrokeEvent.Released(token, f.tiles)); model.busy.first { !it }
        model.state.first { it.placement == null }; assertNull(model.notice.value)
        assertEquals(1, f.posts.size); assertNull(f.saved()); assertNotNull(f.repo.state.value.receipt)
        model.wallStroke(WallStrokeEvent.Released(token, f.tiles)); assertEquals(1, f.posts.size)
    }
    @Test fun `Back pause layout entry and opening another build surface revoke queued release callbacks`() = runTest {
        for (close in 0..3) {
            val f = WallBatchFixture(); val model = model(f); val token = prepare(model, f)
            when (close) { 0 -> model.cancelPlacement(); 1 -> model.dismissWallDrawing(); 2 -> model.closeSurfaces(); else -> model.openBuildMenu() }
            model.wallStroke(WallStrokeEvent.Released(token, f.tiles)); assertTrue(f.posts.isEmpty()); assertNull(f.saved())
            assertNull(f.repo.state.value.drawing)
        }
    }
    @Test fun `fresh geometry changes invalidate painted placement but leave existing layout relocation separate`() = runTest {
        val f = WallBatchFixture(); val base = FakeBaseRepository(); val model = model(f, base); val token = prepare(model, f)
        base._state.value = base._state.value.copy(base = BaseSnapshot.from(JsonObject(f.snapshot + ("obstacles" to Json.parseToJsonElement("""[{"id":"arrived","spriteKey":"rock","tx":8,"ty":8}]""")))))
        model.state.first { it.base?.obstacles?.isNotEmpty() == true }; model.checkWallDrawingGeometry()
        model.wallStroke(WallStrokeEvent.Released(token, f.tiles)); assertNull(f.repo.state.value.drawing); assertTrue(f.posts.isEmpty())
    }
    @Test fun `release during a background refresh cancels visibly rather than leaving a consumed input lease stuck`() = runTest {
        val f = WallBatchFixture(); val model = model(f); val token = prepare(model, f)
        val entered = CompletableDeferred<Unit>(); val wait = CompletableDeferred<Unit>()
        f.beforeGet = { if (it.startsWith("/base/walls/batch")) { entered.complete(Unit); wait.await() } }
        val refresh = model.refreshWallBatch(); entered.await()
        model.wallStroke(WallStrokeEvent.Released(token, f.tiles)); assertNull(f.repo.state.value.drawing)
        wait.complete(Unit); refresh?.join(); assertTrue(f.posts.isEmpty()); assertNotNull(model.notice.value)
    }
    @Test fun `foreground remount observes a lost wall response without replaying it or opening drawing`() = runTest {
        val f = WallBatchFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        try { f.build() } catch (_: IOException) { }
        val restored = WallBatchFixture(f.disk); val model = model(restored)
        repeat(3) { model.refreshConstructionReceipts()?.join() }
        assertTrue(restored.posts.isEmpty()); assertEquals(f.saved(), restored.saved()); assertNull(restored.repo.state.value.drawing)
    }
    @Test fun `pause during final network preflight refuses a queued release before storage or POST`() = runTest {
        val f = WallBatchFixture(); val model = model(f); val token = prepare(model, f)
        val entered = CompletableDeferred<Unit>(); val wait = CompletableDeferred<Unit>()
        f.onAccount = { entered.complete(Unit); wait.await() }
        model.wallStroke(WallStrokeEvent.Released(token, f.tiles)); entered.await(); model.dismissWallDrawing()
        wait.complete(Unit); model.busy.first { !it }; assertTrue(f.posts.isEmpty()); assertNull(f.saved())
    }
    @Test fun `canonical current pack alone supplies cost total cap plot and collision footprints`() {
        val catalogue = Json.parseToJsonElement(File("src/main/assets/native/catalogue.json").readText()).jsonObject
        val render = Json.parseToJsonElement(File("src/main/assets/native/render-catalog.json").readText()).jsonObject
        val terms = WallBatchTerms.from(catalogue); val constants = catalogue.getValue("constants").jsonObject
        assertEquals(constants.getValue("BUILD_COSTS").jsonObject.getValue("wall").jsonObject.getValue("costShards").jsonPrimitive.content, terms.unitCostShards)
        assertEquals(constants.getValue("BUILD_COUNT_CAP_BY_KEEP").jsonObject.getValue("wall").jsonArray.last().jsonPrimitive.int, terms.maxTiles)
        assertEquals(constants.getValue("GRID").jsonObject.getValue("plotTiles").jsonPrimitive.int, terms.plotTiles)
        val mode = wallStrokeMode("pack", BaseSnapshot.from(baseJson()), terms, catalogue, render)
        assertTrue(mode.validTiles.isNotEmpty()); assertFalse(WallStrokeTile(14, 14) in mode.validTiles)
        assertFalse(WallStrokeTile(7, 8) in mode.validTiles); assertFalse(WallStrokeTile(22, 8) in mode.validTiles)
    }
    @Test fun `paint geometry respects actual unfinished building and authored obstacle rectangles without layout tray omissions`() {
        val f = WallBatchFixture(); val raw = JsonObject(f.snapshot + mapOf(
            "buildings" to Json.parseToJsonElement("""[{"id":"unfinished","type":"tower","level":1,"tx":9,"ty":9,"underConstruction":true}]"""),
            "obstacles" to Json.parseToJsonElement("""[{"id":"rock","spriteKey":"boulder","tx":17,"ty":18}]""")))
        val render = json("""{"entries":[{"type":"tower","level":1,"footprintWidth":2,"footprintHeight":3}],"basePresentation":{"obstacles":{"boulder":{"footprintWidth":2}}}}""")
        val mode = wallStrokeMode("geometry", BaseSnapshot.from(raw), WallBatchTerms.from(f.catalogue), f.catalogue, render)
        for (y in 9..11) for (x in 9..10) assertFalse(WallStrokeTile(x, y) in mode.validTiles)
        for (y in 18..19) for (x in 17..18) assertFalse(WallStrokeTile(x, y) in mode.validTiles)
        assertTrue(WallStrokeTile(11, 9) in mode.validTiles); assertTrue(WallStrokeTile(19, 18) in mode.validTiles)
    }
}
