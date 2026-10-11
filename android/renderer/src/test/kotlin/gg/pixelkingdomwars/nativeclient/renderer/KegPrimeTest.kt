package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonWriter
import java.io.File
import kotlin.test.*
import org.junit.Test

/** Execute the published scene/controller in tools/keg-prime-reference.mjs, then compare
 * its schedule and body contract against every currently admitted authored Keg tier. */
class KegPrimeTest {
    private val reader=JsonReader()
    private val reference=reader.parse(checkNotNull(javaClass.getResourceAsStream("/keg/prime-source-reference.json"))
        .bufferedReader().use { it.readText() })
    private val root=System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val render=reader.parse(root.resolve("render-catalog.json").readText())
    private val catalogue=reader.parse(root.resolve("catalogue.json").readText())
    private val art=CombatArt.catalogue(render)
    private val tickMs=catalogue.get("presentation").getFloat("tickMs")
    private val cadence=catalogue.get("constants").get("RAID_RULES").getInt("troopFireVisualTicks")
    private val entries=render.get("actors").filter { it.getString("type")=="kegrunner" }.distinctBy { it.getString("frameKey") }
    private fun event(s:String)=PresentationEvent.fromJson(s)
    private fun deploy(t:Int=0,x:Float=0f,y:Float=0f)="""{"e":"deploy","t":$t,"id":1,"troop":"kegrunner","x":$x,"y":$y}"""
    private fun detonate(t:Int=10)="""{"e":"detonate","t":$t,"id":1,"x":0,"y":0}"""
    private fun plan(events:List<String>,frame:String=entries.first().getString("frameKey"),cold:Float=0f,
                     buildings:List<RenderBuilding> = emptyList(),library:Map<String,CombatArt> = art):CombatVisualPlan {
        val ordered=events.map(::event).sortedBy { it.t }
        val scene=BattleScene(BaseScene(buildings,32,32,1f),
            PresentationRevision("keg","reference",reference.getInt("simVersion"),0,0,ordered),
            mapOf("kegrunner" to frame),1f,tickMs,cadence,cadence,
            presentationStart=if(cold>0)BattlePresentationStart.ColdPrefix(cold) else BattlePresentationStart.Continuous)
        return CombatVisualPlan(scene,BattleVisualModel(ordered,cadence),library)
    }
    @Test fun `all actual packed tiers match source authored prime metadata and loop lead`() {
        assertEquals(reference.getFloat("tickMs"),tickMs)
        assertEquals(4,entries.size)
        for((entry,tier) in entries.zip(reference.get("tiers"))) {
            val clip=art.getValue(entry.getString("frameKey")).clips.getValue("prime")
            assertEquals(tier.getString("key"),clip.key)
            assertEquals(tier.getFloat("fps"),clip.fps)
            assertTrue(clip.frames.all { it.size==tier.getInt("frames") })
            assertTrue(clip.loop)
            val p=plan(listOf(deploy(),detonate()),entry.getString("frameKey"))
            assertEquals(KegPrimePresentation(10f-tier.getFloat("lead"),10),p.actor(1,9f)?.kegPrime)
        }
    }
    @Test fun `source ordinary cold fractional deployment and death boundaries own exactly the prime interval`() {
        for(case in reference.get("cases"))for(entry in entries) {
            val name=case.getString("name")
            val death=case.get("deathTick").takeUnless { it.isNull }?.asInt()
            val events=listOfNotNull(deploy(case.getInt("deployTick")),death?.let { """{"e":"troopDeath","t":$it,"id":1}""" },detonate(case.getInt("detonateTick")))
            val p=plan(events,entry.getString("frameKey"),case.getFloat("fromTick"))
            val clip=art.getValue(entry.getString("frameKey")).clips.getValue("prime")
            for(sample in case.get("ticks")) {
                val tick=sample.getFloat("tick");val sprite=p.actor(1,tick)
                assertEquals(sample.getBoolean("priming"),sprite?.kegPrime!=null,"$name at $tick")
                if(sprite?.kegPrime!=null) {
                    assertEquals(case.getFloat("startTick"),sprite.kegPrime!!.startTick)
                    assertEquals(clip.frames[clip.row("s")][sample.getInt("frame1")-1],sprite.frameKey,"$name frame at $tick")
                }
            }
        }
    }
    @Test fun `actual renderer rebase restarts the owned prime loop instead of inheriting old prediction phase`() {
        val p=plan(listOf(deploy(),detonate()))
        val normal=assertNotNull(p.actor(1,8.5f))
        val replaced=assertNotNull(p.actor(1,8.5f,afterCueTick=8.5f))
        assertEquals(KegPrimePresentation(8.5f,10),replaced.kegPrime)
        assertTrue(replaced.frameKey.endsWith("_f1"));assertNotEquals(normal.frameKey,replaced.frameKey)
        assertNull(p.actor(1,10f,afterCueTick=10f)?.kegPrime)
    }
    @Test fun `nearest standing building faces prime once while later movement and destruction preserve it`() {
        val buildings=listOf(RenderBuilding("dead","",-2f,-1f,2f,1f),RenderBuilding("target","",10f,-1f,2f,1f))
        val p=plan(listOf(deploy(),"""{"e":"destroyed","t":4,"id":"dead"}""",
            """{"e":"pos","t":7,"id":1,"x":0,"y":-100}""",
            """{"e":"destroyed","t":6,"id":"target"}""",detonate()),buildings=buildings)
        val first=assertNotNull(p.actor(1,5f));val later=assertNotNull(p.actor(1,6.5f))
        assertNotEquals(first.y,later.y,"Prime must not stop the source's ordinary linear movement")
        assertEquals(first.frameKey.substringBeforeLast("_f"),later.frameKey.substringBeforeLast("_f"),"Face chosen at prime start survives target destruction and movement")
        assertEquals(first.y,first.depth);assertEquals(later.y,later.depth)
    }
    @Test fun `shared source hysteresis and near zero target rules do not invent a new facing threshold`() {
        val aim=art.values.firstNotNullOf { it.howl?.aim }
        for(case in reference.get("bodies")) {
            val point=case.get("point")
            val current=case.getString("current")
            val expected=case.get("first").getString("facing")
            assertEquals(expected,if(point.isNull)current else aim.facing(point.getFloat("x"),point.getFloat("y"),current))
            assertEquals(case.get("first").getString("facing"),case.get("continued").getString("facing"))
            assertEquals("run",case.get("cancelled").getString("clip"))
            if(case.getString("name").startsWith("native-")) {
                val target=RenderBuilding("target","",point.getFloat("x")-1,point.getFloat("y")-1,2f,1f)
                val sprite=assertNotNull(plan(listOf(deploy(),detonate()),buildings=listOf(target)).actor(1,5f))
                assertEquals(sprite.clip.frames[sprite.clip.row(expected)].first(),sprite.frameKey,
                    "Prime must apply the source shared helper to its actual body row")
            }
        }
    }
    @Test fun `reverse seeks and removal of the detonation discard future prime prediction`() {
        val p=plan(listOf(deploy(),detonate()))
        val samples=listOf(4f,5f,5.5f,9.5f,10f).associateWith { p.actor(1,it) }
        for(tick in samples.keys.reversed())assertEquals(samples[tick],p.actor(1,tick))
        val replaced=plan(listOf(deploy()))
        assertNull(replaced.actor(1,8f)?.kegPrime)
        assertFalse(replaced.actor(1,8f)?.clip?.key?.endsWith("_prime")==true)
    }
    @Test fun `missing or zero fps prime art supplies no synthetic phase`() {
        val frame=entries.first().getString("frameKey");val original=art.getValue(frame)
        for(clips in listOf(original.clips-"prime",original.clips+("prime" to original.clips.getValue("prime").copy(fps=0f)))) {
            val p=plan(listOf(deploy(),detonate()),library=art+(frame to original.copy(clips=clips)))
            assertNull(p.actor(1,8f)?.kegPrime)
        }
    }
    @Test fun `historical admitted renderer nine keeps body and blast without unavailable shared prime facing`() {
        val entry=entries.first();val profile=render.get("combatProfiles").get(entry.getString("combatKey"))
        val frame=entry.getString("frameKey")
        val old=reader.parse("""{"rendererContractVersion":9,"combatProfiles":{"keg":${profile.toJson(JsonWriter.OutputType.json)}},"actors":[{"type":"kegrunner","frameKey":"$frame","combatKey":"keg"}]}""")
        val p=plan(listOf(deploy(),detonate()),library=CombatArt.catalogue(old),
            buildings=listOf(RenderBuilding("target","",10f,0f,2f,1f)))
        val body=assertNotNull(p.actor(1,8f))
        assertNull(body.kegPrime);assertFalse(body.clip.key.endsWith("_prime"))
        assertTrue("kegPrimeFacing" in p.missingCoverage)
        val clip=art.getValue(frame).clips.getValue("detonate")
        val release=10f+(clip.fxCues.getValue("keg_blast").first()-1)*1000f/clip.fps/tickMs
        val output=mutableListOf<CombatSprite>();p.transientSprites(release+.001f,output)
        assertTrue(output.any { it.clip.key==clip.effectByCue.getValue("keg_blast") },
            "Missing newer facing metadata must preserve the blast at its authored release frame")
    }
    @Test fun `inconsistent shared aiming rejects preparation before any render frame`() {
        val first=art.values.first { it.howl!=null };val howl=assertNotNull(first.howl)
        val different=first.copy(howl=howl.copy(aim=howl.aim.copy(retainWithinDegrees=howl.aim.retainWithinDegrees+1)))
        assertFailsWith<IllegalArgumentException> { plan(listOf(deploy(),detonate()),library=art+("inconsistent" to different)) }
    }
    @Test fun `ordinary death never manufactures a detonation or a prime cue`() {
        val p=plan(listOf(deploy(),"""{"e":"troopDeath","t":10,"id":1}"""))
        assertNull(p.actor(1,8f)?.kegPrime)
        val output=mutableListOf<CombatSprite>();p.transientSprites(10f,output)
        assertTrue(output.isEmpty())
    }
}
