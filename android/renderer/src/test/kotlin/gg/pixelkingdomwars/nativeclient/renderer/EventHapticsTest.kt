package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonWriter
import kotlin.test.*
import org.junit.Test

class EventHapticsTest {
    private val reader=JsonReader()
    private val reference=reader.parse(checkNotNull(javaClass.getResourceAsStream("/sensory/source-reference.json")).bufferedReader().readText())
    private val policy=assertNotNull(SensoryPolicy.parse(reference.get("policy")))
    private fun plan(records:List<String>,present:Boolean=true,start:BattlePresentationStart=BattlePresentationStart.Continuous,
                     selected:SensoryPolicy?=policy,type:String?=null):CombatVisualPlan {
        val events=records.map(PresentationEvent::fromJson)
        val service=type?.let { RenderServiceIdentity(it,if(it=="berth")null else 1) }
        val scene=BattleScene(BaseScene(if(present)listOf(RenderBuilding("base","fixture",0f,0f,
            if(service==null)1f else 2f,if(service==null)1f else 2f,type=type,service=service)) else emptyList(),4,4,1f),
            PresentationRevision("raid","rev",if(service==null)14 else 18,0,0,events),emptyMap(),1f,100f,5,5,presentationStart=start)
        return CombatVisualPlan(scene,BattleVisualModel(events,5),emptyMap(),sensoryPolicy=selected)
    }
    private fun records(name:String)=reference.get("eventCases").first { it.getString("name")==name }.get("events")
        .map { it.toJson(JsonWriter.OutputType.json) }
    private fun advance(p:BattleSensoryPlayback,t:Float,epoch:Long=1,control:Long=1,playing:Boolean=true)=
        p.advance(t,10f,1f,playing,epoch,control,policy,100f,100f,1f)
    @Test fun `all actual canonical event handlers match admission strength and duplicate behavior`() {
        for(case in reference.get("eventCases")) {
            val p=plan(case.get("events").map { it.toJson(JsonWriter.OutputType.json) },case.getBoolean("present"),
                if(case.getBoolean("jumping"))BattlePresentationStart.ColdPrefix(2f) else BattlePresentationStart.Continuous,
                type=case.getString("type",null))
            assertEquals(case.get("calls").map { it.asString() },p.sensoryCues.flatMap { it.effects }.map { (it as HeroSensory.Haptic).strength },case.getString("name"))
            assertEquals(p.sensoryCues.map { it.ordinal }.sorted(),p.sensoryCues.map { it.ordinal })
        }
    }
    @Test fun `a live service collapse plays the canonical light haptic and a cold one stays silent`() {
        // 2026-10-10 (D21): the lock source 427381a2 plays haptic('light') on every live collapse before its Market/berth
        // routing; the earlier native early return for service buildings followed the retired codex line (0f07cd39).
        val destroyed="""{"e":"destroyed","t":3,"id":"base"}"""
        for(type in listOf("workshop","lodge","market","harvester","berth")) {
            assertEquals(listOf("light"),plan(listOf(destroyed),type=type).sensoryCues.flatMap { it.effects }.map { (it as HeroSensory.Haptic).strength },type)
            assertTrue(plan(listOf(destroyed),type=type,start=BattlePresentationStart.ColdPrefix(4f)).sensoryCues.isEmpty(),type)
            assertTrue(plan(listOf(destroyed),present=false,type=type).sensoryCues.isEmpty(),"$type: absent building")
        }
    }
    @Test fun `same tick event order keeps later light after heavy and is independent of camera budget`() {
        val cues=plan(records("same-time-source-order")).sensoryCues
        assertTrue(cues.size>policy.concurrentShakeCap)
        val playback=BattleSensoryPlayback();playback.replace(cues,false);advance(playback,0f)
        val expected=listOf("heavy","medium","light","light").map { policy.pattern(it) }
        assertEquals(expected,advance(playback,1f));assertTrue(advance(playback,1f).isEmpty())
        assertEquals(SensoryOffset(),playback.offset,"These events add no camera cue")
    }
    @Test fun `new event extension is optional and old medium quake pattern remains intact`() {
        val old=policy.copy(eventHaptics=null)
        assertTrue(plan(records("same-time-source-order"),selected=old).sensoryCues.isEmpty())
        assertTrue(plan(records("rally"),selected=null).sensoryCues.isEmpty())
        assertEquals(HapticPattern(listOf(old.mediumHapticMs)),old.pattern("medium"));assertNull(old.pattern("heavy"))
    }
    @Test fun `cold fractional history stays silent but fresh actual zero may deliver once`() {
        val events=listOf("""{"e":"rally","t":0}""","""{"e":"star","t":1,"n":3}""")
        assertEquals(listOf(1f),plan(events,start=BattlePresentationStart.ColdPrefix(.5f)).sensoryCues.map { it.atTick })
        for(fresh in listOf(true,false)) {
            val p=BattleSensoryPlayback();p.replace(plan(events).sensoryCues,fresh)
            assertEquals(if(fresh)listOf(policy.pattern("medium")) else emptyList(),advance(p,0f))
        }
    }
    @Test fun `seek pause admission loss and replacement cannot replay heavy patterns`() {
        for(mode in listOf("seek","pause","identity","gap")) {
            val p=BattleSensoryPlayback();p.replace(plan(records("star-3")).sensoryCues,false);advance(p,0f)
            if(mode=="gap")p.interrupted()
            assertTrue(advance(p,1f,epoch=if(mode=="identity")2 else 1,control=if(mode=="seek")2 else 1,playing=mode!="pause").isEmpty(),mode)
            assertTrue(advance(p,2f,epoch=2,control=2).isEmpty(),mode)
            p.replace(emptyList(),false);assertTrue(advance(p,1f).isEmpty())
        }
    }
    @Test fun `unsupported haptic metadata is refused before a device request`() {
        for(change in listOf("priority","repeat","empty")) {
            val json=reader.parse(reference.get("policy").toJson(JsonWriter.OutputType.json));val events=json.get("eventHaptics")
            when(change) {
                "priority"->events.get("budget").set("strongest")
                "repeat"->events.get("overlap").set("queue")
                else->events.get("patterns").get("heavy").remove(2)
            }
            assertFailsWith<IllegalArgumentException>(change) { SensoryPolicy.parse(json) }
        }
    }
}
