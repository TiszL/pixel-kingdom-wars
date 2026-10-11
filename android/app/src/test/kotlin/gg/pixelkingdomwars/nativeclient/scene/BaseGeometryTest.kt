package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.Obstacle
import gg.pixelkingdomwars.nativeclient.renderer.HighlightColors
import gg.pixelkingdomwars.nativeclient.renderer.SceneHighlightKind
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/** Taps resolve against the footprints the renderer draws with; the constants tables are the fallback. */
class BaseGeometryTest {
    private fun file(path: String) = Json.parseToJsonElement(File(path).readText()).jsonObject
    private val catalogue = file("src/main/assets/native/catalogue.json")
    private val render = file("src/main/assets/native/render-catalog.json")

    @Test fun `footprints come from the render catalogue with the shared tables as the fallback`() {
        val geometry = BaseGeometry(catalogue, render)
        assertEquals(2 to 2, geometry.footprint("keep", 1)); assertEquals(1 to 1, geometry.footprint("cannon", 1))
        assertEquals("A level the render catalogue lacks still has the shared footprint", 2 to 2, geometry.footprint("keep", 99))
        assertEquals(2 to 2, BaseGeometry(catalogue, null).footprint("keep", 1))
        assertEquals(2, geometry.obstacleFootprint(Obstacle("o", "boulder", 0, 0))); assertEquals(1, geometry.obstacleFootprint(Obstacle("o", "bush", 0, 0)))
        assertEquals("An unknown sprite occupies one tile", 1, BaseGeometry(catalogue, null).obstacleFootprint(Obstacle("o", "mystery", 0, 0)))
    }
    @Test fun `hit tests cover whole footprints and prefer the last drawn building`() {
        val geometry = BaseGeometry(catalogue, render)
        val keep = Building("keep", "keep", 1, 14, 14); val cannon = Building("cannon", "cannon", 1, 10, 10)
        assertEquals(keep, geometry.buildingAt(listOf(keep, cannon), 15.9f, 15.9f)); assertNull(geometry.buildingAt(listOf(keep, cannon), 16f, 14f))
        assertEquals(cannon, geometry.buildingAt(listOf(keep, cannon), 10.2f, 10.8f))
        assertEquals("A draft position overrides the server position", cannon, geometry.buildingAt(listOf(keep, cannon), 5.5f, 5.5f) { if (it.id == "cannon") 5 to 5 else it.tx to it.ty })
        val rock = Obstacle("rock", "boulder", 18, 18)
        assertEquals(rock, geometry.obstacleAt(listOf(rock), 19.5f, 19.5f)); assertNull(geometry.obstacleAt(listOf(rock), 20f, 18f))
        val highlight = geometry.highlight(keep, BaseGeometry.SELECTION, 0.35f)
        assertEquals(14f, highlight.tileX); assertEquals(2f, highlight.height); assertEquals(0.35f, highlight.alpha)
        assertEquals("The default kind stays a plain fill", SceneHighlightKind.FILL, highlight.kind)
    }
    @Test fun `placement chrome is built from the claim and the catalogue footprint`() {
        val geometry = BaseGeometry(catalogue, render)
        val grid = requireNotNull(BaseGeometry.plotGrid(8, 22))
        assertEquals(SceneHighlightKind.GRID, grid.kind); assertEquals(8f, grid.tileX); assertEquals(14f, grid.width); assertEquals(BaseGeometry.GRID_ALPHA, grid.alpha)
        assertNull("A claim without area draws nothing rather than a degenerate grid", BaseGeometry.plotGrid(5, 5))
        val keep = geometry.footprintHighlight("keep", 1, 10 to 12, valid = false)
        assertEquals(SceneHighlightKind.FOOTPRINT, keep.kind); assertEquals(2f to 2f, keep.width to keep.height); assertEquals(HighlightColors.BLOCKED, keep.color)
        assertEquals(HighlightColors.VALID, geometry.footprintHighlight("cannon", 1, 0 to 0, valid = true).color)
        assertEquals(HighlightColors.GOLD, geometry.footprintHighlight("cannon", 1, 0 to 0, valid = null).color)
    }
}
