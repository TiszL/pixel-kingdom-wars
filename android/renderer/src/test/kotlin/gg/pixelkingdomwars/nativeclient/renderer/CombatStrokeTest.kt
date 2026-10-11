package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import org.junit.Test
import kotlin.test.*

class CombatStrokeTest {
    private val clip = AuthoredClip("tower","atlas/tower.json",listOf(listOf("a","b","c")),listOf("s"),10f,.5f,1f,1f,20f,40f,false,
        JsonReader().parse("""{"muzzle":[[[12,10],[12,10],[12,10]]]}"""),emptyMap())
    private val profile = StrokeProfile(200f,900f,listOf(StrokeLayer(3f,0xabcdef,.8f),StrokeLayer(1f,0xffffff,1f)))
    private val art = CombatArt(mapOf("idle" to clip,"fire" to clip),
        JsonReader().parse("""{"stand":"idle","firePlans":{"beam:far":{"states":["fire"],"releaseState":"fire","releaseFrame":2,"shot":"laser"}}}"""),
        mapOf("laser" to ProjectileProfile(null,clip,null,50f,0f,1f,0f,stroke=profile)),emptyMap(),0f,0f,
        chain=ChainArt(profile,.25f,-7f,clip))
    private fun plan(extra: List<String>): CombatVisualPlan {
        val events=(listOf("""{"e":"deploy","t":0,"id":1,"troop":"bowman","x":70,"y":80}""",
            """{"e":"deploy","t":0,"id":2,"troop":"bowman","x":100,"y":130}""")+extra+
            """{"e":"star","t":10,"n":1}""").map(PresentationEvent::fromJson)
        val scene=BattleScene(BaseScene(listOf(RenderBuilding("tower","tower",1f,2f,2f,2f)),32,32,10f),
            PresentationRevision("raid","rev",14,1,0,events),emptyMap(),10f,100f,10,10)
        return CombatVisualPlan(scene,BattleVisualModel(events,10),mapOf("tower" to art))
    }
    private val fire="""{"e":"fire","t":1,"id":"tower","proj":"beam","ix":70,"iy":80}"""
    @Test fun `laser begins at authored muzzle release and fades until exclusive canonical expiry`() {
        val plan=plan(listOf(fire));val strokes=mutableListOf<CombatStroke>()
        plan.transientStrokes(1.99f,strokes);assertTrue(strokes.isEmpty())
        plan.transientStrokes(2f,strokes);assertEquals(2,strokes.size)
        assertEquals(22f,strokes.first().fromX);assertEquals(10f,strokes.first().fromY)
        assertEquals(70f,strokes.first().toX);assertEquals(.8f,strokes.first().alpha)
        plan.transientStrokes(3f,strokes);assertEquals(.4f,strokes.first().alpha)
        plan.transientStrokes(4f,strokes);assertTrue(strokes.isEmpty())
        assertFalse("laserBeamStroke" in plan.missingCoverage)
    }
    @Test fun `chain follows published hop order and freezes endpoints across seeking movement and replacement`() {
        val chain="""{"e":"chain","t":1,"id":"tower","targets":[1,2],"dmg":[11,22]}"""
        val atChain="""{"e":"pos","t":1,"id":1,"x":70,"y":80}"""
        val movement="""{"e":"pos","t":2,"id":1,"x":400,"y":500}"""
        val plan=plan(listOf(atChain,chain,movement));val strokes=mutableListOf<CombatStroke>()
        plan.transientStrokes(1.5f,strokes);val initial=strokes.toList()
        assertEquals(4,initial.size);assertEquals(30f,initial.first().fromY)
        assertEquals(73f,initial.first().toY);assertEquals(70f,initial[2].fromX);assertEquals(123f,initial[2].toY)
        plan.transientStrokes(2.5f,strokes);assertEquals(70f,strokes.first().toX)
        plan.transientStrokes(10f,strokes);assertTrue(strokes.isEmpty())
        plan.transientStrokes(1.5f,strokes);assertEquals(initial,strokes)
        val replaced=plan(listOf(atChain,chain.replace("[1,2]","[2,1]"),movement))
        replaced.transientStrokes(1.5f,strokes);assertEquals(100f,strokes.first().toX);assertEquals(70f,strokes[2].toX)
    }
    @Test fun `destroyed defense cannot release a future predicted laser`() {
        val plan=plan(listOf(fire,"""{"e":"destroyed","t":2,"id":"tower"}"""));val strokes=mutableListOf<CombatStroke>()
        plan.transientStrokes(2.5f,strokes);assertTrue(strokes.isEmpty())
    }
}
