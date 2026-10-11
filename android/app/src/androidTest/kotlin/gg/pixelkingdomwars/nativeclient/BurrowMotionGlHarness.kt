package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.PixelCopy
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.network.objects
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.*
import kotlinx.serialization.json.*
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Closed offline fixture construction in the test APK only. No session or API access. */
internal object BurrowMotionGlHarness {
    private data class Case(val name: String,val scene: BattleScene,val expectation: JsonObject)
    private fun sha(file: File): String {
        val digest=MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer=ByteArray(64*1024);while(true) {
            val count=input.read(buffer);if(count<0) break;digest.update(buffer,0,count)
        } }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun capture(instrumentation: Instrumentation) {
        check(BuildConfig.DEBUG && Build.HARDWARE=="ranchu")
        val context=instrumentation.targetContext
        val directory=File(context.noBackupFilesDir,"burrow-motion-gl")
        check(directory.mkdir()) { "Preserve prior motion GL evidence before rerunning" }
        var activity: MainActivity?=null
        var stage="launch-offline-preview"
        var manifest: JsonObject?=null
        var renderCatalogueSha: String?=null
        var failure: JsonObject?=null
        var assemblyCase: JsonObject?=null
        val files=mutableListOf<JsonObject>()
        val runtimeApkSha=sha(File(context.applicationInfo.sourceDir))
        fun receipt(status: String) {
            File(directory,"receipt.json").writeText(buildJsonObject {
                put("status",status);put("stage",stage);put("fixture","burrow-motion-gl")
                put("failure",failure ?: JsonNull);put("assemblyCase",assemblyCase ?: JsonNull)
                put("syntheticPresentationOnly",true);put("backendAccessRequested",false);put("walletApprovalTested",false)
                put("runtimePackage",context.packageName);put("runtimeApkSha256",runtimeApkSha)
                put("contentVersion",manifest?.get("contentVersion") ?: JsonNull)
                put("sourceCommit",manifest?.get("sourceCommit") ?: JsonNull)
                put("renderCatalogueSha256",renderCatalogueSha?.let(::JsonPrimitive) ?: JsonNull)
                put("rendererContractVersion",manifest?.get("rendererContractVersion") ?: JsonNull)
                put("scope","Synthetic original-art burrow GL: both units, four tiers, east/west/NE only, plus bounded movement, cancellation, cold prefix, rewind and revision. Model expectations are not pixel measurements or gameplay outcomes.")
                put("files",JsonArray(files))
            }.toString())
        }
        try {
            receipt("running")
            activity=instrumentation.startActivitySync(Intent(context,MainActivity::class.java).putExtra("preview","battle")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            val host=activity
            check(host.intent.getStringExtra("preview")=="battle")
            stage="await-verified-bundled-assets";receipt("running")
            var assets: File?=null
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(60)
            while(assets==null && System.nanoTime()<deadline) {
                instrumentation.runOnMainSync {
                    val fragment=host.supportFragmentManager.fragments.filterIsInstance<KingdomFragment>().singleOrNull()
                    if(fragment?.renderer!=null && fragment.assetPath.isNotEmpty()) assets=File(fragment.assetPath)
                }
                if(assets==null) Thread.sleep(50)
            }
            val root=requireNotNull(assets)
            check(root.canonicalFile.parentFile==context.noBackupFilesDir.canonicalFile && root.name.matches(Regex("bundled-[a-f0-9]{64}")))
            fun read(name: String)=Json.parseToJsonElement(File(root,name).readText()).jsonObject
            manifest=read("manifest.json")
            val catalogue=read("catalogue.json");val render=read("render-catalog.json")
            renderCatalogueSha=sha(File(root,"render-catalog.json"))
            stage="prepare-motion-cases";receipt("running")
            check(render.getValue("rendererContractVersion").jsonPrimitive.int==12)
            val parsed=com.badlogic.gdx.utils.JsonReader().parse(File(root,"render-catalog.json").readText())
            stage="parse-combat-catalogue"
            val library=CombatArt.catalogue(parsed)
            val presentation=catalogue.getValue("presentation").jsonObject
            val constants=catalogue.getValue("constants").jsonObject
            val tickMs=presentation.getValue("tickMs").jsonPrimitive.float
            val tile=presentation.getValue("tilePixels").jsonPrimitive.float
            val unit=presentation.getValue("unitsPerTile").jsonPrimitive.float
            val cadence=constants.getValue("RAID_RULES").jsonObject.getValue("troopFireVisualTicks").jsonPrimitive.int
            val brood=constants.getValue("TROOP_ABILITIES").jsonObject.getValue("hexbarrow").jsonObject.getValue("brood").jsonObject.getValue("positionKeyframeTicks").jsonPrimitive.int
            check(requireNotNull(manifest).string("contentVersion")=="033ac8c6bdc79b01260ae829148c94c31b85174db2c28edc8402fc50f1fa2adc")
            val cases=mutableListOf<Case>()
            fun sprites(plan:CombatVisualPlan,tick:Float)=mutableListOf<CombatSprite>().also { plan.transientSprites(tick,it) }
            fun metadata(sprite:CombatSprite)=buildJsonObject {
                put("clip",sprite.clip.key);put("frame",sprite.frameKey);put("atlasPath",sprite.clip.atlasPath)
                put("x",sprite.x);put("y",sprite.y);put("depth",sprite.depth)
                put("scaleX",sprite.horizontalScale);put("scaleY",sprite.clip.scale)
                put("rotationDegrees",sprite.rotation);put("alpha",sprite.alpha);put("flipX",sprite.flipX)
            }
            val headings=linkedMapOf("e" to (1 to 0),"w" to (-1 to 0),"ne" to (1 to -1))
            for(name in listOf("tunneler","bilgewraith")) {
                stage="select-authored-tiers-$name"
                val actors=render.objects("actors").filter { it.string("type")==name }.distinctBy { it.string("combatKey") }
                check(actors.size==4) { "Four authored tiers required for $name" }
                for((tier,actor) in actors.withIndex()) {
                    stage="resolve-profile-$name-t${tier+1}"
                    val frame=requireNotNull(actor.string("frameKey"));val art=library.getValue(frame)
                    val contract=requireNotNull(art.burrowMotion)
                    val enter=art.clips.getValue(contract.enterState);val tunnel=art.clips.getValue(contract.tunnelState)
                    val surface=art.clips.getValue(contract.surfaceState);val walk=art.clips.getValue(art.profile.getString("battleMove",null) ?: art.profile.getString("move"))
                    val idle=art.clips.getValue(art.profile.getString("stand"))
                    val headingEnd=kotlin.math.ceil(walk.durationMs.toDouble()/tickMs).toInt()
                    val cast=headingEnd+1;val castMs=cast*tickMs
                    val emergeOffset=kotlin.math.ceil((enter.durationMs.toDouble()+tunnel.durationMs)/tickMs).toInt()
                    fun release(body:AuthoredClip):Double {
                        check(body.effectByCue.getValue("soil") in art.effects)
                        return (body.fxCues.getValue("soil").single()-1)*1000.0/body.fps
                    }
                    val entrySoil=release(enter);val surfaceSoil=release(surface)
                    for((facing,direction) in headings) {
                        val(dx,dy)=direction
                        fun event(type:String,t:Int,extra:String="")="""{"e":"$type","t":$t,"id":1$extra}"""
                        fun pos(t:Int,x:Float=8*unit,y:Float=6*unit)=event("pos",t,",\"x\":$x,\"y\":$y")
                        val heading=listOf("""{"e":"deploy","t":0,"id":1,"troop":"$name","x":${(6-2*dx)*unit},"y":${(6-2*dy)*unit}}""",pos(headingEnd,6*unit,6*unit))
                        val entry=event("burrow",cast);val emerge=event("emerge",cast+emergeOffset)
                        fun scene(label:String,events:List<String>,raid:String=label,start:BattlePresentationStart=BattlePresentationStart.Continuous):BattleScene {
                            val journal=(heading+events).map(PresentationEvent::fromJson).sortedBy { it.t }
                            return BattleScene(BaseScene(emptyList(),12,12,tile),
                                PresentationRevision("synthetic-burrow-$name-$tier-$facing-$raid",label,catalogue.getValue("simVersion").jsonPrimitive.int,0,0,journal),
                                mapOf(name to frame),unit,tickMs,cadence,brood,playing=false,presentationStart=start)
                        }
                        fun plan(scene:BattleScene)=CombatVisualPlan(scene,BattleVisualModel(scene.revision.events,cadence,brood),library)
                        fun add(label:String,scene:BattleScene,elapsed:Double?,verify:(CombatVisualPlan,Float)->Unit={_,_->}) {
                            stage="assemble-$name-t${tier+1}-$facing-$label"
                            assemblyCase=buildJsonObject {
                                put("label",label);put("unit",name);put("tier",tier+1);put("facing",facing)
                                put("requestedElapsedSinceEntryMs",elapsed?.let(::JsonPrimitive) ?: JsonNull)
                                put("sourceEvents",JsonArray(scene.revision.events.map { Json.parseToJsonElement(it.json) }))
                            }
                            val plan=plan(scene);check(plan.missingCoverage.isEmpty()) { "Case has missing visual coverage" }
                            val tick=if(elapsed==null) plan.playbackExtent.visualEndTick else {
                                val requested=castMs.toDouble()+elapsed
                                var t=(requested/tickMs).toFloat()
                                while((t*tickMs).toDouble()<requested)t=Math.nextUp(t)
                                t
                            }
                            check(tick>=0 && tick<=plan.playbackExtent.visualEndTick) { "$label must be renderer reachable" }
                            val expectation=buildJsonObject {
                                put("unit",name);put("authoredTierIndex",tier+1);put("facing",facing);put("actorFrameKey",frame)
                                put("castTick",cast);put("headingEndTick",headingEnd);put("emergeOffsetTicks",emergeOffset)
                                put("requestedElapsedSinceEntryMs",elapsed?.let(::JsonPrimitive) ?: JsonNull)
                                put("actualElapsedSinceEntryMs",tick*tickMs-castMs)
                                put("presentationStart",when(val start=scene.presentationStart) {
                                    BattlePresentationStart.Continuous -> "continuous"
                                    is BattlePresentationStart.ColdPrefix -> "cold-prefix:${start.fromTick}"
                                })
                                put("actor",plan.actor(1,tick)?.let(::metadata) ?: JsonNull)
                                put("effects",JsonArray(sprites(plan,tick).map(::metadata)))
                                val from=(scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick ?: 0f
                                put("positionDeliveries",JsonArray(PositionDelivery.compile(scene.revision.events,cadence,brood,tickMs,from).values.map { delivery ->
                                    buildJsonObject { put("eventOrdinal",delivery.eventOrdinal);put("startTick",delivery.startTick)
                                        put("durationMs",delivery.durationMs);put("skip",delivery.skip) }
                                }))
                            }
                            assemblyCase=buildJsonObject {
                                put("label",label);put("tick",tick);put("eventEndTick",plan.playbackExtent.eventEndTick)
                                put("visualEndTick",plan.playbackExtent.visualEndTick);put("expectation",expectation)
                                put("sourceEvents",JsonArray(scene.revision.events.map { Json.parseToJsonElement(it.json) }))
                            }
                            verify(plan,tick)
                            cases+=Case("$name-t${tier+1}-$facing-$label",scene.copy(playheadTick=tick),expectation)
                        }
                        val plain=scene("basic",listOf(entry,emerge))
                        val phases=listOf("entry" to 0.0,"entry-soil" to entrySoil+.02,"tunnel" to enter.durationMs.toDouble()+.02,
                            "tunnel-cycle" to enter.durationMs.toDouble()+tunnel.durationMs/2+.02,
                            "emerge" to emergeOffset*tickMs.toDouble()+.02,"surface-soil" to emergeOffset*tickMs.toDouble()+surfaceSoil+.02)
                        for((label,elapsed) in phases) add("basic-$label",plain,elapsed) { p,t ->
                            val body=requireNotNull(p.actor(1,t));check(body.alpha==1f && body.x==6*tile && body.y==6*tile)
                            val expected=when(label) { "entry","entry-soil"->enter;"tunnel","tunnel-cycle"->tunnel;else->surface }
                            check(body.clip.key==expected.key)
                            check(sprites(p,t).size==if(label.endsWith("soil"))1 else 0)
                        }
                        add("basic-final",plain,null) { p,t->check(p.actor(1,t)?.clip?.key==idle.key && sprites(p,t).isEmpty()) }
                        if(tier!=0 || facing!="e")continue
                        // Shortened synthetic lifecycle journal follows the focused renderer cases;
                        // unlike the browser basic cycle it emerges while an endpoint is in flight.
                        val earlyEmerge=event("emerge",cast+2)
                        val endpoint=pos(cast+cadence)
                        val moving=scene("moving",listOf(entry,earlyEmerge,endpoint),"revision")
                        check(PositionDelivery.compile(moving.revision.events,cadence,brood,tickMs).values.last().startTick==cast.toFloat())
                        add("moving-entry-soil",moving,entrySoil+.02) { p,t->check(sprites(p,t).size==1 && requireNotNull(p.actor(1,t)).x>6*tile) }
                        add("moving-surface-soil",moving,2*tickMs+surfaceSoil+.02) { p,t->check(sprites(p,t).isNotEmpty()) }
                        add("moving-final",moving,null) { p,t->check(sprites(p,t).isEmpty() && p.actor(1,t)?.clip?.key==idle.key) }
                        val coordinate=scene("coordinate",listOf(entry,event("emerge",cast+2,",\"x\":${8*unit},\"y\":${5*unit}"),endpoint))
                        add("coordinate-soil",coordinate,2*tickMs+surfaceSoil+.02) { p,t->val b=requireNotNull(p.actor(1,t));check(b.x==8*tile && b.y==5*tile) }
                        add("coordinate-final",coordinate,null) { p,t->val b=requireNotNull(p.actor(1,t));check(b.x==8*tile && b.y==5*tile && b.clip.key==walk.key && sprites(p,t).isEmpty()) }
                        val before=kotlin.math.floor(entrySoil/tickMs).toInt();val after=kotlin.math.ceil(entrySoil/tickMs).toInt()
                        check(before*tickMs<entrySoil && after*tickMs>entrySoil)
                        for((label,offset) in listOf("early" to before,"late" to after)) {
                            val dead=scene("death-$label",listOf(entry,event("troopDeath",cast+offset)))
                            add("death-$label-after",dead,offset*tickMs+.02) { p,t->check(sprites(p,t).size==if(label=="early")0 else 1) }
                            add("death-$label-final",dead,null) { p,t->check(sprites(p,t).isEmpty()) }
                        }
                        add("rewind-before",moving,entrySoil+.02)
                        add("rewind-forward",moving,null)
                        add("rewind-back",moving,entrySoil+.02)
                        val revised=scene("removed-burrow",listOf(endpoint),"revision")
                        add("revision-removed",revised,entrySoil+.02) { p,t->check(sprites(p,t).isEmpty()) }
                        add("revision-restored",moving,entrySoil+.02)
                        val coldEntry=scene("cold-entry",listOf(entry,emerge),start=BattlePresentationStart.ColdPrefix(cast+.5f))
                        add("cold-entry",coldEntry,.5*tickMs) { p,t->check(p.actor(1,t)?.clip?.key==tunnel.key && sprites(p,t).isEmpty()) }
                        val coldEmerge=scene("cold-emerge",listOf(entry,event("emerge",cast+emergeOffset,",\"x\":${8*unit},\"y\":${5*unit}")),start=BattlePresentationStart.ColdPrefix(cast+emergeOffset+.5f))
                        add("cold-emerge",coldEmerge,(emergeOffset+.5)*tickMs) { p,t->val b=requireNotNull(p.actor(1,t));check(b.clip.key==idle.key && b.x==8*tile && b.y==5*tile && sprites(p,t).isEmpty()) }
                    }
                }
            }
            stage="verify-case-count"
            check(cases.size==200 && cases.map { it.name }.distinct().size==cases.size) { "Expected 200 uniquely named burrow cases, got ${cases.size}" }
            assemblyCase=null

            val selected=mutableStateOf(cases.first());val selectionKey=mutableStateOf(0)
            val expected=AtomicReference(cases.first());val matching=AtomicInteger()
            val lastFrame=AtomicReference<BattlePlaybackFrame?>(null);val gate=AtomicReference(CountDownLatch(1))
            stage="attach-motion-test-host";receipt("running")
            instrumentation.runOnMainSync {
                host.setContent { MaterialTheme { Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                    Text("SYNTHETIC BURROW · ${selected.value.name} · no account",Modifier.padding(12.dp))
                    SceneSurface(root,selected.value.scene.base,Modifier.fillMaxWidth().weight(1f),battle=selected.value.scene,
                        playbackKey=selectionKey.value,onFrame={ frame ->
                            val want=expected.get().scene
                            if(frame.raidId==want.revision.raidId && frame.revision==want.revision.revision && frame.playheadTick==want.playheadTick) {
                                lastFrame.set(frame);if(matching.incrementAndGet()>=3) gate.get().countDown()
                            } else matching.set(0)
                        })
                } } }
            }
            for((index,case) in cases.withIndex()) {
                stage="paused-${case.name}";receipt("running")
                val tick=case.scene.playheadTick
                val ready=CountDownLatch(1);gate.set(ready);matching.set(0);lastFrame.set(null);expected.set(case)
                instrumentation.runOnMainSync { selected.value=case;selectionKey.value=index+1 }
                check(ready.await(30,TimeUnit.SECONDS)) { "Motion GL progress did not stabilize" }
                val copied=CountDownLatch(1);val result=AtomicInteger(-1);var bitmap: Bitmap?=null
                instrumentation.runOnMainSync {
                    Choreographer.getInstance().postFrameCallback { Choreographer.getInstance().postFrameCallback copy@{
                        if(matching.get()<3 || selected.value!=case) { copied.countDown();return@copy }
                        val surface=surfaces(host.window.decorView).singleOrNull { it.isAttachedToWindow && it.width>0 && it.height>0 }
                        if(surface==null) { copied.countDown();return@copy }
                        try {
                            bitmap=Bitmap.createBitmap(surface.width,surface.height,Bitmap.Config.ARGB_8888)
                            PixelCopy.request(surface,requireNotNull(bitmap),{ code -> result.set(code);copied.countDown() },Handler(Looper.getMainLooper()))
                        } catch(_: Exception) { result.set(PixelCopy.ERROR_SOURCE_INVALID);copied.countDown() }
                    } }
                }
                check(copied.await(10,TimeUnit.SECONDS) && result.get()==PixelCopy.SUCCESS && matching.get()>=3)
                val image=requireNotNull(bitmap)
                try {
                    val frame=requireNotNull(lastFrame.get())
                    check(frame.raidId==case.scene.revision.raidId && frame.revision==case.scene.revision.revision && frame.playheadTick==tick)
                    val output=File(directory,"${case.name}.png")
                    check(!output.exists());output.outputStream().use { check(image.compress(Bitmap.CompressFormat.PNG,100,it)) }
                    files+=buildJsonObject {
                        put("path",output.name);put("sha256",sha(output));put("bytes",output.length());put("width",image.width);put("height",image.height)
                        put("tick",tick);put("raidId",frame.raidId);put("revision",frame.revision)
                        put("eventEndTick",frame.extent.eventEndTick);put("visualEndTick",frame.extent.visualEndTick)
                        put("matchingProgressCallbacks",matching.get());put("progressRequiresCompleteTextures",true)
                        put("progressEmittedAfterBatchEnd",true);put("uiFrameBoundariesAfterMatch",2);put("pixelCopyResult",result.get())
                        put("sourceEvents",JsonArray(case.scene.revision.events.map { Json.parseToJsonElement(it.json) }))
                        put("modelExpectation",case.expectation);put("modelExpectationIsPixelMeasurement",false)
                    }
                } finally { image.recycle() }
            }
            check(files.size==cases.size)
            stage="all-motion-checkpoints-captured";receipt("captured-needs-visual-inspection")
        } catch(error: Exception) {
            // This closed offline harness never reads sessions or performs API calls.
            // Keep bounded exception details locally so pre-render failures are actionable.
            failure=buildJsonObject {
                put("type",error.javaClass.name);put("message",error.message?.take(2048)?.let(::JsonPrimitive) ?: JsonNull)
                put("stack",JsonArray(error.stackTrace.take(16).map { JsonPrimitive(it.toString()) }))
            }
            receipt("failed");throw error
        }
        finally {
            activity?.let { host -> instrumentation.runOnMainSync { host.finishAndRemoveTask() } }
            instrumentation.waitForIdleSync()
        }
    }
    private fun surfaces(view: View): List<SurfaceView> = when(view) {
        is SurfaceView -> listOf(view)
        is ViewGroup -> (0 until view.childCount).flatMap { surfaces(view.getChildAt(it)) }
        else -> emptyList()
    }
}
