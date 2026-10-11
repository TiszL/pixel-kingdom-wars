package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import java.io.File
import kotlin.test.*
import org.junit.Test

/** Historical self-describing events render directly; no current simulator or order synthesis participates. */
class ArchivedEventPresentationTest {
    private val reader=JsonReader()
    private val reference=reader.parse(checkNotNull(javaClass.getResourceAsStream("/archive/source-reference.json")).bufferedReader().readText())
    private val root=System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val catalogue=reader.parse(root.resolve("render-catalog.json").readText())
    private val constants=reader.parse(root.resolve("catalogue.json").readText())
    private val library=CombatArt.catalogue(catalogue)
    private val actorFrames=listOf("giant","theodor").associateWith {type->catalogue.get("actors").first {it.getString("type")==type&&it.getInt("level")==1}.getString("frameKey")}
    private val events=listOf(
        """{"t":0,"e":"deploy","id":1,"troop":"giant","x":128,"y":128}""",
        """{"t":0,"e":"deploy","id":2,"troop":"giant","hero":"theodor","x":256,"y":256}""",
        """{"t":5,"e":"pos","id":1,"x":256,"y":128}""",
        """{"t":6,"e":"troopAttack","id":1,"targetKind":"building","ix":384,"iy":128}""",
        """{"t":8,"e":"heroSkill","id":2,"hero":"theodor","skill":"cheekQuake","phase":"impact","x":256,"y":256}""",
        """{"t":30,"e":"star","n":1}""").map(PresentationEvent::fromJson)
    private fun plan(sim:Int):CombatVisualPlan {
        val p=constants.get("presentation");val c=constants.get("constants")
        val cadence=c.get("RAID_RULES").getInt("troopFireVisualTicks")
        val summoned=c.get("TROOP_ABILITIES").get("hexbarrow").get("brood").getInt("positionKeyframeTicks")
        val scene=BattleScene(BaseScene(emptyList(),16,16,p.getFloat("tilePixels")),PresentationRevision("archive","stored-events",sim,0,0,events),
            actorFrames,p.getFloat("unitsPerTile"),p.getFloat("tickMs"),cadence,summoned)
        return CombatVisualPlan(scene,BattleVisualModel(events,cadence,summoned),library)
    }
    @Test fun `supported historical bodies effects and cold seeks preserve the saved event sequence`() {
        val maximum=reference.get("policy").getInt("maximumSimVersion")
        val current=plan(maximum)
        for(sim in reference.get("legacy").getInt("selfDescribingSimVersion") until maximum) {
            val archive=plan(sim)
            assertEquals(current.playbackExtent,archive.playbackExtent)
            val expected=mutableListOf<CombatSprite>();val actual=mutableListOf<CombatSprite>()
            for(tick in listOf(0f,4.5f,6f,8.5f,12f,30f,8.5f)) {
                for(id in listOf(1,2))assertEquals(current.actor(id,tick),archive.actor(id,tick),"SIM$sim actor$id at$tick")
                current.transientSprites(tick,expected);archive.transientSprites(tick,actual)
                assertEquals(expected,actual,"SIM$sim stored FX at$tick")
            }
        }
    }
    @Test fun `old archive fallback reaches actual actor frames and original keyed contact artwork only in historical mode`() {
        val p=constants.get("presentation");val tick=p.getFloat("tickMs")
        val cadence=constants.get("constants").get("RAID_RULES").getInt("troopFireVisualTicks")
        val saved=listOf("""{"t":0,"e":"deploy","id":1,"troop":"giant","x":128,"y":128}""",
            """{"t":100,"e":"star","n":1}""").map(PresentationEvent::fromJson)
        val building=RenderBuilding("target","unused",4f,0f,1f,1f)
        val policy=requireNotNull(ArchivedMeleePolicy.parse(reference.get("policy")))
        fun scene(sim:Int)=BattleScene(BaseScene(listOf(building),16,16,p.getFloat("tilePixels")),
            PresentationRevision("archive","stored",sim,0,0,saved),actorFrames,p.getFloat("unitsPerTile"),tick,cadence,cadence)
        fun plan(sim:Int)=scene(sim).let { CombatVisualPlan(it,BattleVisualModel(saved,cadence),library,archivePolicy=policy) }
        val historical=plan(policy.targetAwareSimVersion-1);val current=plan(policy.selfDescribingSimVersion)
        val art=library.getValue(actorFrames.getValue("giant"));val attack=art.clips.getValue(art.profile.get("attack").first().asString())
        val start=art.clips.getValue(art.profile.getString("spawn")).durationMs
        assertEquals(attack.key,historical.actor(1,start/tick)!!.clip.key)
        assertEquals(art.clips.getValue(art.profile.getString("stand")).key,current.actor(1,start/tick)!!.clip.key)
        val (cue,effectKey)=attack.effectByCue.entries.first { it.key=="slam" }
        val release=(start+(attack.fxCues.getValue(cue).first()-1)*1000f/attack.fps)/tick+.001f
        val output=mutableListOf<CombatSprite>();historical.transientSprites(release,output)
        val effect=output.single { it.clip.key==art.effects.getValue(effectKey).key }
        assertEquals(1f,effect.alpha);assertEquals(art.effects.getValue(effectKey).scale,effect.horizontalScale)
        current.transientSprites(release,output);assertTrue(output.none { it.clip.key==effect.clip.key })
        val earlier=historical.actor(1,start/tick);historical.actor(1,99f)
        assertEquals(earlier,historical.actor(1,start/tick))
    }
}
