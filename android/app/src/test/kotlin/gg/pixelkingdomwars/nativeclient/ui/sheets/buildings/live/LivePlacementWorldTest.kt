package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import androidx.compose.ui.unit.IntOffset
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.BaseGeometry
import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import gg.pixelkingdomwars.nativeclient.ui.kingdom.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** fc7a61fa: observed tiles can refuse a local placement, never admit a server purchase. */
class LivePlacementWorldTest {
    private val catalogue = Json.parseToJsonElement("""{"constants":{"STRUCTURES":{"camp":{"footprint":[2,3]},"vault":{"footprint":[2,2]}},"OBSTACLES":{"tiers":[]}}}""") as JsonObject
    private val render = Json.parseToJsonElement("""{"entries":[{"type":"camp","level":1,"footprintWidth":2,"footprintHeight":3}],"basePresentation":{"obstacles":{"rock":{"footprintWidth":2}}}}""") as JsonObject
    private val geometry = BaseGeometry(catalogue, render)
    private fun base(buildings: List<Building> = emptyList(), obstacles: List<Obstacle> = emptyList(), claim: Claim? = Claim(0, 12)) =
        BaseSnapshot("base", null, PlayerSummary(keepLevel = 1), null, null, claim, buildings, obstacles, emptyList(), 1, buildJsonObject {})
    private fun space(base: BaseSnapshot = base(), tile: Pair<Int, Int> = 4 to 4, settling: Map<String, Pair<Int, Int>> = emptyMap()) =
        placementSpace(base, geometry, "camp", tile, settling)
    private fun facts() = PlacementFacts("camp", "CAMP", "ui:camp-t1-identity", 2, 4 to 4, "SHARDS", "200", "200", "1m", "900", 1, 1, null, true, false, false, false, false)
    private val view = BaseCameraView("base", 100f, 100f, 2f, 400, 600)
    private fun site(id: String, anchor: PxRect = PxRect(0f, 0f, 1f, 1f)) = TimerPlateUi(id, "builder", null, null, anchor = anchor)

    @Test fun `free rectangular footprint retains catalogue width and height`() {
        val s = space()
        assertEquals(2, s.width); assertEquals(3, s.height)
        assertTrue(s.takenTiles.isEmpty()); assertNull(s.reason)
    }
    @Test fun `buildings including a construction site mark only intersecting relative tiles`() {
        val s = space(base(buildings = listOf(Building("v", "vault", 1, 5, 5, underConstruction = true))))
        assertEquals(setOf(IntOffset(1, 1), IntOffset(1, 2)), s.takenTiles)
        assertEquals("Spot is blocked", s.reason)
    }
    @Test fun `obstacle footprint comes from render metadata`() {
        val s = space(base(obstacles = listOf(Obstacle("rock", "rock", 3, 4))))
        assertEquals(setOf(IntOffset(0, 0), IntOffset(0, 1)), s.takenTiles)
        assertEquals("Spot is blocked", s.reason)
    }
    @Test fun `claim end is exclusive and every outside tile is painted`() {
        val s = space(tile = 11 to 10)
        assertEquals(setOf(IntOffset(1, 0), IntOffset(1, 1), IntOffset(0, 2), IntOffset(1, 2)), s.takenTiles)
        assertEquals("Outside your land", s.reason)
        assertNull(space(tile = 10 to 9).reason)
    }
    @Test fun `negative tiles and missing bounds never become locally clear`() {
        assertEquals("Outside your land", space(tile = -1 to 0).reason)
        assertEquals("Land bounds are unavailable", space(base(claim = null)).reason)
        assertEquals("Land bounds are unavailable", space(base(claim = Claim(2, 2))).reason)
    }
    @Test fun `pending carry reserves original and proposed footprints until authoritative hydration`() {
        val b = base(buildings = listOf(Building("v", "vault", 1, 0, 0)))
        val settling = mapOf("v" to (4 to 4))
        assertEquals("Spot is blocked", space(b, 0 to 0, settling).reason)
        assertEquals("Spot is blocked", space(b, 4 to 4, settling).reason)
        assertNull(space(b, 7 to 7, settling).reason)
    }
    @Test fun `blocked spot beats short funds or no builder while remaining movable`() {
        val ui = livePlacementUi(facts().copy(takenTiles = setOf(IntOffset(1, 2)), spaceReason = "Spot is blocked", footprintHeight = 3, freeBuilders = 0, shardsBalance = "0"))!!
        assertEquals(PlacementState.BLOCKED, ui.state); assertEquals(3, ui.footprintHeight)
        assertEquals(setOf(IntOffset(1, 2)), ui.takenTiles)
        assertEquals(PlaceTap.NONE, placeLook(ui.state, ui.price, ui.reason).tap)
        assertTrue(placeLook(ui.state, ui.price, ui.reason).draggable)
    }
    @Test fun `busy and saved payment retain priority over geometric hints`() {
        val f = facts().copy(spaceReason = "Spot is blocked", takenTiles = setOf(IntOffset.Zero))
        assertEquals(PlacementState.SENDING, livePlacementUi(f.copy(busy = true))!!.state)
        assertEquals("Check the saved payment first", livePlacementUi(f.copy(constructionBlocked = true))!!.reason)
        assertNull(livePlacementUi(f.copy(currency = "KEEP")))
        assertNull(livePlacementUi(f.copy(heroOffer = true)))
        assertNull(livePlacementUi(f.copy(type = "wall")))
    }
    @Test fun `ghost projection uses the actual rectangular footprint and drawn camera`() {
        val ui = livePlacementUi(facts().copy(footprintHeight = 3))!!
        val g = livePlacementGeometry(ui, true, "base", 10f, Claim(0, 12), view)!!
        assertEquals(PxRect(170f, 270f, 180f, 285f), g.footprint)
        assertEquals(5f, g.tilePx)
        assertEquals(PxRect(150f, 250f, 210f, 310f), g.buildable)
    }
    @Test fun `no chosen tile foreign camera or moving camera never floats a ghost at origin`() {
        val ui = livePlacementUi(facts())!!
        assertNull(livePlacementGeometry(ui, false, "base", 10f, Claim(0, 12), view))
        assertNull(livePlacementGeometry(ui, true, "other", 10f, Claim(0, 12), view))
        assertNull(livePlacementGeometry(ui, true, "base", 10f, Claim(0, 12), view.copy(overlayVisible = false)))
        assertNull(livePlacementGeometry(ui, true, "base", 0f, Claim(0, 12), view))
    }
    @Test fun `timer projection rejects another base and unmeasured roofs use the footprint top`() {
        val b = RenderBuilding("b", "frame", 4f, 4f, 2f, 3f)
        val scene = BaseScene(listOf(b), 12, 12, 10f, baseId = "base")
        val ui = constructionWorldUi(listOf(site("b")), scene, emptyMap(), view, false)
        assertEquals(PxRect(170f, 270f, 180f, 285f), ui.sites.single().anchor)
        assertTrue(constructionWorldUi(listOf(site("b")), scene, emptyMap(), view.copy(baseId = "other"), false).sites.isEmpty())
        assertFalse(constructionWorldUi(listOf(site("b")), scene, emptyMap(), view, true).visible)
        assertFalse(constructionWorldUi(listOf(site("b")), scene, emptyMap(), view.copy(overlayVisible = false), false).visible)
    }
    @Test fun `construction markers have nearest first shared budget and omit absent and offscreen sites`() {
        val buildings = (0..4).map { RenderBuilding("b$it", "frame", it * 3f, 9f, 1f, 1f) } + RenderBuilding("away", "frame", 1000f, 1000f, 1f, 1f)
        val scene = BaseScene(buildings, 12, 12, 10f, baseId = "base")
        val ui = constructionWorldUi(buildings.map { site(it.id) } + site("missing"), scene, emptyMap(), view, false)
        assertEquals(listOf("b3", "b4", "b2"), ui.sites.map { it.buildingId })
        assertEquals(MAX_WORLD_MARKERS, ui.sites.size)
        assertTrue(ui.sites.all { it.timeLeft == null && it.progress == null })
    }
    @Test fun `construction roofs replace footprint tops but never invent timer data`() {
        val scene = BaseScene(listOf(RenderBuilding("b", "frame", 4f, 4f, 2f, 3f)), 12, 12, 10f, baseId = "base")
        val ui = constructionWorldUi(listOf(site("b")), scene, mapOf("b" to 20f), view, false)
        assertEquals(260f, ui.sites.single().anchor.top)
        assertNull(ui.sites.single().timeLeft); assertNull(ui.sites.single().progress)
    }
    @Test fun `each construction job shows exactly one builder across the scene and the timer layer`() {
        // Owner 2026-10-06 ("when building something big builders second one appears"): the plate layer stood a still 30 dp
        // builder beside every site while the scene walked its Workman to the same job, so each build showed two. The
        // scene's set (workmanJobs) decides: a site it walks a Workman to draws no still builder; a Phase E service build,
        // which the scene draws no Workman for, keeps the still one. Scene workmen + still builders = server jobs.
        val forge = RenderBuilding("gf", "bld_goldforge_l1", 4f, 4f, 2f, 2f, type = "goldforge", level = 1, underConstruction = true)
        val workshop = RenderBuilding("ws", "service:workshop:1", 8f, 4f, 2f, 2f, type = "workshop", level = 1,
            underConstruction = true, service = RenderServiceIdentity("workshop", 1))
        val jobs = listOf(RenderJob("j1", "build", 4f, 4f, 2f, 2f, 0L, 60_000L, "gf"), RenderJob("j2", "build", 8f, 4f, 2f, 2f, 0L, 60_000L, "ws"))
        val scene = BaseScene(listOf(forge, workshop), 12, 12, 10f, baseId = "base", jobs = jobs)
        val ui = constructionWorldUi(listOf(site("gf"), site("ws")), scene, emptyMap(), view, false)
        val sites = ui.sites.associateBy { it.buildingId }
        assertTrue("the scene walks a Workman to the Gold Forge", sites.getValue("gf").workmanInScene)
        assertFalse("a service build has no scene Workman", sites.getValue("ws").workmanInScene)
        assertEquals(jobs.size, scene.workmanJobs().size + ui.sites.count { !it.workmanInScene })
        // No job, no builder: a site whose job the scene does not carry (an older pack without job art) keeps the still one.
        val bare = constructionWorldUi(listOf(site("gf")), scene.copy(jobs = emptyList()), emptyMap(), view, false)
        assertFalse(bare.sites.single().workmanInScene)
    }
    @Test fun `Home mounts both world layers and retires the duplicate live neutral footprint`() {
        val source = source("ui/kingdom/KingdomScreen.kt")
        assertTrue(source.contains("LivePlacementWorldLayer(")); assertTrue(source.contains("LiveConstructionWorldLayer("))
        assertTrue(source.contains("SceneHighlightKind.FOOTPRINT")); assertTrue(source.contains("SceneHighlightKind.GRID"))
        assertTrue(source.contains("onMove = { model.pickTile("))
        val host = source("ui/sheets/buildings/live/LiveSheetHosts.kt")
        assertTrue(host.contains("placeLook(fresh.state, fresh.price, fresh.reason).tap == PlaceTap.PLACE"))
    }
    @Test fun `existing placement owner checks fresh occupancy before consuming its draft`() {
        val source = source("ui/kingdom/KingdomViewModel.kt").substringAfter("fun confirmPlacement() {").substringBefore("fun upgrade(")
        assertTrue(source.indexOf("placementSpace(") < source.indexOf("placementContext = null"))
        assertTrue(source.contains("baseRepository.state.value.base"))
        assertTrue(source.contains("baseRepository.place(draft.type, tile.first, tile.second)"))
    }
    private fun source(path: String): String = listOf(File("src/main/kotlin/gg/pixelkingdomwars/nativeclient", path), File("app/src/main/kotlin/gg/pixelkingdomwars/nativeclient", path)).first { it.isFile }.readText()
}
