package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import java.io.File
import java.security.MessageDigest
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.test.*
import org.junit.Test

/** Original packed rasters at generated animation boundaries. Synthetic CPU evidence only. */
class BurrowMotionPackProofTest {
    private fun obj()=JsonValue(JsonValue.ValueType.`object`)
    private fun array()=JsonValue(JsonValue.ValueType.array)
    private fun JsonValue.put(k:String,v:String)=addChild(k,JsonValue(v))
    private fun JsonValue.put(k:String,v:Number)=addChild(k,JsonValue(v.toDouble()))
    private fun JsonValue.put(k:String,v:Boolean)=addChild(k,JsonValue(v))
    private fun sha(f:File)=MessageDigest.getInstance("SHA-256").digest(f.readBytes()).joinToString("") { "%02x".format(it) }
    private fun sprite(s:CombatSprite)=obj().apply {
        put("clip",s.clip.key);put("frame",s.frameKey);put("atlasPath",s.clip.atlasPath)
        put("x",s.x);put("y",s.y);put("depth",s.depth);put("scale",s.clip.scale)
        put("anchorX",s.clip.anchorX);put("anchorY",s.clip.anchorY);put("alpha",s.alpha);put("rotation",s.rotation)
    }

    @Test fun `every authored burrow tier and heading remains visible through entry tunnel and surface`() {
        val root=System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
        val reader=JsonReader();val render=reader.parse(root.resolve("render-catalog.json").readText())
        val catalog=reader.parse(root.resolve("catalogue.json").readText());val manifest=reader.parse(root.resolve("manifest.json").readText())
        assertTrue(render.getInt("rendererContractVersion")>=12)
        val library=CombatArt.catalogue(render);val presentation=catalog.get("presentation")
        val tile=presentation.getFloat("tilePixels");val unit=presentation.getFloat("unitsPerTile");val tickMs=presentation.getFloat("tickMs")
        val constants=catalog.get("constants");val cadence=constants.get("RAID_RULES").getInt("troopFireVisualTicks")
        val summoned=constants.get("TROOP_ABILITIES").get("hexbarrow").get("brood").getInt("positionKeyframeTicks")
        val headings=linkedMapOf("s" to (0 to 1),"sw" to (-1 to 1),"w" to (-1 to 0),"nw" to (-1 to -1),
            "n" to (0 to -1),"ne" to (1 to -1),"e" to (1 to 0),"se" to (1 to 1))
        val catalogueSha=sha(root.resolve("render-catalog.json"));val prefix="burrow-motion/${catalogueSha.take(16)}"
        val proof=CpuCombatProof(root);val cases=array();val captures=array();val sheets=array()
        for(name in listOf("tunneler","bilgewraith")) {
            val actors=render.get("actors").filter { it.getString("type")==name }.distinctBy { it.getString("combatKey") }
            assertEquals(4,actors.size)
            for((index,entry) in actors.withIndex()) {
                val art=library.getValue(entry.getString("frameKey"));val contract=assertNotNull(art.burrowMotion)
                val enter=art.clips.getValue(contract.enterState);val tunnel=art.clips.getValue(contract.tunnelState)
                val surface=art.clips.getValue(contract.surfaceState);val idle=art.clips.getValue(art.profile.getString("stand"))
                val walk=art.clips.getValue(art.profile.getString("battleMove",null) ?: art.profile.getString("move"))
                val headingEndTick=ceil(walk.durationMs.toDouble()/tickMs).toInt()
                val castTick=headingEndTick+1;val castMs=castTick*tickMs
                val emergeOffset=ceil((enter.durationMs.toDouble()+tunnel.durationMs)/tickMs).toInt()*tickMs
                val emergeTick=castTick+(emergeOffset/tickMs).toInt()
                val releases=listOf(enter,surface).flatMapIndexed { i,body ->
                    body.fxCues.getValue("soil").map { frame ->
                        Triple((if(i==0)0f else emergeOffset)+(frame-1)*1000f/body.fps,
                            art.effects.getValue(body.effectByCue.getValue("soil")),frame)
                    }
                }
                val boundaries=linkedMapOf("entry" to 0.0,"entrySoil" to releases.first().first.toDouble(),
                    "tunnel" to enter.durationMs.toDouble(),"tunnelCycle" to enter.durationMs.toDouble()+tunnel.durationMs/2,
                    "emerge" to emergeOffset.toDouble(),"surfaceSoil" to releases.last().first.toDouble(),
                    "surfaceEnd" to emergeOffset.toDouble()+surface.durationMs,
                    "lastFXexpiry" to maxOf(emergeOffset.toDouble()+surface.durationMs,releases.maxOf { it.first.toDouble()+it.second.durationMs }))
                val contacts=mutableListOf<Pair<String,File>>()
                for((facing,direction) in headings) {
                    val id="$name-t${index+1}-$facing";val(dx,dy)=direction
                    val events=listOf(
                        """{"e":"deploy","t":0,"id":1,"troop":"$name","x":${(6-2*dx)*unit},"y":${(6-2*dy)*unit}}""",
                        """{"e":"pos","t":$headingEndTick,"id":1,"x":${6*unit},"y":${6*unit}}""",
                        """{"e":"burrow","t":$castTick,"id":1}""",
                        """{"e":"emerge","t":$emergeTick,"id":1}"""
                    ).map(PresentationEvent::fromJson)
                    val scene=BattleScene(BaseScene(emptyList(),12,12,tile),PresentationRevision(id,"synthetic",manifest.getInt("simVersion"),0,0,events),
                        mapOf(name to entry.getString("frameKey")),unit,tickMs,cadence,summoned)
                    val model=BattleVisualModel(events,cadence,summoned);val plan=CombatVisualPlan(scene,model,library)
                    assertTrue(plan.missingCoverage.isEmpty(),"$id: ${plan.missingCoverage}")
                    cases.addChild(obj().apply {
                        put("id",id);put("unit",name);put("tier",index+1);put("facing",facing);put("castMs",castMs);put("castTick",castTick)
                        put("headingEndTick",headingEndTick);put("emergeOffsetMs",emergeOffset);put("enterDurationMs",enter.durationMs)
                        put("surfaceDurationMs",surface.durationMs);put("tunnelDurationMs",tunnel.durationMs)
                        put("visualEndTick",plan.playbackExtent.visualEndTick)
                    })
                    val output=mutableListOf<CombatSprite>()
                    val samples=boundaries.map { (label,ms)->
                        val requested=castMs.toDouble()+ms+if(label=="entry")0.0 else .02
                        var tick=(requested/tickMs).toFloat()
                        while((tick*tickMs).toDouble()<requested)tick=Math.nextUp(tick)
                        label to tick
                    }+("renderer-final" to plan.playbackExtent.visualEndTick)
                    for((label,tick) in samples) {
                        val elapsed=tick*tickMs-castMs;val actor=assertNotNull(plan.actor(1,tick),"$id $label must remain visible")
                        val (body,phaseStart)=when {
                            elapsed<enter.durationMs -> enter to 0f
                            elapsed<emergeOffset -> tunnel to enter.durationMs
                            elapsed<emergeOffset+surface.durationMs -> surface to emergeOffset
                            else -> idle to emergeOffset+surface.durationMs
                        }
                        assertEquals(body.key,actor.clip.key);assertEquals(1f,actor.alpha)
                        val row=body.frames[body.row(facing)];val phase=(elapsed-phaseStart).coerceAtLeast(0f)
                        val frame=floor(phase.toDouble()*body.fps/1000).toInt()
                        assertEquals(row[if(body===tunnel || body===idle)frame%row.size else frame.coerceAtMost(row.lastIndex)],actor.frameKey,"$id $label")
                        assertEquals(6*tile,actor.x,.001f);assertEquals(6*tile,actor.y,.001f)
                        plan.transientSprites(tick,output)
                        val live=releases.filter { elapsed>=it.first && elapsed<it.first+it.second.durationMs }
                        assertEquals(live.size,output.size,"$id $label soil ownership")
                        for((effect,expected) in output.zip(live)) {
                            assertEquals(expected.second.key,effect.clip.key);assertEquals(0f,effect.rotation)
                            assertEquals(actor.x,effect.x,.001f);assertEquals(actor.y,effect.y,.001f)
                            assertEquals(actor.y+contract.soilDepthOffset,effect.depth,.001f)
                        }
                        if(label=="renderer-final") { assertEquals(idle.key,actor.clip.key);assertTrue(output.isEmpty()) }
                        val saved=output.toList();plan.transientSprites(0f,output);plan.transientSprites(tick,output)
                        assertEquals(saved,output,"Backward seek cannot duplicate soil")
                        val file=proof.write(scene,model,plan,render,tick,"$prefix/${id}_$label",pixels=(12*tile).toInt())
                        contacts+="$facing $label" to file
                        captures.addChild(obj().apply {
                            put("caseId",id);put("checkpoint",label);put("tick",tick);put("elapsedMs",elapsed)
                            put("file",file.canonicalPath);put("sha256",sha(file));put("reachableByRenderer",tick<=plan.playbackExtent.visualEndTick)
                            addChild("actor",sprite(actor));addChild("effects",array().apply { output.forEach { addChild(sprite(it)) } })
                        })
                    }
                }
                val sheet=proof.contactSheet(contacts,boundaries.size+1,"$name tier ${index+1} | native CPU | $catalogueSha","$prefix/$name-t${index+1}-contact")
                sheets.addChild(obj().apply { put("file",sheet.canonicalPath);put("sha256",sha(sheet)) })
            }
        }
        assertEquals(64,cases.size);assertEquals(576,captures.size);assertEquals(8,sheets.size)
        val report=obj().apply {
            put("scope","Original-art CPU evidence;64 synthetic cases. No browser/GL/physical/performance acceptance; beyond-clamp samples labeled separately.")
            put("contentVersion",manifest.getString("contentVersion"));put("sourceCommit",manifest.getString("sourceCommit"));put("renderCatalogueSha256",catalogueSha)
            addChild("cases",cases);addChild("captures",captures);addChild("contactSheets",sheets)
        }
        File("../.reports/visual/combat/$prefix/capture-receipt.json").writeText(report.prettyPrint(JsonValue.PrettyPrintSettings().apply { outputType=JsonWriter.OutputType.json }))
    }
}
