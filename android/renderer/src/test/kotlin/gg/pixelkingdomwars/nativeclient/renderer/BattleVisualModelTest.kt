package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.test.*
import org.junit.Test

class BattleVisualModelTest {
    private fun event(json: String) = PresentationEvent.fromJson(json)

    @Test fun `battle interpolates canonical actor positions without calculating a path`() {
        val model = BattleVisualModel(listOf(
            event("""{"t":0,"e":"deploy","id":1,"troop":"barbarian","x":256,"y":512}"""),
            event("""{"t":10,"e":"pos","id":1,"x":512,"y":768}"""),
            event("""{"t":12,"e":"troopDeath","id":1}"""),
        ), positionCadenceTicks = 10)
        assertEquals(ActorPose("barbarian", 384f, 640f, true), model.pose(1, 5f))
        assertEquals(ActorPose("barbarian", 256f, 512f, true), model.pose(1, 5f, interpolate = false))
        assertEquals(ActorMotion("se", true), model.motion(1, 5f))
        assertNull(model.pose(1, 12f))
        assertEquals(ActorPose("barbarian", 256f, 512f, true), model.pose(1, 0f))
    }

    @Test fun `hero identity and canonical burrow exit cannot become donor art or an invented tween`() {
        val model = BattleVisualModel(listOf(
            event("""{"t":0,"e":"deploy","id":1,"troop":"barbarian","hero":"vex","x":0,"y":0}"""),
            event("""{"t":3,"e":"burrow","id":1}"""),
            event("""{"t":8,"e":"emerge","id":1,"x":256,"y":256}"""),
        ), positionCadenceTicks = 10)
        assertEquals("vex", model.pose(1, 0f)!!.identity)
        assertEquals(0f, model.pose(1, 2f)!!.x)
        assertFalse(model.pose(1, 4f)!!.visible)
        assertEquals(ActorPose("vex", 256f, 256f, true), model.pose(1, 8f))
    }

    @Test fun `late deployment is invisible before acceptance and same tick position order is retained`() {
        val model = BattleVisualModel(listOf(
            event("""{"t":5,"e":"deploy","id":1,"troop":"bowman","x":0,"y":0}"""),
            event("""{"t":5,"e":"pos","id":1,"x":128,"y":128}"""),
        ), positionCadenceTicks = 10)
        assertNull(model.pose(1, 4.9f))
        assertEquals(128f, model.pose(1, 5f)!!.x)
    }

    @Test fun `destroyed structures and hit cues follow canonical ticks and survive archive rewind`() {
        val model = BattleVisualModel(listOf(
            event("""{"t":2,"e":"hit","target":"keep","dmg":123}"""),
            event("""{"t":8,"e":"destroyed","id":"keep"}"""),
        ), positionCadenceTicks = 10)
        assertTrue(model.wasHit("keep", 2f, 1f))
        assertFalse(model.wasHit("keep", 2f, 1f, afterTick = 2f))
        assertFalse(model.wasHit("keep", 3f, 1f))
        assertTrue(model.isDestroyed("keep", 8f))
        assertFalse(model.isDestroyed("keep", 7f))
    }

    @Test fun `unsupported authored effect families remain observable to the application`() {
        val model = BattleVisualModel(listOf(
            event("""{"t":0,"e":"attackRun"}"""),
            event("""{"t":1,"e":"heroSkill"}"""),
            event("""{"t":2,"e":"star","n":1}"""),
        ), positionCadenceTicks = 10)
        assertEquals(setOf("attackRun", "heroSkill"), model.unsupportedEventTypes)
    }

    @Test fun `attack pause stays stationary until the final canonical movement cadence`() {
        val model = BattleVisualModel(listOf(
            event("""{"t":0,"e":"deploy","id":1,"troop":"bowman","x":0,"y":0}"""),
            event("""{"t":100,"e":"pos","id":1,"x":100,"y":0}"""),
        ), positionCadenceTicks = 10)
        assertEquals(0f, model.pose(1, 50f)!!.x)
        assertFalse(model.motion(1, 50f).moving)
        assertEquals(0f, model.pose(1, 90f)!!.x)
        assertEquals(50f, model.pose(1, 95f)!!.x)
        assertEquals(ActorMotion("e", true), model.motion(1, 95f))
        assertEquals(100f, model.pose(1, 100f)!!.x)
    }
    @Test fun `obsolete scene stops event parsing before it delays a newer revision`() {
        val events = List(1_000) { event("""{"t":0,"e":"star","n":1}""") }
        var checkpoints = 0
        assertFailsWith<java.util.concurrent.CancellationException> {
            BattleVisualModel(events, 1, checkpoint = {
                if (++checkpoints == 20) throw java.util.concurrent.CancellationException()
            })
        }
        assertEquals(20, checkpoints)
        // Only the obsolete visual derivative was cancelled; the original journal is intact.
        assertEquals(1_000, events.size)
        assertEquals(0, BattleVisualModel(events, 1).finalTick)
    }

}
