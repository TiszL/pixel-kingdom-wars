package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PlotGeometryTest {
    private val policy = Json.parseToJsonElement(PlotGeometry::class.java.classLoader!!.getResource("plot-geometry.json")!!.readText())
    private val catalogue = buildJsonObject { put("constants", buildJsonObject { put("PLOT_GEOMETRY", policy); put("GRID", buildJsonObject { put("plotTiles", 30) }) }) }
    @Test fun `missing version is frozen historical size while larger plot keeps original centre`() {
        assertEquals(PlotGeometry(1, 0, 30), PlotGeometry.from(catalogue))
        val current = PlotGeometry.from(catalogue, 2)
        assertEquals(PlotGeometry(2, -10, 40), current)
        assertTrue(current.contains(-10, -10)); assertTrue(current.contains(39, 39))
        assertFalse(current.contains(-11, 0)); assertFalse(current.contains(40, 0)); assertFalse(current.contains(39, 39, 2, 2))
        assertEquals(30, current.min + current.max)
    }
    @Test fun `unsupported or tampered geometry never widens commands or original recovery`() {
        assertThrows(IllegalArgumentException::class.java) { PlotGeometry.from(catalogue, 3) }
        val changed = buildJsonObject { put("version", 2); put("min", -100); put("max", 100) }
        assertThrows(IllegalArgumentException::class.java) { PlotGeometry.saved(changed) }
        assertEquals(PlotGeometry.from(catalogue, 2), PlotGeometry.saved(PlotGeometry.from(catalogue, 2).json))
        val old = buildJsonObject { put("constants", buildJsonObject { put("GRID", buildJsonObject { put("plotTiles", 30) }) }) }
        assertEquals(PlotGeometry(1, 0, 30), PlotGeometry.from(old))
        assertThrows(IllegalArgumentException::class.java) { PlotGeometry.from(old, 2) }
    }
    @Test fun `signed wall and hero receipts retain original geometry and reject forged quotes`() {
        val plot = PlotGeometry.from(catalogue, 2)
        val terms = WallBatchTerms("1", plot.size, 250, plot)
        val request = WallBatchRequest("00000000-0000-4000-8000-000000000001", null, listOf(WallBatchTile(-10, 39)), "1")
        request.validate(terms)
        assertThrows(IllegalArgumentException::class.java) { request.validate(WallBatchTerms("1", 30, 250)) }
        val hero = HeroRecruitmentRequest(request.idempotencyKey, null, "heroaltar", -10, 39, false, "1")
        hero.validate(plot.size, plot)
        assertThrows(IllegalArgumentException::class.java) { hero.validate(30) }
    }
}
