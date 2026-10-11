package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import java.io.File
import java.security.MessageDigest
import org.junit.Test
import kotlin.test.*

/** The Kotlin compositor must reproduce the canonical `wallRender.ts` output byte-for-byte: the
 * pack carries 23 goldens (sha256 of composeWall/composeCollapse RGBA) computed by executing the
 * web compositor at export time. A divergence here is a port bug, never a reason to loosen. */
class WallCompositorTest {
    private val root = System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val render = JsonReader().parse(root.resolve("render-catalog.json").readText())
    private val section = assertNotNull(render.get("walls5"), "contract 13 pack carries the walls5 section")
    private val spec = WallArtSpec(section)
    private val compositor = WallCompositor(spec)
    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun grid(cells: JsonValue): WallGrid {
        val grid = WallGrid()
        cells.forEach { cell ->
            val stage = if (cell.size > 3) cell.getInt(3) else 0
            grid.put(cell.getInt(0), cell.getInt(1), WallCell(cell.getInt(2), damage = stage > 0, damageStage = stage))
        }
        return grid
    }

    @Test fun `every compose and collapse golden matches the canonical compositor byte for byte`() {
        val vectors = section.get("compositor").get("vectors").toList()
        assertEquals(23, vectors.size, "the exporter emits 23 compositor goldens")
        val failures = mutableListOf<String>()
        for (vector in vectors) {
            val name = vector.getString("name"); val g = grid(vector.get("grid"))
            val x = vector.get("cell").getInt(0); val y = vector.get("cell").getInt(1)
            val frame = when (vector.getString("kind")) {
                "compose" -> assertNotNull(compositor.composeWall(g, x, y), name)
                "collapse" -> compositor.composeCollapse(assertNotNull(compositor.captureCollapse(g, x, y, 0.0), name), vector.getDouble("timeMs"))
                else -> fail("unknown golden kind for $name")
            }
            assertEquals(vector.getInt("width"), frame.width, name); assertEquals(vector.getInt("height"), frame.height, name)
            assertEquals(vector.get("anchor").getInt(0), frame.anchorX, name); assertEquals(vector.get("anchor").getInt(1), frame.anchorY, name)
            if (vector.has("renderKey")) assertEquals(vector.getString("renderKey"), compositor.renderKey(g, x, y), "$name render key")
            val expectedCommands = vector.getInt("commands"); val hash = sha256(frame.data)
            if (expectedCommands != frame.commandCount || hash != vector.getString("rgbaSha256"))
                failures += "$name: commands ${frame.commandCount} (expected $expectedCommands) rgba $hash (expected ${vector.getString("rgbaSha256")})"
        }
        assertTrue(failures.isEmpty(), "compositor goldens diverged:\n" + failures.joinToString("\n"))
    }

    @Test fun `tier and damage stage rules follow the catalogue thresholds`() {
        val stages = section.get("damageStages"); val maxHp = 4000L
        assertEquals(0, spec.damageStage(maxHp, maxHp)); assertEquals(0, spec.damageStage((maxHp * spec.lightDamageBelow).toLong(), maxHp))
        assertEquals(stages.get("light").getInt("stage"), spec.damageStage((maxHp * spec.lightDamageBelow).toLong() - 1, maxHp))
        assertEquals(1, spec.damageStage((maxHp * spec.heavyDamageBelow).toLong(), maxHp))
        assertEquals(stages.get("heavy").getInt("stage"), spec.damageStage((maxHp * spec.heavyDamageBelow).toLong() - 1, maxHp))
        assertEquals(2, spec.damageStage(1, maxHp)); assertEquals(stages.get("collapsed").getInt("stage"), spec.damageStage(0, maxHp))
        assertEquals(0, spec.damageStage(10, 0), "unknown maximum falls back to intact"); assertEquals(0, spec.damageStage(null, null))
        val table = section.get("tierOfLevel")
        for (i in 0 until table.size) assertEquals(table.getInt(i), spec.tierOfLevel(i + 1))
        assertEquals(table.getInt(table.size - 1), spec.tierOfLevel(table.size + 5), "levels beyond the table clamp to the top tier")
        assertEquals(table.getInt(0), spec.tierOfLevel(0))
        for (mask in 0..15) assertEquals("wall5_t3_${spec.shapesByMask[mask]}_intact_f1", spec.intactFrame(3, mask))
        assertEquals(1000.0 * spec.collapseFrames / spec.collapseFps, spec.collapseDurationMs)
    }

    @Test fun `a render key alone rebuilds the neighbourhood that composes the same pixels`() {
        // The web reuses frames by wallRenderKey across scenes; the native library composes straight
        // from the key, so every golden must survive the round trip through its own signature.
        for (vector in section.get("compositor").get("vectors")) {
            if (vector.getString("kind") != "compose") continue
            val g = grid(vector.get("grid")); val x = vector.get("cell").getInt(0); val y = vector.get("cell").getInt(1)
            val key = compositor.renderKey(g, x, y)
            val rebuilt = compositor.gridFromKey(key)
            assertEquals(x, rebuilt.x); assertEquals(y, rebuilt.y)
            assertEquals(key, compositor.renderKey(rebuilt.grid, x, y), vector.getString("name"))
            val full = assertNotNull(compositor.composeWall(g, x, y)); val fromKey = assertNotNull(compositor.composeWall(rebuilt.grid, x, y))
            assertContentEquals(full.data, fromKey.data, "${vector.getString("name")} composed from its key")
            assertContentEquals(full.commands, fromKey.commands)
        }
    }

    @Test fun `render keys change only within the three by three neighbourhood`() {
        val g = WallGrid(); g.put(0, 0, WallCell(2)); g.put(1, 0, WallCell(2)); g.put(5, 5, WallCell(4))
        val before = compositor.renderKey(g, 0, 0)
        g.put(5, 5, WallCell(1, damage = true, damageStage = 2))
        assertEquals(before, compositor.renderKey(g, 0, 0), "a far cell cannot change a frame key")
        g.put(1, 0, WallCell(2, damage = true, damageStage = 1))
        assertNotEquals(before, compositor.renderKey(g, 0, 0), "a neighbour's damage stage recomposes the shared shoulder")
        assertEquals("0,0|-|-|-|-|2:0:1|2:1:1|-|-|-", compositor.renderKey(g, 0, 0))
        assertNull(compositor.composeWall(g, 9, 9), "empty cells compose nothing")
    }
}
