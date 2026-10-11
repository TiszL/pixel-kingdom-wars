package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import java.io.File
import kotlin.test.*
import org.junit.Test

/** Actual sim emissions and executed web-controller expectations, against the actual pinned art.
 * This is presentation evidence. A Tails refundPct is never proof of a server refund. */
class HeroCoinFlipPackTest {
    private val reader=JsonReader()
    private val reference=reader.parse(checkNotNull(javaClass.getResourceAsStream("/hero/coin-source-reference.json"))
        .bufferedReader().use { it.readText() })
    private val root=System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val render=reader.parse(root.resolve("render-catalog.json").readText())
    private val catalogue=reader.parse(root.resolve("catalogue.json").readText())
    private val library=CombatArt.catalogue(render)
    private val frames=render.get("actors").filter { it.getInt("level",1)==1 }.associate { it.getString("type") to it.getString("frameKey") }
    private val art=library.getValue(frames.getValue("vex"))
    private val presentation=catalogue.get("presentation")
    private val tickMs=presentation.getFloat("tickMs")
    private fun coin(case:JsonValue)=case.get("events").single { it.getString("e")=="heroSkill" }
    private fun key(case:JsonValue)=coin(case).let { "${it.getString("skill")}:${it.getString("phase")}" }
    private fun plan(case:JsonValue,withoutCoin:Boolean=false):CombatVisualPlan {
        val events=case.get("events").filter { !withoutCoin || it.getString("e")!="heroSkill" }
            .map { PresentationEvent.fromJson(it.toJson(JsonWriter.OutputType.json)) }
        val constants=catalogue.get("constants")
        val cadence=constants.get("RAID_RULES").getInt("troopFireVisualTicks")
        val summoned=constants.get("TROOP_ABILITIES").get("hexbarrow").get("brood").getInt("positionKeyframeTicks")
        val scene=BattleScene(BaseScene(emptyList(),32,32,presentation.getFloat("tilePixels")),
            PresentationRevision("actual-coin-${case.getString("face")}","source-reference",catalogue.getInt("simVersion"),0,0,events),
            frames,presentation.getFloat("unitsPerTile"),tickMs,cadence,summoned)
        return CombatVisualPlan(scene,BattleVisualModel(events,cadence,summoned),library)
    }

    @Test fun `both actual coin faces require exact exported body and effect contracts`() {
        assertEquals(reference.getInt("simVersion"),catalogue.getInt("simVersion"))
        assertEquals(reference.getFloat("tickMs"),tickMs)
        for(case in reference.get("cases")) {
            val key=key(case)
            val body=assertNotNull(art.profile.get("heroSkills").get(key),
                "Missing actual emitted $key; a generic doubleOrNothing map cannot cover exact native lookup")
            val expected=case.get("body")
            assertEquals(expected.get("frames").map { it.asString() },art.clips.getValue(body.getString("state")).frames.single())
            assertEquals(expected.getBoolean("once"),body.getBoolean("once"))
            assertEquals(expected.getInt("priority"),body.getInt("priority"))
            val sweep=assertNotNull(art.heroEffects[key],"Missing actual emitted $key effect").effects.single()
            val source=case.get("sweeps").single()
            assertEquals(source.get("frames").map { it.asString() },sweep.clip.frames.single())
            assertEquals(source.getFloat("stepMs"),1000f/sweep.clip.fps)
            assertEquals(source.getFloat("lifetimeMs"),sweep.lifetimeMs)
            assertEquals(source.getFloat("scale"),sweep.clip.scale)
            assertEquals(source.getFloat("depth"),sweep.depth)
            assertEquals(source.get("anchor").getFloat(0),sweep.clip.anchorX)
            assertEquals(source.get("anchor").getFloat(1),sweep.clip.anchorY)
        }
    }

    @Test fun `same-tick Tails death outranks taunt while Heads uses its authored revive body`() {
        for(case in reference.get("cases")) {
            val event=coin(case);val tick=event.getFloat("t");val id=event.getInt("id")
            val p=plan(case)
            val expectedState=if(case.getString("face")=="tails") {
                val death=case.get("events").single { it.getString("e")=="troopDeath" }
                assertEquals(event.getInt("t"),death.getInt("t"))
                art.profile.getString("death")
            } else assertNotNull(art.profile.get("heroSkills").get(key(case))).getString("state")
            assertEquals(art.clips.getValue(expectedState).key,assertNotNull(p.actor(id,tick)).clip.key)
            assertTrue(p.missingCoverage.isEmpty(),"${key(case)}: ${p.missingCoverage}")
        }
    }

    @Test fun `actual coin sweep keeps every authored frame and hold after death then expires across seeks`() {
        for(case in reference.get("cases")) {
            val event=coin(case);val tick=event.getFloat("t")
            val sweep=assertNotNull(art.heroEffects[key(case)],"Actual coin must be exported").effects.single()
            val p=plan(case);val output=mutableListOf<CombatSprite>()
            p.transientSprites(tick-.01f,output);assertTrue(output.isEmpty())
            val source=case.get("sweeps").single()
            for((index,frame) in source.get("frames").withIndex()) {
                // Sample just inside each frame to avoid float conversion at the exact boundary.
                p.transientSprites(tick+(index*source.getFloat("stepMs")+.01f)/tickMs,output)
                assertEquals(frame.asString(),output.single().frameKey)
            }
            val holdTick=tick+(sweep.clip.durationMs+sweep.lifetimeMs)/2/tickMs
            p.transientSprites(holdTick,output)
            assertEquals(sweep.clip.frames.single().last(),output.single().frameKey)
            assertEquals(event.getFloat("x")*presentation.getFloat("tilePixels")/presentation.getFloat("unitsPerTile"),output.single().x,.001f)
            assertEquals(event.getFloat("y")*presentation.getFloat("tilePixels")/presentation.getFloat("unitsPerTile"),output.single().y,.001f)
            val held=output.toList()
            p.transientSprites(tick+(sweep.lifetimeMs+.01f)/tickMs,output);assertTrue(output.isEmpty())
            p.transientSprites(holdTick,output);assertEquals(held,output,"Seeking reconstructs one coin, including after death")
            plan(case,withoutCoin=true).transientSprites(holdTick,output)
            assertTrue(output.isEmpty(),"Authoritative revision removal clears the predicted coin without a stale effect")
        }
    }
}
