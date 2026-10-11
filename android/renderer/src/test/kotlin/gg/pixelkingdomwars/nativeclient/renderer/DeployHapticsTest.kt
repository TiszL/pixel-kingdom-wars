package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonWriter
import kotlin.test.*
import org.junit.Test

class DeployHapticsTest {
    private val reference=JsonReader().parse(checkNotNull(javaClass.getResourceAsStream("/sensory/source-reference.json")).bufferedReader().readText())
    private val policy=assertNotNull(SensoryPolicy.parse(reference.get("policy")))
    private fun plan(events:List<PresentationEvent>,units:Float=256f,selected:SensoryPolicy?=policy):CombatVisualPlan {
        val scene=BattleScene(BaseScene(emptyList(),5,5,1f),PresentationRevision("raid","rev",14,0,0,events),emptyMap(),units,100f,5,5)
        return CombatVisualPlan(scene,BattleVisualModel(events,5),emptyMap(),sensoryPolicy=selected)
    }
    private fun events(name:String)=reference.get("deployment").get("cases").first {it.getString("name")==name}.get("steps")
        .mapNotNull {it.get("event")?.toJson(JsonWriter.OutputType.json)?.let(PresentationEvent::fromJson)}
    private fun advance(p:BattleSensoryPlayback,t:Float,epoch:Long=1,control:Long=1,playing:Boolean=true,current:Boolean=true)=
        p.advance(t,0f,1f,playing,epoch,control,policy,10f,10f,1f,current)
    @Test fun `actual source deploy and spawn handlers preserve live actor dedup and death re-creation`() {
        for(name in listOf("unmarked","spawn-is-not-deploy","brood-is-not-deploy","ignored-brood-does-not-own-actor","same-id-after-death")) {
            val source=reference.get("deployment").get("cases").first {it.getString("name")==name}
            val cues=plan(events(name)).sensoryCues
            assertEquals(source.get("calls").map {it.asString()},cues.flatMap {it.effects}.map {(it as HeroSensory.Haptic).strength},name)
            assertTrue(cues.all {it.deployment!=null})
        }
        assertEquals(1,plan(events("duplicate-does-not-consume-next")).sensoryCues.size)
    }
    @Test fun `semantic tile and hero key use scene units and mathematical floor`() {
        val event=PresentationEvent.fromJson("""{"e":"deploy","t":1,"id":1,"troop":"giant","hero":"theodor","x":-1,"y":-65}""")
        val cue=assertNotNull(plan(listOf(event),units=64f).sensoryCues.single().deployment)
        assertEquals(DeployMarkerKey("giant","theodor",-1,-2),cue.key);assertEquals(event,cue.source)
    }
    @Test fun `only unmarked original actual-frame deployment emits and local suppression remains independent from sound`() {
        val cues=plan(events("unmarked")).sensoryCues
        for(suppressed in listOf(false,true)) {
            val observed=mutableListOf<DeployHaptic>()
            val p=BattleSensoryPlayback(deploymentHandled={observed+=it;suppressed});p.replace(cues,false)
            advance(p,0f)
            assertEquals(if(suppressed)emptyList() else listOf(policy.pattern("light")),advance(p,1f))
            assertTrue(advance(p,1f).isEmpty());assertEquals(listOf(cues.single().deployment),observed)
        }
    }
    @Test fun `cold seek pause motion and epoch resets hydrate silently and never queue a delayed deployment`() {
        for(kind in listOf("cold","seek","pause","epoch","motion")) {
            val observed=mutableListOf<DeployHaptic>()
            val p=BattleSensoryPlayback(deploymentHandled={observed+=it;false});p.replace(plan(events("unmarked")).sensoryCues,false)
            if(kind!="cold")advance(p,0f)
            assertTrue(advance(p,1f,epoch=if(kind=="epoch")2 else if(kind=="motion")-1 else 1,
                control=if(kind=="seek")2 else 1,playing=kind!="pause").isEmpty())
            assertTrue(observed.isNotEmpty(),kind)
            assertTrue(advance(p,1f).isEmpty());assertTrue(advance(p,2f).isEmpty())
        }
    }
    @Test fun `obsolete generation cannot consume marks while fresh initial zero remains distinct`() {
        val event=events("unmarked").single().copy(t=0,json=events("unmarked").single().json.replace("\"t\":1","\"t\":0"))
        var observations=0
        val p=BattleSensoryPlayback(deploymentHandled={observations++;false});p.replace(plan(listOf(event)).sensoryCues,true)
        assertTrue(advance(p,0f,current=false).isEmpty());assertEquals(0,observations)
        assertEquals(listOf(policy.pattern("light")),advance(p,0f));assertEquals(1,observations)
    }
    @Test fun `older optional event policy preserves historical behavior and malformed extension fails before GL`() {
        assertTrue(plan(events("unmarked"),selected=policy.copy(eventHaptics=policy.eventHaptics?.copy(deployment=null))).sensoryCues.isEmpty())
        val invalid=JsonReader().parse(reference.get("policy").toJson(JsonWriter.OutputType.json))
        invalid.get("eventHaptics").get("deployment").get("lifetime").set("invented-timeout")
        assertFailsWith<IllegalArgumentException> {SensoryPolicy.parse(invalid)}
    }
}
