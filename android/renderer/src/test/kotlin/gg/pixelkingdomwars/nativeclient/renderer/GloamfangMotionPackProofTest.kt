package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import java.io.File
import java.security.MessageDigest
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.test.*
import org.junit.Test

/** Actual packed artwork, synthetic orders and continuous native time. These are CPU rasters,
 * not GL screenshots or a claim that Phaser's lazy tween updates use identical sample times. */
class GloamfangMotionPackProofTest {
    private fun obj()=JsonValue(JsonValue.ValueType.`object`)
    private fun array()=JsonValue(JsonValue.ValueType.array)
    private fun JsonValue.put(key:String,value:String)=addChild(key,JsonValue(value))
    private fun JsonValue.put(key:String,value:Number)=addChild(key,JsonValue(value.toDouble()))
    private fun JsonValue.put(key:String,value:Boolean)=addChild(key,JsonValue(value))
    private fun sha(file:File)=MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
    private fun metadata(s:CombatSprite)=obj().apply {
        put("clip",s.clip.key);put("frame",s.frameKey);put("atlasPath",s.clip.atlasPath)
        put("x",s.x);put("y",s.y);put("depth",s.depth);put("scale",s.clip.scale)
        put("anchorX",s.clip.anchorX);put("anchorY",s.clip.anchorY)
        put("rotation",s.rotation);put("alpha",s.alpha);put("flipX",s.flipX)
    }

    @Test fun `all authored Leap and Lunge tiers and headings render finite keyed choreography`() {
        val root=System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
        val reader=JsonReader();val render=reader.parse(root.resolve("render-catalog.json").readText())
        val catalog=reader.parse(root.resolve("catalogue.json").readText());val manifest=reader.parse(root.resolve("manifest.json").readText())
        assertTrue(render.getInt("rendererContractVersion")>=11,"This proof requires admitted Leap/Lunge contracts")
        val library=CombatArt.catalogue(render);val presentation=catalog.get("presentation")
        val tile=presentation.getFloat("tilePixels");val unit=presentation.getFloat("unitsPerTile")
        val tickMs=presentation.getFloat("tickMs");val constants=catalog.get("constants")
        val cadence=constants.get("RAID_RULES").getInt("troopFireVisualTicks")
        val summoned=constants.get("TROOP_ABILITIES").get("hexbarrow").get("brood").getInt("positionKeyframeTicks")
        val actors=render.get("actors").filter { it.getString("type")=="gloamfang" }.distinctBy { it.getString("combatKey") }
        assertEquals(4,actors.size,"All four authored tiers must remain covered")
        val directions=linkedMapOf("s" to (0 to 1),"sw" to (-1 to 1),"w" to (-1 to 0),"nw" to (-1 to -1),
            "n" to (0 to -1),"ne" to (1 to -1),"e" to (1 to 0),"se" to (1 to 1))
        val catalogueSha=sha(root.resolve("render-catalog.json"));val prefix="gloamfang-motion/${catalogueSha.take(16)}"
        val proof=CpuCombatProof(root);val captures=array();val sheets=array();val cases=array();val reachableEnds=array()
        val report=obj().apply {
            put("scope","Actual-art CPU proof; synthetic no-position/no-building events. Continuous native motion, not Phaser frame-cadence, GL, gameplay, or performance acceptance.")
            put("sourceCommit",manifest.getString("sourceCommit"));put("contentVersion",manifest.getString("contentVersion"))
            put("rendererContractVersion",render.getInt("rendererContractVersion"));put("renderCatalogueSha256",catalogueSha)
            put("manifestSha256",sha(root.resolve("manifest.json")));put("tilePixels",tile);put("tickMs",tickMs)
            put("boundaryEpsilonMs",.02);addChild("cases",cases);addChild("captures",captures);addChild("contactSheets",sheets)
            addChild("reachableFinalCaptures",reachableEnds)
            put("checkpointPolicy","416 nominal web-clock raw-plan samples; per-capture reachability flags distinguish samples beyond the renderer clamp. Separate64 captures sample the exact reachable visualEndTick without epsilon or an invented horizon.")
        }
        for((tierIndex,entry) in actors.withIndex()) {
            val art=library.getValue(entry.getString("frameKey"));val leap=assertNotNull(art.leap);val lunge=assertNotNull(art.lunge)
            val spawn=art.clips.getValue(art.profile.getString("spawn"))
            // The public web fixture completes spawn before its cast-relative clock starts.
            val castTick=floor(spawn.durationMs.toDouble()/tickMs).toInt()+1;val castMs=castTick*tickMs
            fun tickAt(requested:Double):Float {
                var tick=((castMs.toDouble()+requested)/tickMs).toFloat()
                while((tick*tickMs-castMs).toDouble()<requested)tick=Math.nextUp(tick)
                while((Math.nextDown(tick)*tickMs-castMs).toDouble()>=requested)tick=Math.nextDown(tick)
                assertTrue((tick*tickMs-castMs).toDouble()>=requested)
                assertTrue((Math.nextDown(tick)*tickMs-castMs).toDouble()<requested)
                return tick
            }
            for(ability in listOf("leap","lunge")) {
                val state=if(ability=="leap")leap.bodyState else lunge.bodyState
                val body=art.clips.getValue(state);val cue=if(ability=="leap")"dust" else "rend"
                val frames=body.fxCues.getValue(cue);assertEquals(2,frames.size,"Both repeated source keys must survive parsing")
                assertEquals(directions.keys,body.rowOrder.toSet())
                val effect=art.effects.getValue(body.effectByCue.getValue(cue))
                assertTrue(body.fps>0 && effect.fps>0 && !body.loop && !effect.loop)
                for(path in listOf(body.atlasPath,effect.atlasPath)) assertTrue(root.resolve(path).isFile,"Missing original art $path")
                val releases=frames.map { (it-1)*1000.0/body.fps }
                val effectDuration=effect.frames.first().size*1000.0/effect.fps
                val bodyDuration=body.frames.first().size*1000.0/body.fps
                val boundaries=linkedMapOf("cast" to 0.0,"cue1" to releases[0],"cue2" to releases[1],"midbody" to bodyDuration/2)
                if(ability=="leap")boundaries["travelend"]=leap.durationMs.toDouble()
                boundaries["bodyend"]=bodyDuration;boundaries["lastFXexpiry"]=releases.max()+effectDuration
                val contacts=mutableListOf<Pair<String,File>>()
                for((facing,direction) in directions) {
                    val (dx,dy)=direction;val caseId="${ability}-t${tierIndex+1}-$facing"
                    val events=listOf(
                        """{"e":"deploy","t":0,"id":1,"troop":"gloamfang","x":${6*unit},"y":${6*unit}}""",
                        """{"e":"troopAbility","t":$castTick,"id":1,"ability":"$ability","x":${6*unit},"y":${6*unit},"ix":${(6+2*dx)*unit},"iy":${(6+2*dy)*unit}}"""
                    ).map(PresentationEvent::fromJson)
                    val scene=BattleScene(BaseScene(emptyList(),12,12,tile),PresentationRevision(caseId,"synthetic",manifest.getInt("simVersion"),0,0,events),
                        mapOf("gloamfang" to entry.getString("frameKey")),unit,tickMs,cadence,summoned)
                    val model=BattleVisualModel(events,cadence,summoned);val plan=CombatVisualPlan(scene,model,library)
                    assertTrue(plan.missingCoverage.isEmpty(),"$caseId missing ${plan.missingCoverage}")
                    assertEquals(castTick.toFloat(),plan.playbackExtent.eventEndTick)
                    val case=obj().apply {
                        put("id",caseId);put("ability",ability);put("tier",tierIndex+1);put("facing",facing);put("bodyClip",body.key)
                        put("effectClip",effect.key);put("castTick",castTick);put("castMs",castMs);put("spawnDurationMs",spawn.durationMs)
                        put("bodyDurationMs",bodyDuration);put("effectDurationMs",effectDuration)
                        put("cue1Ms",releases[0]);put("cue2Ms",releases[1]);put("lastFxExpiryMs",releases.max()+effectDuration)
                        put("travelDurationMs",if(ability=="leap")leap.durationMs else 0f)
                        put("originX",6*tile);put("originY",6*tile);put("targetX",(6+2*dx)*tile);put("targetY",(6+2*dy)*tile)
                        put("eventEndTick",plan.playbackExtent.eventEndTick);put("visualEndTick",plan.playbackExtent.visualEndTick)
                    };cases.addChild(case)
                    fun point(elapsed:Double):Triple<Float,Float,Float> {
                        val p=if(ability=="leap")(elapsed/leap.durationMs).coerceIn(0.0,1.0) else 0.0
                        val x=6*tile+2*tile*dx*p;val ground=6*tile+2*tile*dy*p
                        val lift=if(ability=="leap")hypot((2*tile*dx).toDouble(),(2*tile*dy).toDouble())*leap.heightRatio*4*p*(1-p) else 0.0
                        return Triple(x.toFloat(),(ground-lift).toFloat(),ground.toFloat())
                    }
                    val output=mutableListOf<CombatSprite>()
                    for((label,boundary) in boundaries) {
                        val requested=boundary+if(label=="cast")0.0 else .02
                        val tick=if(label=="cast")castTick.toFloat() else tickAt(requested)
                        val elapsed=(tick*tickMs-castMs).toDouble();val actor=assertNotNull(plan.actor(1,tick))
                        val expectedPoint=point(elapsed)
                        assertEquals(expectedPoint.first,actor.x,.003f,"$caseId $label x")
                        assertEquals(expectedPoint.second,actor.y,.003f,"$caseId $label y")
                        assertEquals(expectedPoint.third,actor.depth,.003f,"Ground depth must not follow Leap elevation")
                        val activeBody=elapsed<body.durationMs
                        val expectedClip=if(activeBody)body else art.clips.getValue(art.profile.getString("stand"))
                        assertEquals(expectedClip.key,actor.clip.key)
                        val phase=if(activeBody)elapsed else elapsed-body.durationMs
                        val row=expectedClip.frames[expectedClip.row(facing)]
                        val step=floor(phase.coerceAtLeast(0.0)*expectedClip.fps/1000).toInt()
                        assertEquals(row[if(activeBody)step.coerceAtMost(row.lastIndex) else step%row.size],actor.frameKey,"$caseId $label facing/frame")
                        plan.transientSprites(tick,output)
                        val live=frames.indices.filter { elapsed>=releases[it] && elapsed<releases[it]+effectDuration }
                        assertEquals(live.size,output.size,"$caseId $label repeated cue count")
                        for((sprite,index) in output.zip(live)) {
                            assertEquals(effect.key,sprite.clip.key)
                            val releaseFloat=castMs+(frames[index]-1)*1000f/body.fps
                            val sampledRelease=(releaseFloat/tickMs*tickMs-castMs).toDouble()
                            val at=point(sampledRelease)
                            val emitter=if(ability=="lunge") body.emitter(art.fxEmitters.getValue(cue),body.row(facing),frames[index]-1) else null
                            assertEquals(at.first+(emitter?.let { (it.first-body.cellWidth*body.anchorX)*body.scale } ?: 0f),sprite.x,.003f)
                            assertEquals(at.second+(emitter?.let { (it.second-body.cellHeight*body.anchorY)*body.scale } ?: 0f),sprite.y,.003f)
                            assertEquals(at.third+if(ability=="leap")-1f else 1f,sprite.depth,.003f)
                            assertEquals(if(ability=="leap")0f else art.fxFacingRotationDeg.getValue(facing),sprite.rotation)
                            val effectStep=floor((tick*tickMs-releaseFloat).toDouble()*effect.fps/1000).toInt().coerceIn(effect.frames.first().indices)
                            assertEquals(effect.frames.first()[effectStep],sprite.frameKey)
                        }
                        val saved=output.toList();plan.transientSprites(plan.playbackExtent.visualEndTick,output);assertTrue(output.isEmpty())
                        plan.transientSprites(tick,output);assertEquals(saved,output,"Seeking must restore the same finite keyed effects")
                        assertEquals(actor,plan.actor(1,tick))
                        val file=proof.write(scene,model,plan,render,tick,"$prefix/${caseId}_$label",pixels=(12*tile).toInt())
                        contacts+="$facing $label" to file
                        captures.addChild(obj().apply {
                            put("caseId",caseId);put("checkpoint",label);put("file",file.canonicalPath);put("sha256",sha(file))
                            put("tick",tick);put("boundaryMs",boundary);put("requestedElapsedMs",requested);put("actualElapsedMs",elapsed)
                            put("quantizationDeltaMs",elapsed-requested);put("expectedFacing",facing);addChild("actor",metadata(actor))
                            put("sampleScope",if(tick<=plan.playbackExtent.visualEndTick)"reachable-renderer-time" else "raw-plan-beyond-renderer-end")
                            put("reachableByRenderer",tick<=plan.playbackExtent.visualEndTick)
                            put("rendererVisualEndTick",plan.playbackExtent.visualEndTick)
                            put("pastRendererEndMs",((tick-plan.playbackExtent.visualEndTick)*tickMs).coerceAtLeast(0f))
                            put("fxCount",output.size);addChild("effects",array().apply { output.forEach { addChild(metadata(it)) } })
                        })
                    }
                    // Unlike the nominal comparison samples, this is the exact clamp used by
                    // NativeGameRenderer. It must have finished both the body and every finite FX.
                    val finalTick=plan.playbackExtent.visualEndTick
                    val finalElapsed=(finalTick*tickMs-castMs).toDouble()
                    val finalActor=assertNotNull(plan.actor(1,finalTick))
                    val stand=art.clips.getValue(art.profile.getString("stand"))
                    assertEquals(stand.key,finalActor.clip.key,"$caseId renderer clamp must reach idle, not retain the final one-shot frame")
                    val idlePhase=finalTick*tickMs-(castMs+body.durationMs)
                    assertTrue(idlePhase>=0f,"$caseId final time must reach the actual body completion")
                    val standRow=stand.frames[stand.row(facing)]
                    assertEquals(standRow[floor(idlePhase.toDouble()*stand.fps/1000).toInt()%standRow.size],finalActor.frameKey)
                    val finalPoint=point(finalElapsed)
                    assertEquals(finalPoint.first,finalActor.x,.003f)
                    assertEquals(finalPoint.second,finalActor.y,.003f)
                    assertEquals(finalPoint.third,finalActor.depth,.003f)
                    plan.transientSprites(finalTick,output);assertTrue(output.isEmpty(),"$caseId finite effects cannot survive the renderer clamp")
                    val finalFile=proof.write(scene,model,plan,render,finalTick,"$prefix/${caseId}_renderer-final",pixels=(12*tile).toInt())
                    reachableEnds.addChild(obj().apply {
                        put("caseId",caseId);put("checkpoint","renderer-final");put("sampleScope","exact-renderer-clamp")
                        put("tick",finalTick);put("actualElapsedMs",finalElapsed);put("bodyEndMs",(castMs+body.durationMs).toDouble())
                        put("idlePhaseMs",idlePhase);put("fxCount",output.size);put("file",finalFile.canonicalPath);put("sha256",sha(finalFile))
                        addChild("actor",metadata(finalActor));addChild("effects",array())
                    })
                }
                val sheet=proof.contactSheet(contacts,boundaries.size,"$ability tier ${tierIndex+1} | native continuous CPU | $catalogueSha","$prefix/${ability}-t${tierIndex+1}-contact")
                sheets.addChild(obj().apply { put("file",sheet.canonicalPath);put("sha256",sha(sheet)) })
            }
        }
        assertEquals(64,cases.size);assertEquals(416,captures.size);assertEquals(8,sheets.size);assertEquals(64,reachableEnds.size)
        val destination=File("../.reports/visual/combat/$prefix/capture-receipt.json");destination.parentFile.mkdirs()
        destination.writeText(report.prettyPrint(JsonValue.PrettyPrintSettings().apply { outputType=JsonWriter.OutputType.json }))
    }
}
