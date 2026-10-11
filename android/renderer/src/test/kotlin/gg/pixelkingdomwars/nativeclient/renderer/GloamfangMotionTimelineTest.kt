package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import kotlin.math.hypot
import kotlin.test.*
import org.junit.Test

class GloamfangMotionTimelineTest {
    private val clip = AuthoredClip("body", "atlas/body.json", List(8) { r -> List(8) { "$r-$it" } },
        listOf("e", "se", "s", "sw", "w", "nw", "n", "ne"), 10f, .5f, .5f, 1f, 20f, 20f, false, null, emptyMap())
    private val art = CombatArt(mapOf("leap" to clip, "lunge" to clip, "howl" to clip,
        "prowl" to clip, "death" to clip, "rend" to clip),
        JsonReader().parse("""{"stand":"prowl","move":"prowl","melee":{"troop":"rend","building":"rend"},"death":"death"}"""),
        emptyMap(), emptyMap(), 0f, 0f,
        howl = HowlArt("howl", 3, 0f, 0f, 0f, clip, HowlAimArt(.25f, 32.5f)),
        leap = LeapMotionArt("leap", 600f, .3f, HowlAimArt(.25f, 32.5f), 1f))
    private val deploy = """{"e":"deploy","t":0,"id":1,"x":0,"y":0}"""
    private fun ability(t: Int = 0, name: String = "leap", x: Int = 0, y: Int = 0, aim: Boolean = true) =
        """{"e":"troopAbility","t":$t,"id":1,"ability":"$name","x":$x,"y":$y${if (aim) ",\"ix\":200,\"iy\":40" else ""}}"""
    private fun pos(t: Int, x: Int = 320, y: Int = 80) = """{"e":"pos","t":$t,"id":1,"x":$x,"y":$y}"""
    private fun plan(events: List<String>, overrides: Map<Int, PositionDelivery>? = null): GloamfangMotionTimeline {
        val parsed = events.map(PresentationEvent::fromJson)
        return GloamfangMotionTimeline(parsed, 1, overrides ?: PositionDelivery.compile(parsed, 5, 2, 100f),
            art, 100f, 1f, 600f, .3f, 1f)
    }
    private fun arc(ms: Float): Pair<Float, Float> {
        val p = ms / 600f
        return 200f * p to 40f * p - hypot(200f, 40f) * .3f * 4f * p * (1f - p)
    }

    @Test fun `Leap independently samples elevated sprite ground depth and longer body`() {
        val p = plan(listOf(deploy, ability()))
        val middle = p.sample(3f)!!
        assertEquals(100f, middle.x); assertEquals(20f, middle.groundY)
        assertEquals(arc(300f).second, middle.y, .0001f)
        assertEquals("leap", p.sample(7f)!!.clipState, "Body continues after the 600ms transform")
        assertEquals(200f, p.sample(7f)!!.x)
        assertEquals("prowl", p.sample(8f)!!.clipState)
        assertEquals(800f, p.sample(8f)!!.phaseStartMs)
        assertEquals(middle, p.sample(3f), "Seeking reconstructs the identical pose")
    }

    @Test fun `later sprite writer overrides arc then completed short writer yields back to counter`() {
        // Continuous counterpart of coexistence/short-pos: no copied Phaser manager cadence.
        val p = plan(listOf(deploy, ability(), pos(4)), mapOf(2 to PositionDelivery(2, 2f, 200f)))
        val start = arc(200f)
        val middle = p.sample(3f)!!
        assertEquals((start.first + 320f) / 2, middle.x, .0001f)
        assertEquals((start.second + 80f) / 2, middle.y, .0001f)
        assertEquals(middle.y, middle.groundY, "Ordinary writer owns actor depth while active")
        assertEquals(320f, p.sample(4f)!!.x, "Completion frame retains the delivered endpoint")
        assertEquals(arc(410f).first, p.sample(4.1f)!!.x, .0001f)
        assertEquals("leap", middle.clipState)
    }

    @Test fun `replacement writer captures surviving arc not displaced predecessor and can outlive it`() {
        val p = plan(listOf(deploy, ability(), pos(10), pos(12, 80, 120)), mapOf(
            2 to PositionDelivery(2, 2f, 800f), 3 to PositionDelivery(3, 3f, 900f)))
        val atReplacement = p.sample(3f)!!
        assertEquals(arc(300f).first, atReplacement.x, .0001f)
        assertEquals(arc(300f).second, atReplacement.y, .0001f)
        assertEquals("prowl", p.sample(8.1f)!!.clipState)
        assertTrue(p.sample(8.1f)!!.moving)
        assertEquals(800f, p.sample(8.1f)!!.phaseStartMs)
        assertEquals(80f, p.sample(12f)!!.x)
        assertFalse(p.sample(12f)!!.moving)
        assertEquals(800f, p.sample(13f)!!.phaseStartMs, "Locomotion to idle retains the same prowl registration")
    }

    @Test fun `death freezes actual competing writer pose depth and cancels future completion`() {
        val before = plan(listOf(deploy, ability(), pos(10)), mapOf(2 to PositionDelivery(2, 2f, 800f))).sample(3f)!!
        val p = plan(listOf(deploy, ability(), """{"e":"troopDeath","t":3,"id":1}""", pos(10)),
            mapOf(3 to PositionDelivery(3, 2f, 800f)))
        for (t in listOf(3f, 7f, 20f)) {
            val dead = p.sample(t)!!
            assertFalse(dead.alive); assertEquals("death", dead.clipState)
            assertEquals(before.x, dead.x); assertEquals(before.y, dead.y); assertEquals(before.groundY, dead.groundY)
            assertEquals(300f, dead.phaseStartMs)
        }
    }

    @Test fun `source delivered landing consumes Lunge after cast and cancels its keyed body`() {
        val p = plan(listOf(deploy, ability(10, "lunge", 400, 360), pos(15, 570, 360)))
        val before = p.sample(10f, beforeEventOrdinal = 2)!!
        assertEquals("lunge", before.clipState); assertEquals(400f, before.x)
        val after = p.sample(10f)!!
        assertEquals("prowl", after.clipState); assertEquals(570f, after.x)
        assertNotEquals(before.bodyOwner, after.bodyOwner)
        assertEquals(0f, p.bodyActions.single { it.state == "lunge" }.let { it.endMs - it.startMs })
    }

    @Test fun `pending Lunge snap survives later Howl and still consumes actual endpoint`() {
        val p = plan(listOf(deploy, ability(0, "lunge"), ability(1, "howl", 90, 60, false), pos(8, 570, 360)),
            mapOf(3 to PositionDelivery(3, 3f, 500f)))
        assertEquals("howl", p.sample(2f)!!.clipState)
        assertEquals(570f, p.sample(3f)!!.x)
        assertEquals("prowl", p.sample(3f)!!.clipState)
    }

    @Test fun `missing target snaps and cancels motion without replacing the current body`() {
        val p = plan(listOf(deploy, ability(), ability(2, "lunge", 500, 80, false)))
        val first = p.sample(1f)!!; val later = p.sample(3f)!!
        assertEquals(first.bodyOwner, later.bodyOwner); assertEquals(0f, later.phaseStartMs)
        assertEquals("leap", later.clipState); assertEquals(500f, later.x); assertEquals(80f, later.groundY)
        assertEquals(500f, p.sample(7f)!!.x, "Canceled old counter cannot later land at its original target")
    }

    @Test fun `absolute snap preserves body but a replacement revision discards its old motion`() {
        val p = plan(listOf(deploy, ability(), """{"e":"emerge","t":2,"id":1,"x":90,"y":60}"""))
        assertEquals("leap", p.sample(3f)!!.clipState); assertEquals(90f, p.sample(9f)!!.x)
        assertEquals(0f, plan(listOf(deploy)).sample(3f)!!.x)
    }

    @Test fun `melee replaces body and facing without canceling the Leap counter`() {
        val attack = """{"e":"troopAttack","t":2,"id":1,"target":9,"ix":-100,"iy":0}"""
        val p = plan(listOf(deploy, ability(), attack))
        val hit = p.sample(3f)!!
        assertEquals("rend", hit.clipState); assertEquals(arc(300f).first, hit.x, .0001f)
        assertEquals(200f, hit.phaseStartMs)
        assertEquals(200f, p.bodyActions.single { it.state == "leap" }.endMs)
    }

    @Test fun `attack runs expand unique body owners and suppress bounded legacy duplicates`() {
        val run = """{"e":"attackRun","t":1,"id":1,"mode":"melee","technique":"rend","targetKind":"troop","ix":100,"iy":0,"count":2,"cadenceTicks":3}"""
        val legacy = """{"e":"troopAttack","t":1,"id":1,"target":9,"ix":100,"iy":0}"""
        val p = plan(listOf(deploy, run, legacy, """{"e":"star","t":6,"id":1}"""))
        val actions = p.bodyActions.filter { it.state == "rend" }
        assertEquals(listOf(100f, 400f), actions.map { it.startMs })
        assertEquals(listOf(1, 1), actions.map { it.eventOrdinal })
        assertNotEquals(actions[0].owner, actions[1].owner)
    }

    @Test fun `real mixed journals keep building UUIDs and idless outcomes out of actor motion`() {
        val plain = plan(listOf(deploy, ability()))
        val mixed = plan(listOf(deploy, ability(),
            """{"e":"fire","t":1,"id":"3a8ed159-aeb0-4e16-8de2-2c64972bd5bd","target":1}""",
            """{"e":"destroyed","t":2,"id":"3a8ed159-aeb0-4e16-8de2-2c64972bd5bd"}""",
            """{"e":"star","t":3,"n":1}"""))
        assertEquals(plain.sample(3f), mixed.sample(3f))
        assertEquals(plain.bodyActions, mixed.bodyActions)
    }

    @Test fun `zero distance correction replaces ordinary writer but surviving Leap resumes next instant`() {
        val target = arc(200f)
        val correction = """{"e":"pos","t":4,"id":1,"x":${target.first},"y":${target.second}}"""
        val p = plan(listOf(deploy, ability(), correction), mapOf(2 to PositionDelivery(2, 2f, 200f)))
        assertEquals(target.first, p.sample(2f)!!.x, .0001f)
        assertFalse(p.sample(2f)!!.moving)
        assertEquals(arc(300f).first, p.sample(3f)!!.x, .0001f)
        assertEquals(arc(300f).second, p.sample(3f)!!.y, .0001f)
        assertEquals("leap", p.sample(3f)!!.clipState)
    }

    @Test fun `zero duration sprite delivery has one exact endpoint then yields to living counter`() {
        val p = plan(listOf(deploy, ability(), pos(2)), mapOf(2 to PositionDelivery(2, 2f, 0f)))
        assertEquals(320f, p.sample(2f)!!.x)
        assertEquals(arc(201f).first, p.sample(2.01f)!!.x, .0001f)
        assertEquals("leap", p.sample(2.01f)!!.clipState)
        assertFalse(p.sample(2.01f)!!.moving)
    }

    @Test fun `counter that outlives body remains visible and contributes a finite completion extent`() {
        val events = listOf(deploy, ability()).map(PresentationEvent::fromJson)
        val p = GloamfangMotionTimeline(events, 1, emptyMap(), art, 100f, 1f, 1000f, .3f, 1f)
        assertEquals("prowl", p.sample(9f)!!.clipState)
        assertEquals(180f, p.sample(9f)!!.x)
        assertEquals(1000f, p.motionEndMs)
        assertEquals(200f, p.sample(10f)!!.x)
    }

    @Test fun `shared parsed grouping retains ordinal guards and stand callback sees actual source ordering`() {
        val events = listOf(deploy, ability(10, "lunge", 400, 360), pos(15, 570, 360)).map(PresentationEvent::fromJson)
        val calls = mutableListOf<Pair<Float, Int>>()
        val p = GloamfangMotionTimeline(events, 1, PositionDelivery.compile(events, 5, 2, 100f), art, 100f, 1f,
            actorEvents = events.mapIndexed { i, e -> i to JsonReader().parse(e.json) },
            nearestStandTarget = { ms, ordinal, x, y -> calls += ms to ordinal; (x - 100f) to y })
        assertEquals(listOf(1000f to 2), calls)
        assertEquals("w", p.sample(10f)!!.facing)
        assertEquals("lunge", p.sample(10f, 2)!!.clipState)
    }
}
