package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import org.junit.Test
import kotlin.test.*

class CombatVisualPlanTest {
    private fun event(json: String) = PresentationEvent.fromJson(json)
    private fun clip(key: String, count: Int = 4, fps: Float = 10f, cues: Map<String, List<Int>> = emptyMap()) = AuthoredClip(
        key, "atlas/$key.json", List(8) { row -> List(count) { "$key-d$row-f$it" } },
        listOf("s", "sw", "w", "nw", "n", "ne", "e", "se"), fps, .5f, 1f, .5f, 20f, 40f, false,
        JsonReader().parse("""{"nock":[[[15,10]],[[15,10]],[[15,10]],[[15,10]],[[15,10]],[[15,10]],[[15,10]],[[15,10]]]}"""), cues)
    private val art = CombatArt(mapOf("idle" to clip("idle"), "walk" to clip("walk"), "draw" to clip("draw", 2),
        "loose" to clip("loose", 3, cues = mapOf("arrow" to listOf(2))), "death" to clip("death", 2)),
        JsonReader().parse("""{"move":"walk","stand":"idle","attack":["draw","loose"],"death":"death","ranged":{"state":"loose","fx":"arrow","emitter":"nock","projectile":"arrow"}}"""),
        mapOf("arrow" to ProjectileProfile(clip("arrow"), clip("impact", 2), null, 200f, .2f, .25f, 0f)), emptyMap(), 100f, 100f)
    private fun plan(events: List<PresentationEvent>): CombatVisualPlan {
        val scene = BattleScene(BaseScene(emptyList(), 10, 10, 256f), PresentationRevision("r", "v", 14, 1, 0, events),
            mapOf("bowman" to "bow"), 256f, 100f, 10, 10)
        return CombatVisualPlan(scene, BattleVisualModel(events, 10), mapOf("bow" to art))
    }
    private val deploy = """{"t":0,"e":"deploy","id":1,"troop":"bowman","x":100,"y":100}"""
    private val fire = """{"t":1,"e":"troopFire","id":1,"ix":200,"iy":100}"""
    private val end = """{"t":15,"e":"star","n":1}"""

    @Test fun `arrow leaves authored nock only after draw and zero based release frame`() {
        val p = plan(listOf(deploy, fire, end).map(::event)); val out = mutableListOf<CombatSprite>()
        p.transientSprites(3.99f, out); assertTrue(out.isEmpty())
        p.transientSprites(4f, out); assertEquals(1, out.size)
        assertEquals(102.5f, out.single().x); assertEquals(85f, out.single().y)
        assertTrue(p.actor(1, 1f)!!.frameKey.startsWith("draw-d6"))
        assertTrue(p.actor(1, 3f)!!.frameKey.startsWith("loose-d6"))
        p.transientSprites(6f, out); assertTrue(out.single().frameKey.startsWith("impact"))
        assertEquals(200f, out.single().x)
    }
    @Test fun `seek rebuilds ongoing flight and subsequent sampling cannot duplicate it`() {
        val p = plan(listOf(deploy, fire, end).map(::event)); val out = mutableListOf<CombatSprite>()
        p.transientSprites(5f, out); val middle = out.toList()
        p.transientSprites(15f, out); assertTrue(out.isEmpty())
        p.transientSprites(5f, out); assertEquals(middle, out)
        p.transientSprites(5f, out); assertEquals(middle, out)
        assertTrue(out.single().y < 92.5f, "Arc rises above the straight ground segment")
    }
    @Test fun `death before release cancels shot while death after release preserves flight`() {
        val before = plan(listOf(deploy, fire, """{"t":3,"e":"troopDeath","id":1}""", end).map(::event))
        val after = plan(listOf(deploy, fire, """{"t":5,"e":"troopDeath","id":1}""", end).map(::event))
        assertEquals(0, before.flightCount); assertEquals(1, after.flightCount)
        assertTrue(before.actor(1, 3f)!!.frameKey.startsWith("death"))
        assertEquals(.5f, before.actor(1, 6.5f)!!.alpha)
        assertNull(before.actor(1, 7f))
    }
    @Test fun `compact attack runs own cycles and suppress matching legacy cues`() {
        val run = """{"t":1,"e":"attackRun","id":1,"count":2,"cadenceTicks":5,"mode":"projectile","technique":"arrow","ix":200,"iy":100}"""
        val p = plan(listOf(deploy, run, fire, end).map(::event))
        assertEquals(2, p.flightCount)
        assertTrue(p.actor(1, 6f)!!.frameKey.startsWith("draw"))
    }
    @Test fun `replacement discards superseded target while independently rebuilding the new flight`() {
        val old = plan(listOf(deploy, fire, end).map(::event))
        val next = plan(listOf(deploy, fire.replace("200", "300"), end).map(::event))
        val out = mutableListOf<CombatSprite>(); old.transientSprites(6f, out)
        assertEquals(200f, out.single().x)
        next.transientSprites(6f, out); assertEquals(300f, out.single().x)
    }
    @Test fun `authored attack bodies retain canonical hit tint without resurrecting past flashes after seek`() {
        val p = plan(listOf(deploy, fire, """{"t":3,"e":"hit","target":1,"dmg":42}""", end).map(::event))
        assertTrue(p.actor(1, 3.5f, hitCueTicks = 1f)!!.hit)
        assertTrue(p.actor(1, 3.5f)!!.frameKey.startsWith("loose"))
        assertFalse(p.actor(1, 3.5f, hitCueTicks = 1f, afterCueTick = 3.5f)!!.hit)
        assertFalse(p.actor(1, 4f, hitCueTicks = 1f)!!.hit)
    }

}
