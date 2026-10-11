package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import java.io.File
import org.junit.Test
import kotlin.test.*

class DefenseAimTest {
    private val root = System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val render = JsonReader().parse(root.resolve("render-catalog.json").readText())
    private val library = CombatArt.catalogue(render)
    private val defenses = render.get("entries").filter { it.getString("type") in setOf("cannon", "mortar") }
    private fun event(json: String) = PresentationEvent.fromJson(json)

    private fun checkAim(damaged: Boolean) {
        assertEquals(setOf("cannon", "mortar"), defenses.map { it.getString("type") }.toSet())
        for (entry in defenses) {
            val type = entry.getString("type")
            val art = library.getValue(entry.getString("frameKey"))
            val building = RenderBuilding("defense", entry.getString("frameKey"), 0f, 0f, 2f, 2f, 100L, 100L, type)
            val projectile = if (type == "cannon") "cannonball" else "shell"
            // At this seat the east target is (128,128), and north is (64,0).
            val east = event("""{"t":10,"e":"fire","id":"defense","proj":"$projectile","ix":512,"iy":512}""")
            val north = event("""{"t":100,"e":"fire","id":"defense","proj":"$projectile","ix":256,"iy":0}""")
            val hit = event("""{"t":11,"e":"hit","target":"defense","dmg":51}""")
            fun plan(events: List<PresentationEvent>): CombatVisualPlan {
                val scene = BattleScene(BaseScene(listOf(building), 10, 10, 64f),
                    PresentationRevision("defense-aim", "fixture", 14, 0, 0, events), emptyMap(), 256f, 100f, 1, 1)
                return CombatVisualPlan(scene, BattleVisualModel(events, 1), library, render.getFloat("buildingDamageThreshold"))
            }
            val firstEvents = if (damaged) listOf(east, hit) else listOf(east)
            val p = plan(firstEvents + north)
            val fire = art.clips.getValue("fire")
            val reload = art.clips.getValue("reload")
            val afterEast = 10f + (fire.durationMs + reload.durationMs) / 100f + .01f
            val afterNorth = afterEast + 90f
            assertTrue(afterEast < 100f, "Fixture must finish fire and reload before changing aim")
            val rest = art.clips.getValue(if (damaged) "damaged" else "idle")
            val label = "$type level ${entry.getInt("level")}"
            fun row(sprite: CombatSprite?, clip: AuthoredClip, facing: String) {
                assertNotNull(sprite, label)
                val index = clip.rowOrder.indexOf(facing)
                assertTrue(index >= 0, "$label must retain its authored $facing row")
                assertTrue(sprite.frameKey in clip.frames[index], "$label should use $facing, got ${sprite.frameKey}")
            }
            row(p.building("defense", 0f), art.clips.getValue("idle"), "s")
            row(p.building("defense", 10f), fire, "e")
            row(p.building("defense", 10f + fire.durationMs / 100f + .01f), reload, "e")
            row(p.building("defense", afterEast), rest, "e")
            row(p.building("defense", 100f), fire, "n")
            row(p.building("defense", afterNorth), rest, "n")
            row(p.building("defense", afterEast), rest, "e")
            row(p.building("defense", 0f), art.clips.getValue("idle"), "s")
            // Removing a predicted later shot must also remove its retained aim.
            row(plan(firstEvents).building("defense", afterNorth), rest, "e")
            assertTrue(p.missingCoverage.isEmpty(), "$label must use admitted authored combat paths: ${p.missingCoverage}")
        }
    }

    @Test fun `cannons and mortars retain shot direction between authored attacks through seek and revision replacement`() = checkAim(false)
    @Test fun `damage during a shot preserves its full fire reload sequence and retains its aim in the damaged loop`() = checkAim(true)
}
