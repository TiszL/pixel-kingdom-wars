package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import java.io.File
import org.junit.Test
import kotlin.test.*

/** Store-build incident (campaign raids, 2026-09-17): a dragon crossing a wall ring was painted UNDER the wall
 * sprites. Battle structures sort on their footprint south edge and bodies on their feet, so a flying body one row
 * north of a wall's base line lost the painter tie to the wall. The web draws every actor in WORLD_DEPTH.actor; the
 * pack exports that band as `basePresentation.jobs.actorDepthOffset` and marks flying bodies (`profile.flying`),
 * and the plan lifts exactly those bodies, with the effects seated on them, into that band. Ground bodies keep the
 * shared axis, so a highlander standing in the same spot still interleaves with the wall as before. */
class FlyingActorDepthTest {
    private val root = File("../app/src/main/assets/native")
    private val reader = JsonReader()
    private val render = reader.parse(root.resolve("render-catalog.json").readText())
    private val library = CombatArt.catalogue(render)
    private val band = requireNotNull(RendererCatalogue.basePresentation(render)).jobs.actorDepthOffset
    private val presentation = reader.parse(root.resolve("catalogue.json").readText()).get("presentation")
    private val tile = presentation.getFloat("tilePixels")
    private val unitsPerTile = presentation.getFloat("unitsPerTile")
    private val actorFrames = render.get("actors").filter { it.getInt("level", 1) == 1 }
        .associate { it.getString("type") to it.getString("frameKey") }
    private val wallEntry = render.get("walls").first { it.getInt("level") == 1 }
    /** One wall tile at (5,5): its painter line is the south edge, (5+1) tiles down. */
    private val wall = RenderBuilding("wall-5-5", wallEntry.getString("frameKey"), 5f, 5f,
        wallEntry.getFloat("footprintWidth"), wallEntry.getFloat("footprintHeight"), type = "wall")
    private val wallSouth = (wall.tileY + wall.footprintHeight) * tile
    /** Over the wall tile but NORTH of its south edge: the exact configuration that lost the tie. */
    private val overX = (5.5f * unitsPerTile).toInt()
    private val overY = (5.2f * unitsPerTile).toInt()
    private val feetY = overY * tile / unitsPerTile

    private fun scene(events: List<String>): BattleScene {
        val parsed = events.map(PresentationEvent::fromJson)
        return BattleScene(BaseScene(listOf(wall), 32, 32, tile), PresentationRevision("raid", "r", 16, 0, 0, parsed),
            actorFrames, unitsPerTile, presentation.getFloat("tickMs"), 5, 5)
    }
    private fun plan(scene: BattleScene, lift: Float = band): Pair<BattleVisualModel, CombatVisualPlan> {
        val model = BattleVisualModel(scene.revision.events, 5)
        return model to CombatVisualPlan(scene, model, library, flyingDepthOffset = lift)
    }
    private fun deploy(id: Int, troop: String) = """{"t":0,"e":"deploy","id":$id,"troop":"$troop","x":$overX,"y":$overY}"""

    @Test fun `a flying dragon over a wall paints above it while a ground body keeps its wall interleave`() {
        assertTrue(feetY < wallSouth, "The fixture must hover north of the wall's painter line")
        val s = scene(listOf(deploy(1, "dragon"), deploy(2, "highlander"), """{"t":40,"e":"star","n":1}"""))
        val (model, p) = plan(s)
        val tick = 20f
        // An intact wall has no animated pose: NativeGameRenderer seats it with the composed five-tier wall seat
        // (or placeBuilding, the same south edge), and that placement's depth is its painter line.
        val wallDepth = p.building(wall.id, tick)?.depth ?: wallSeat(requireNotNull(RendererCatalogue.wallArt(render)), wall, tile).depth
        val dragon = requireNotNull(p.actor(1, tick)); val highlander = requireNotNull(p.actor(2, tick))
        assertEquals(wallSouth, wallDepth, "A structure sorts on its footprint south edge")
        assertEquals(band + feetY, dragon.depth, "A flying body sorts in the pack's actor band above its feet")
        assertEquals(feetY, highlander.depth, "A ground body still sorts on its feet")
        // The renderer's paintOrder.sortBy { depth }: ground body, then the wall over it, then the dragon over both.
        val order = listOf("wall" to wallDepth, "dragon" to dragon.depth, "highlander" to highlander.depth)
            .sortedBy { it.second }.map { it.first }
        assertEquals(listOf("highlander", "wall", "dragon"), order)
        assertTrue(dragon.depth < 400_000f, "The actor band stays under the overlay band (HP bars, projectiles, stars)")
        // Same plan without the pack's band: the incident ordering. The renderer must pass the band through.
        assertEquals(feetY, plan(s, lift = 0f).second.actor(1, tick)!!.depth)
        // Headless frame of the same scene, sorted the way NativeGameRenderer sorts.
        val proof = CpuCombatProof(root).write(s, model, p, render, tick, "flying_over_wall")
        assertTrue(proof.length() > 0)
    }

    @Test fun `effects seated on a flying body ride its band so the body cannot cover its own wings or fan`() {
        val art = library.getValue(actorFrames.getValue("direwyvern"))
        val maul = requireNotNull(art.maul); val fan = requireNotNull(art.firestorm)
        for ((ability, extra) in listOf("maul" to "", "firestorm" to ""","ix":$overX,"iy":${overY + 4 * unitsPerTile.toInt()}""")) {
            val cast = """{"t":1,"e":"troopAbility","id":3,"ability":"$ability","x":$overX,"y":$overY$extra}"""
            val (_, p) = plan(scene(listOf(deploy(3, "direwyvern"), cast, """{"t":60,"e":"star","n":1}""")))
            val out = mutableListOf<CombatSprite>(); var seen = 0
            for (step in 2..600) {
                val tick = step / 10f
                p.transientSprites(tick, out)
                val effects = out.filter { it.clip.key == (if (ability == "maul") maul.clip else fan.clip).key }
                if (effects.isEmpty()) continue
                val body = requireNotNull(p.actor(3, tick)) { "The caster is still alive at $tick" }
                for (effect in effects) {
                    seen++
                    assertTrue(effect.depth > body.depth, "$ability effect must draw over the flying body at $tick")
                    assertTrue(effect.depth > wallSouth && body.depth > wallSouth, "$ability and its caster both clear the wall")
                }
            }
            assertTrue(seen > 0, "The pack's $ability contract must have produced effect sprites")
        }
    }
}
