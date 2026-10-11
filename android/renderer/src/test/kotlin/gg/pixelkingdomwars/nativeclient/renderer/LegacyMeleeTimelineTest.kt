package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import java.io.File
import kotlin.test.*
import org.junit.Test

class LegacyMeleeTimelineTest {
    private val reader=JsonReader()
    private val reference=reader.parse(checkNotNull(javaClass.getResourceAsStream("/archive/source-reference.json")).bufferedReader().readText())
    private val root=System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val catalogue=reader.parse(root.resolve("render-catalog.json").readText())
    private val constants=reader.parse(root.resolve("catalogue.json").readText())
    private val library=CombatArt.catalogue(catalogue)
    private val tickMs=constants.get("presentation").getFloat("tickMs")
    private val scale=constants.get("presentation").getFloat("tilePixels")/constants.get("presentation").getFloat("unitsPerTile")
    private val policy=reference.get("legacy").let { legacy->ArchivedMeleePolicy(legacy.getInt("selfDescribingSimVersion"),legacy.getInt("targetAwareSimVersion"),
        legacy.getFloat("positionSnapDistance"),legacy.get("aim").let { HowlAimArt(it.getFloat("minimumDeltaSquared"),it.getFloat("retainWithinDegrees")) }) }
    private fun art(unit:String,level:Int=1)=library.getValue(catalogue.get("actors").first { it.getString("type")==unit&&it.getInt("level")==level }.getString("frameKey"))
    private fun events(unit:String)=listOf(
        """{"t":0,"e":"deploy","id":1,"troop":"$unit","x":0,"y":0}""",
        """{"t":40,"e":"pos","id":1,"x":400,"y":400}""",
        """{"t":45,"e":"pos","id":1,"x":400,"y":400}""",
        """{"t":60,"e":"star","n":1}""").map(PresentationEvent::fromJson)
    private fun indexed(events:List<PresentationEvent>)=events.mapIndexed { ordinal,e->ordinal to reader.parse(e.json) }.filter {
        it.second.get(if(it.second.getString("e")=="hit")"target" else "id")?.isNumber==true }
    private fun deliveries(events:List<PresentationEvent>)=PositionDelivery.compile(events,10,5,tickMs)
    @Test fun `source automatic attack remains idle and movement interrupts it for every ordinary melee family`() {
        for(unit in reference.get("legacy").get("cases").map { it.getString("unit") }.filter { it !in setOf("gloamfang","tunneler","bilgewraith") }) {
            val art=art(unit);val events=events(unit)
            val timeline=LegacyMeleeTimeline(indexed(events),deliveries(events),art,tickMs,scale,policy,emptyList(),60*tickMs) { _,_,_,_->100f to 0f }
            val birth=art.clips[art.profile.getString("spawn","")]?.durationMs ?: 0f
            val first=timeline.sample(birth)!!.body
            assertTrue(first.automatic,"$unit must use the source's omitted-cue fallback")
            assertEquals(art.profile.get("attack").first().asString(),first.state)
            assertEquals("e",first.facing)
            val moving=timeline.sample(35*tickMs)!!
            assertFalse(moving.body.automatic);assertEquals(art.profile.getString("battleMove",art.profile.getString("move")),moving.body.state)
            val arrived=timeline.sample(40*tickMs)!!
            assertTrue(arrived.body.automatic);assertEquals(40*tickMs,arrived.body.phaseStartMs)
            val correction=timeline.sample(45*tickMs)!!
            assertTrue(correction.body.automatic)
            assertTrue(timeline.bodies.filter { it.automatic }.all { it.startMs<60*tickMs },
                "Indefinite standing art must not make archive reconstruction unbounded")
        }
    }
    @Test fun `explicit verbs keep their own clocks and next stand resumes the old fallback`() {
        val art=art("giant");val events=events("giant")
        val timeline=LegacyMeleeTimeline(indexed(events),deliveries(events),art,tickMs,scale,policy,
            listOf(LegacyMeleeVerb(20*tickMs,38*tickMs,"w")),60*tickMs) { _,_,_,_->100f to 0f }
        assertFalse(timeline.sample(25*tickMs)!!.body.automatic)
        assertEquals("w",timeline.sample(35*tickMs)!!.body.facing)
        assertEquals(art.profile.getString("move"),timeline.sample(39*tickMs)!!.body.state)
        assertTrue(timeline.sample(40*tickMs)!!.body.automatic)
        val early=timeline.sample(10*tickMs)
        timeline.sample(59*tickMs)
        assertEquals(early,timeline.sample(10*tickMs),"Seeking backwards restores the prior body instead of retaining a later action")
    }
    @Test fun `version dispatch follows source ownership and heroes never inherit donor fallback`() {
        val giant=indexed(events("giant"));val troll=indexed(events("troll"));val art=art("giant")
        assertTrue(policy.automatic(policy.selfDescribingSimVersion-1,1,giant,art))
        assertFalse(policy.automatic(policy.selfDescribingSimVersion,1,giant,art))
        assertFalse(policy.automatic(policy.targetAwareSimVersion,1,troll,art("troll")))
        assertTrue(policy.automatic(policy.targetAwareSimVersion-1,1,troll,art("troll")))
        val hero=listOf(0 to reader.parse("""{"t":0,"e":"deploy","id":1,"troop":"giant","hero":"theodor"}"""))
        assertFalse(policy.automatic(1,1,hero,art))
        val cued=giant+listOf(10 to reader.parse("""{"t":10,"e":"troopAttack","id":1}"""))
        assertFalse(policy.automatic(policy.targetAwareSimVersion-1,1,cued,art))
    }
    @Test fun `SIM6 extended melee uses the same interruptible fallback without replacing ability owners`() {
        val gloamEvents=events("gloamfang");val gloamArt=art("gloamfang")
        val gloam=GloamfangMotionTimeline(gloamEvents,1,deliveries(gloamEvents),gloamArt,tickMs,scale,
            actorEvents=indexed(gloamEvents),nearestStandTarget={ _,_,_,_->100f to 0f },legacyAutomatic=true)
        assertEquals(gloamArt.profile.get("attack").first().asString(),gloam.sample(gloamArt.clips.getValue("spawn").durationMs/tickMs)!!.clipState)
        assertEquals(gloamArt.profile.getString("move"),gloam.sample(35f)!!.clipState)
        assertEquals(gloamArt.profile.get("attack").first().asString(),gloam.sample(40f)!!.clipState)
        assertTrue(gloam.bodyActions.filter { it.automatic }.all { it.startMs<60*tickMs })
        for(unit in listOf("tunneler","bilgewraith")) {
            val events=events(unit);val art=art(unit)
            val burrow=BurrowMotionTimeline(events,indexed(events),deliveries(events),art,tickMs,scale,
                nearestStandTarget={ _,_,_,_->100f to 0f },legacyAutomatic=true)
            assertEquals(art.profile.getString("stand"),burrow.sample(20f)!!.clipState,
                "Constructor stand runs before the nearest-building callback is installed")
            assertEquals(art.profile.getString("move"),burrow.sample(35f)!!.clipState)
            assertEquals(art.profile.get("attack").first().asString(),burrow.sample(40f)!!.clipState)
            assertTrue(burrow.bodyActions.filter { it.automatic }.all { it.startMs<60*tickMs })
        }
    }
    @Test fun `hit flinch owns an idle fallback until its authored completion and never remains after a backwards seek`() {
        for(unit in listOf("giant","gloamfang","tunneler","bilgewraith")) {
            val events=(events(unit).filter { it.t!=45 }+PresentationEvent.fromJson("""{"t":20,"e":"hit","target":1,"dmg":1}""")).sortedBy { it.t }
            val art=art(unit);val indexed=indexed(events);val deliveries=deliveries(events)
            val hit=art.profile.getString("hit");val ended=20f+art.clips.getValue(hit).durationMs/tickMs
            val sample:(Float)->String=when(unit) {
                "gloamfang"->{val timeline=GloamfangMotionTimeline(events,1,deliveries,art,tickMs,scale,
                    actorEvents=indexed,nearestStandTarget={ _,_,_,_->100f to 0f },legacyAutomatic=true);
                    { tick:Float->timeline.sample(tick)!!.clipState }}
                "tunneler","bilgewraith"->{val timeline=BurrowMotionTimeline(events,indexed,deliveries,art,tickMs,scale,
                    nearestStandTarget={ _,_,_,_->100f to 0f },legacyAutomatic=true);
                    { tick:Float->timeline.sample(tick)!!.clipState }}
                else->{val timeline=LegacyMeleeTimeline(indexed,deliveries,art,tickMs,scale,policy,emptyList(),60*tickMs) { _,_,_,_->100f to 0f };
                    { tick:Float->timeline.sample(tick*tickMs)!!.body.state }}
            }
            assertEquals(hit,sample(20f),"$unit must allow a flinch to interrupt its source idle attack")
            assertEquals(art.profile.get("attack").first().asString(),sample(ended))
            sample(55f)
            assertEquals(hit,sample(20f),"The old hit body is reconstructed at its original time")
        }
    }
    @Test fun `destroyed target changes internal facing while old swing row survives until a later Clock flinch`() {
        data class View(val row:String,val controller:String,val state:String)
        for(unit in listOf("giant","gloamfang","tunneler","bilgewraith"))for(hitTick in listOf(101,102)) {
            val records=listOf("""{"t":0,"e":"deploy","id":1,"troop":"$unit","x":0,"y":0}""",
                """{"t":100,"e":"pos","id":1,"x":400,"y":0}""",
                """{"t":101,"e":"destroyed","id":"east"}""",
                """{"t":$hitTick,"e":"hit","target":1,"dmg":1}""",
                """{"t":200,"e":"star","n":1}""").map(PresentationEvent::fromJson)
            val actor=indexed(records);val destroys=listOf(2 to reader.parse(records[2].json));val art=art(unit)
            val nearest:(Float,Int,Float,Float)->Pair<Float,Float>?={ ms,ordinal,_,_->
                if(ms<101*tickMs || (ms==101*tickMs && ordinal<=2))200f to 0f else 0f to 0f }
            val delivery=deliveries(records)
            val sample:(Float)->View=when(unit) {
                "gloamfang"->{val t=GloamfangMotionTimeline(records,1,delivery,art,tickMs,scale,actorEvents=actor,
                    nearestStandTarget=nearest,legacyAutomatic=true,idleFacingEvents=destroys);
                    { tick:Float->t.sample(tick)!!.let { View(it.facing,it.controllerFacing,it.clipState) } }}
                "tunneler","bilgewraith"->{val t=BurrowMotionTimeline(records,actor,delivery,art,tickMs,scale,
                    nearestStandTarget=nearest,idleFacingEvents=destroys,legacyAutomatic=true);
                    { tick:Float->t.sample(tick)!!.let { View(it.facing,it.controllerFacing,it.clipState) } }}
                else->{val t=LegacyMeleeTimeline(actor,delivery,art,tickMs,scale,policy,emptyList(),200*tickMs,destroys,nearest);
                    { tick:Float->t.sample(tick*tickMs)!!.let { View(it.body.facing,it.controllerFacing,it.body.state) } }}
            }
            assertEquals("e",sample(100.5f).row)
            if(hitTick==102) {
                assertEquals("e",sample(101.5f).row,"$unit keeps the already registered swing row")
                assertEquals("w",sample(101.5f).controller,"$unit keyed emitter uses the updated controller direction")
            }
            assertEquals(art.profile.getString("hit"),sample(hitTick.toFloat()).state)
            assertEquals(if(hitTick==101)"e" else "w",sample(hitTick.toFloat()).row,
                "$unit Clock flinch reads the last completed idle update, not a same-batch future turn")
        }
    }
}
