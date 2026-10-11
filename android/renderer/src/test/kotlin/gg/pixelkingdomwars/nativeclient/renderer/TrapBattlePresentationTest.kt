package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import java.io.File
import org.junit.Test
import kotlin.test.*

class TrapBattlePresentationTest {
    private val root=System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val render=JsonReader().parse(root.resolve("render-catalog.json").readText())
    private val library=CombatArt.catalogue(render)
    private val types=setOf("spiketrap","powdermine","pitfall","airmine")
    private val entries=render.get("entries").filter { it.getString("type") in types }
    private fun art(entry:JsonValue,legacy:Boolean=false):CombatArt {
        val a=library.getValue(entry.getString("frameKey"))
        val profile=JsonReader().parse(a.profile.toJson(JsonWriter.OutputType.json))
        // The current pack must carry the source-exported battle rest itself.
        // Only the retained-contract case removes the additive field.
        if(legacy)profile.remove("battleStand")
        return a.copy(profile=profile)
    }
    private fun plan(entry:JsonValue,events:List<String> = emptyList(),spent:Boolean=false,cold:Float?=null,legacy:Boolean=false):CombatVisualPlan {
        val key=entry.getString("frameKey")
        val building=RenderBuilding("trap",key,2f,2f,1f,1f,type=entry.getString("type"),trapSpent=spent)
        val parsed=events.map(PresentationEvent::fromJson)
        val scene=BattleScene(BaseScene(listOf(building),30,30,64f),PresentationRevision("trap","fixture",14,0,0,parsed),emptyMap(),256f,100f,1,1,
            presentationStart=cold?.let { BattlePresentationStart.ColdPrefix(it) } ?: BattlePresentationStart.Continuous)
        return CombatVisualPlan(scene,BattleVisualModel(parsed,1),mapOf(key to art(entry,legacy)),.5f)
    }
    private fun trigger(t:Int)="""{"t":$t,"e":"trap","id":"trap"}"""
    private fun state(entry:JsonValue,p:CombatVisualPlan,t:Float,name:String) {
        assertTrue(p.building("trap",t)!!.frameKey in art(entry).clips.getValue(name).frames.flatten(),"${entry.getString("type")} at $t must use $name")
    }
    @Test fun `all authored trap levels hide ground traps in battle while preserving drifting air mines and owner rest`() {
        assertEquals(types,entries.map { it.getString("type") }.toSet())
        for(e in entries) {
            val p=plan(e);val type=e.getString("type");val name=if(type=="airmine")"drift" else "hidden"
            assertEquals(name,art(e).profile.getString("battleStand"),"The real pack must admit the defender-view rest, not a test-injected replacement")
            state(e,p,0f,name);state(e,p,5f,name)
            assertEquals(if(type=="airmine")"drift" else "armed",art(e).profile.getString("stand"),"Shared owner rest must stay unchanged")
            state(e,plan(e,legacy=true),0f,art(e,true).profile.getString("stand"))
            if(type=="airmine")assertNotEquals(p.building("trap",0f)!!.frameKey,p.building("trap",2f)!!.frameKey)
        }
    }
    @Test fun `initial spent and cold historical traps stay spent and cannot replay a consumed episode`() {
        for(e in entries) {
            val already=plan(e,listOf(trigger(10)),spent=true)
            for(t in listOf(0f,10f,11f,100f))state(e,already,t,"sprung")
            val restored=plan(e,listOf(trigger(10)),cold=10.01f)
            state(e,restored,10.01f,"sprung");state(e,restored,11f,"sprung")
            state(e,plan(e,listOf(trigger(10)),cold=10f),10f,art(e).profile.get("attack").first().asString())
        }
    }
    @Test fun `first trigger owns authored arm trigger sprung timing and revisions seek without replaying duplicate triggers`() {
        for(e in entries) {
            val a=art(e);val p=plan(e,listOf(trigger(10),trigger(11),trigger(100)))
            val single=plan(e,listOf(trigger(10)))
            var now=10f
            for(name in a.profile.get("attack").map { it.asString() }) {
                state(e,p,now,name)
                assertEquals(single.building("trap",now),p.building("trap",now),"Duplicate orders cannot restart a trap")
                now+=a.clips.getValue(name).durationMs/100f
            }
            state(e,p,now,"sprung");state(e,p,100f,"sprung")
            state(e,p,9f,a.profile.getString("battleStand"))
            state(e,plan(e),11f,a.profile.getString("battleStand"))
        }
    }
}
