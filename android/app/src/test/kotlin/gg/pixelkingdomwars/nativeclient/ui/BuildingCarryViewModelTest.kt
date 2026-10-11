package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.renderer.BuildingCarryInput
import gg.pixelkingdomwars.nativeclient.renderer.CarryEvent
import gg.pixelkingdomwars.nativeclient.renderer.CarryPiece
import gg.pixelkingdomwars.nativeclient.renderer.CarryRect
import gg.pixelkingdomwars.nativeclient.renderer.CarryTile
import gg.pixelkingdomwars.nativeclient.model.WallBatchTerms
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeMode
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeTile
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomViewModel
import gg.pixelkingdomwars.nativeclient.ui.kingdom.PlacementDraft
import gg.pixelkingdomwars.nativeclient.ui.kingdom.carryOwnsMap
import gg.pixelkingdomwars.nativeclient.ui.kingdom.homeCarryMode
import gg.pixelkingdomwars.nativeclient.ui.kingdom.homeWallDrawingAllowed
import gg.pixelkingdomwars.nativeclient.ui.kingdom.homeWallStroke
import gg.pixelkingdomwars.nativeclient.ui.kingdom.selectionChromeShown
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

/** The Kingdom screen's hold-to-lift admission and what a release posts (web `Overlay` 'base:move' / 'base:moveLine'). */
@OptIn(ExperimentalCoroutinesApi::class)
class BuildingCarryViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private fun file(path: String) = Json.parseToJsonElement(File(path).readText()).jsonObject
    private val catalogue = file("src/main/assets/native/catalogue.json")
    private val render = file("src/main/assets/native/render-catalog.json")
    private val W1 = "11111111-1111-4111-8111-111111111111"; private val W2 = "22222222-2222-4222-8222-222222222222"; private val W3 = "33333333-3333-4333-8333-333333333333"
    private fun base() = BaseSnapshot.from(json("""{"baseId":"$BASE_ID","player":{"wallet":"$WALLET","name":"","keepLevel":3,"trophies":0,"league":"bronze","builders":1,"expansions":0},
        "energy":{"used":0,"free":6,"max":6},"claim":{"min":8,"max":22},
        "buildings":[{"id":"keep","type":"keep","level":1,"tx":14,"ty":14,"underConstruction":false},{"id":"$W1","type":"wall","level":1,"tx":10,"ty":12,"underConstruction":false},
        {"id":"$W2","type":"wall","level":1,"tx":11,"ty":12,"underConstruction":false},{"id":"$W3","type":"wall","level":2,"tx":10,"ty":13,"underConstruction":false}],
        "obstacles":[{"id":"rock","spriteKey":"boulder","tx":18,"ty":18}],"jobs":[],"freeBuilders":1}"""))
    private fun repo() = FakeBaseRepository().also { it._state.value = BaseState(base = base()) }
    /** The model's own `init { refresh() }` records reads first; only the carry's orders matter here. */
    private fun FakeBaseRepository.moves() = calls.filter { it.startsWith("move") }
    private fun model(repo: FakeBaseRepository = repo()) =
        KingdomViewModel(repo, FakeContentRepository(catalogue, render), ReceiptObserver(PendingIntentStore(MemoryStore())), InterruptedActions({}, {}, {}), versionCode = 1, wallet = WALLET)

    @Test fun `every owned building is movable the selected row is the line and obstacles block without an id`() {
        val model = model()
        val mode = requireNotNull(model.state.value.carryMode)
        assertEquals(BASE_ID, mode.baseId); assertEquals(8 to 22, mode.plotMin to mode.plotMax)
        assertEquals("Walls and the Keep carry like the web", setOf("keep", W1, W2, W3), mode.movableIds)
        assertTrue("No wall row selected: a wall carries alone", mode.lineIds.isEmpty())
        assertEquals(CarryRect("keep", 14, 14, 2, 2), mode.occupied.first { it.id == "keep" })
        assertEquals(CarryRect(null, 18, 18, 2, 2), mode.occupied.single { it.id == null })
        model.selectBuilding(W1); model.toggleWallRow()
        assertEquals("The priced row through W1 carries together (#61)", model.state.value.wallRowIds.toSet(), requireNotNull(model.state.value.carryMode).lineIds)
        assertTrue(model.state.value.wallRowIds.size > 1)
        model.startPlacement("cannon")
        assertNull("Placement mode disables building drags (web HANDOFF §5.2)", model.state.value.carryMode)
    }
    @Test fun `a valid single drop posts one move clears the selection and holds the tile until the read answers`() {
        val repo = repo(); val model = model(repo); model.selectBuilding("keep")
        model.carry(CarryEvent.Released(listOf(CarryPiece("keep", 16, 14)), valid = true))
        assertEquals(listOf("move:keep:16:14"), repo.moves())
        assertNull("The web deselects on a landed drop", model.state.value.selectedBuildingId)
        assertTrue("Settled inline: the hold is released once the repository answered", model.state.value.local.settling.isEmpty())
        assertEquals("Every answered release bumps the epoch the renderer's own hold hands over on", 1L, requireNotNull(model.state.value.carryMode).settleEpoch)
        assertNull(model.notice.value)
    }
    @Test fun `a valid line drop posts one batch with every wall`() {
        val repo = repo(); val model = model(repo)
        model.carry(CarryEvent.Released(listOf(CarryPiece(W1, 10, 15), CarryPiece(W2, 11, 15)), valid = true))
        assertEquals(listOf("moveWalls:$W1:10:15,$W2:11:15"), repo.moves())
    }
    @Test fun `an invalid drop posts nothing and says why the piece snapped back`() {
        val repo = repo(); val model = model(repo)
        model.carry(CarryEvent.Released(listOf(CarryPiece("keep", 17, 17)), valid = false))
        assertTrue(repo.moves().isEmpty()); assertTrue(model.state.value.local.settling.isEmpty())
        assertEquals(ScreenNotice("CAN'T PLACE IT THERE", error = true), model.notice.value)
        model.dismissNotice(); assertNull(model.notice.value)
        model.carry(CarryEvent.Armed("keep")); assertTrue("Arming and previews are the renderer's; nothing is posted", repo.moves().isEmpty())
    }
    @Test fun `a refused move releases the hold so the scene reverts and the server's words are the notice`() {
        val repo = repo(); repo.failWith = gg.pixelkingdomwars.nativeclient.network.ApiException(409, "TILE_OCCUPIED", "That tile is occupied")
        val model = model(repo)
        model.carry(CarryEvent.Released(listOf(CarryPiece("keep", 16, 14)), valid = true))
        assertEquals(listOf("move:keep:16:14"), repo.moves())
        assertTrue(model.state.value.local.settling.isEmpty()); assertTrue(requireNotNull(model.state.value.carryMode).holds.isEmpty())
        assertEquals(ScreenNotice("That tile is occupied", error = true), model.notice.value)
        assertEquals("The scene draws the server tile again", CarryRect("keep", 14, 14, 2, 2), requireNotNull(model.state.value.carryMode).occupied.first { it.id == "keep" })
    }
    @Test fun `a kingdom without a land deed selects holds drags and moves its buildings`() {
        // Owner field result 2026-10-06 (Seeker build 05a72df2, QA wallet without land): "not able to move the buildings".
        // Production plays free until land is bought (FREE_ONBOARDING): the move routes are auth-only and the web arms a
        // drag on any own building. Home used to hand the scene no carry mode for a landless kingdom, so a hold never armed
        // and nothing said why. The admission has no land input now, and the whole gesture reaches the server.
        val screen = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/kingdom/KingdomScreen.kt").readText()
        // night/android merge: `carry = if (base == null) null else homeCarryMode(state, editing)` (nothing carries on a kept base).
        assertTrue("The scene's carry comes from the one admission rule", Regex("carry = [^\\n]*homeCarryMode\\(state, editing\\)").containsMatchIn(screen))
        assertFalse("Land ownership never gates a move", Regex("carry = [^\\n]*landOwned").containsMatchIn(screen))
        val repo = repo(); val model = model(repo)
        // buildings/SPEC.md §1.2: tap 1 selects (the bar rises), a long press on the building moves it.
        model.selectBuilding("keep")
        val mode = requireNotNull(homeCarryMode(model.state.value, editing = false)) { "a selected building on a landless base must lift" }
        assertTrue("keep" in mode.movableIds)
        assertNull("The layout editor owns its own scene", homeCarryMode(model.state.value, editing = true))
        // The renderer's own gesture machine, fed the admitted mode: hold still for the lift time, drag two tiles east, let go.
        val events = mutableListOf<CarryEvent>()
        val input = BuildingCarryInput({ events += it }) { 12f }
        input.frame(mode, BASE_ID, battle = false)
        input.down(0, "keep", 100f, 100f, 1000); input.tick(1000 + BuildingCarryInput.HOLD_TO_LIFT_MS)
        assertEquals("The hold arms the lift", CarryEvent.Armed("keep"), events.single())
        assertTrue(input.move(0, 160f, 100f, 17.4f, 15.0f, 1300))
        assertTrue("The drop ends a carry, never a tap", input.up(0, 1400))
        val released = events.last() as CarryEvent.Released
        assertEquals(CarryEvent.Released(listOf(CarryPiece("keep", 16, 14)), valid = true), released)
        model.carry(released)
        assertEquals("The drop is the move order", listOf("move:keep:16:14"), repo.moves())
        assertNull("The web deselects on a landed drop", model.state.value.selectedBuildingId)
        assertNull(model.notice.value)
    }
    @Test fun `a saved construction keeps refusing new building but never freezes the buildings already standing`() {
        // Owner field result 2026-10-06: the "Build goldforge" herald stood on the phone all day. It refuses BUILD (its own
        // door, in words); it also used to drop the carry mode, so every hold on every building did nothing and said nothing.
        // A move is a plain keyless order the server re-checks, and the web sends it whatever requests are saved.
        val store = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(store)
        store.create(PendingIntent(IntentKind.CONSTRUCTION, WALLET, BASE_ID, "key-1-0000", "/base/buildings",
            json("""{"idempotencyKey":"key-1-0000"}"""), "Build goldforge", attempted = true))
        kotlinx.coroutines.runBlocking { observer.refresh(WALLET) }
        val repo = repo()
        val model = KingdomViewModel(repo, FakeContentRepository(catalogue, render), observer, InterruptedActions({}, {}, {}), versionCode = 1, wallet = WALLET)
        assertTrue("The premise: the saved request still refuses new construction", model.state.value.constructionBlocked)
        val mode = requireNotNull(homeCarryMode(model.state.value, editing = false)) { "a saved construction must not freeze moves" }
        assertTrue("keep" in mode.movableIds)
        model.carry(CarryEvent.Released(listOf(CarryPiece("keep", 16, 14)), valid = true))
        assertEquals(listOf("move:keep:16:14"), repo.moves())
        assertTrue("The saved request still refuses BUILD after the move", model.state.value.constructionBlocked)
    }
    @Test fun `the command bar is hidden while carrying`() {
        // A drag across a bar button ended the carry: the scene refuses a point over painted chrome (NativeGameRenderer
        // touchDragged `insideViewport`) and the lifted piece snapped back. The plate and bar now leave at Armed (unmounted,
        // so no 120 ms exit keeps the buttons) and come back when the lift ends without a drop; a landed drop deselects.
        val screen = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/kingdom/KingdomScreen.kt").readText()
        assertTrue("The selection layer is mounted only while nothing is lifted", screen.contains("if (selectionChromeShown(carrying)) SelectionAnchorLayer("))
        val repo = repo(); val model = model(repo); model.selectBuilding("keep")
        val mode = requireNotNull(homeCarryMode(model.state.value, editing = false))
        var carrying = false
        val input = BuildingCarryInput({ carrying = carryOwnsMap(carrying, it); if (it is CarryEvent.Released) model.carry(it) }) { 12f }
        input.frame(mode, BASE_ID, battle = false)
        assertTrue("Selected, at rest: the bar stands", selectionChromeShown(carrying))
        input.down(0, "keep", 100f, 100f, 1000)
        assertTrue("A press is not a lift yet (a tap or a pan keeps the bar)", selectionChromeShown(carrying))
        input.tick(1000 + BuildingCarryInput.HOLD_TO_LIFT_MS)
        assertFalse("Lifted: no bar button can meet the drag", selectionChromeShown(carrying))
        assertTrue(input.move(0, 160f, 100f, 17.4f, 15.0f, 1300)); assertFalse(selectionChromeShown(carrying))
        input.cancel(0)
        assertTrue("A revert gives the bar back", selectionChromeShown(carrying))
        assertEquals("with the selection it had", "keep", model.state.value.selectedBuildingId)
        input.down(0, "keep", 100f, 100f, 2000); input.tick(2000 + BuildingCarryInput.HOLD_TO_LIFT_MS)
        assertFalse(selectionChromeShown(carrying))
        assertTrue(input.move(0, 160f, 100f, 17.4f, 15.0f, 2300)); assertTrue(input.up(0, 2400))
        assertEquals(listOf("move:keep:16:14"), repo.moves())
        assertTrue(selectionChromeShown(carrying)); assertNull("A landed drop deselects, so no bar returns", model.state.value.selectedBuildingId)
    }
    @Test fun `a kingdom without a land deed draws wall rows`() {
        // Same owner field result (QA wallet without land): WALL in the BUILD tray prepared a drawing and Home dismissed it at
        // once (`editing || !landOwned`) and never handed the scene the stroke. Under FREE_ONBOARDING the wall batch route asks
        // for land only when free onboarding is off, so no land input remains (the homeCarryMode rule).
        val screen = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/kingdom/KingdomScreen.kt").readText()
        assertTrue(screen.contains("wallStroke = if (editing) editor.wallStrokeMode else homeWallStroke(state, wallState, editing, busy)"))
        assertTrue(screen.contains("if (!homeWallDrawingAllowed(state, editing)) model.dismissWallDrawing()"))
        assertFalse("Land ownership never gates a wall stroke", Regex("wallStroke = [^\\n]*landOwned").containsMatchIn(screen))
        assertFalse("nor dismisses a drawing", Regex("LaunchedEffect\\([^)]*landOwned").containsMatchIn(screen))
        val model = model()
        val placing = model.state.value.let { it.copy(local = it.local.copy(placement = PlacementDraft("wall"))) }
        val base = requireNotNull(placing.base)
        val lease = WallStrokeMode("stroke-1", BASE_ID, 14, 14, 1, 1, setOf(WallStrokeTile(12, 15)), 8, 8)
        val wall = WallBatchState(supported = true, enabled = true,
            drawing = WallBatchDrawing(lease, BASE_ID, base, WallBatchTerms("10", 196, 50), "1000", 50, 1L))
        assertTrue("A landless base keeps its open drawing", homeWallDrawingAllowed(placing, editing = false))
        assertEquals("and its stroke reaches the scene", lease, homeWallStroke(placing, wall, editing = false, busy = false))
        assertNull("The layout editor draws its own walls", homeWallStroke(placing, wall, editing = true, busy = false))
        assertNull("Nothing strokes while an order runs", homeWallStroke(placing, wall, editing = false, busy = true))
        assertNull("No wall draft placed, no stroke", homeWallStroke(model.state.value, wall, editing = false, busy = false))
    }
    @Test fun `a hold reads as the settled tile for the next carry and for the renderer`() {
        val repo = repo(); val model = model(repo)
        // A pending hold stands in for the in-flight read: the next carry must see the vacated origin, not the store's stale tile.
        val held = model.state.value.local.copy(settling = mapOf("keep" to (16 to 14)))
        val state = model.state.value.copy(local = held)
        assertEquals(CarryRect("keep", 16, 14, 2, 2), requireNotNull(state.carryMode).occupied.first { it.id == "keep" })
        assertEquals(mapOf("keep" to CarryTile(16, 14)), requireNotNull(state.carryMode).holds)
    }
}
