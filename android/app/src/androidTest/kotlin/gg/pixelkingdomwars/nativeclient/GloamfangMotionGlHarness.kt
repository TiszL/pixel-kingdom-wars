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
internal object GloamfangMotionGlHarness {
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
        val directory=File(context.noBackupFilesDir,"gloamfang-motion-gl")
        check(directory.mkdir()) { "Preserve prior motion GL evidence before rerunning" }
        var activity: MainActivity?=null
        var stage="launch-offline-preview"
        var manifest: JsonObject?=null
        var renderCatalogueSha: String?=null
        val files=mutableListOf<JsonObject>()
        val runtimeApkSha=sha(File(context.applicationInfo.sourceDir))
        fun receipt(status: String) {
            File(directory,"receipt.json").writeText(buildJsonObject {
                put("status",status);put("stage",stage);put("fixture","gloamfang-motion-gl")
                put("syntheticPresentationOnly",true);put("backendAccessRequested",false);put("walletApprovalTested",false)
                put("runtimePackage",context.packageName);put("runtimeApkSha256",runtimeApkSha)
                put("contentVersion",manifest?.get("contentVersion") ?: JsonNull)
                put("sourceCommit",manifest?.get("sourceCommit") ?: JsonNull)
                put("renderCatalogueSha256",renderCatalogueSha?.let(::JsonPrimitive) ?: JsonNull)
                put("rendererContractVersion",manifest?.get("rendererContractVersion") ?: JsonNull)
                put("scope","Synthetic original-art Leap/Lunge GL: four tiers plus writer coexistence, cancellation, rewind and revision. Analytic model metadata is not a measured browser position or a gameplay outcome.")
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
            check(render.getValue("rendererContractVersion").jsonPrimitive.int==11)
            val parsed=com.badlogic.gdx.utils.JsonReader().parse(File(root,"render-catalog.json").readText())
            val library=CombatArt.catalogue(parsed)
            val presentation=catalogue.getValue("presentation").jsonObject
            val constants=catalogue.getValue("constants").jsonObject
            val tickMs=presentation.getValue("tickMs").jsonPrimitive.float
            val tile=presentation.getValue("tilePixels").jsonPrimitive.float
            val unit=presentation.getValue("unitsPerTile").jsonPrimitive.float
            val cadence=constants.getValue("RAID_RULES").jsonObject.getValue("troopFireVisualTicks").jsonPrimitive.int
            val brood=constants.getValue("TROOP_ABILITIES").jsonObject.getValue("hexbarrow").jsonObject.getValue("brood").jsonObject.getValue("positionKeyframeTicks").jsonPrimitive.int
            val actors=render.objects("actors").filter { it.string("type")=="gloamfang" }
                .distinctBy { library.getValue(requireNotNull(it.string("frameKey"))).clips.getValue("leap").key }
            check(actors.size==4) { "Four authored motion tiers required" }
            val cases=mutableListOf<Case>()
            fun sprites(plan:CombatVisualPlan,tick:Float)=mutableListOf<CombatSprite>().also { plan.transientSprites(tick,it) }
            fun metadata(sprite:CombatSprite)=buildJsonObject {
                put("clip",sprite.clip.key);put("frame",sprite.frameKey);put("atlasPath",sprite.clip.atlasPath)
                put("x",sprite.x);put("y",sprite.y);put("depth",sprite.depth)
                put("scaleX",sprite.horizontalScale);put("scaleY",sprite.clip.scale)
                put("rotationDegrees",sprite.rotation);put("alpha",sprite.alpha);put("flipX",sprite.flipX)
            }
            for((tier,actor) in actors.withIndex()) {
                val frame=requireNotNull(actor.string("frameKey"));val art=library.getValue(frame)
                val leap=requireNotNull(art.leap);val lunge=requireNotNull(art.lunge)
                val leapBody=art.clips.getValue(leap.bodyState);val lungeBody=art.clips.getValue(lunge.bodyState)
                val spawn=art.clips.getValue(art.profile.getString("spawn"))
                // Complete spawn before casting; synthetic geometry is not a legal-order or outcome claim.
                val cast=kotlin.math.floor((spawn.durationMs/tickMs).toDouble()).toInt()+1+cadence
                val castMs=cast*tickMs
                fun deploy()="""{"e":"deploy","t":0,"id":1,"troop":"gloamfang","x":${4*unit},"y":${8*unit}}"""
                fun ability(kind:String,t:Int=cast,x:Float=4*unit,y:Float=8*unit)=
                    """{"e":"troopAbility","t":$t,"id":1,"ability":"$kind","x":$x,"y":$y,"ix":${if(kind=="leap") 8*unit else 2*unit},"iy":${if(kind=="leap") 8*unit else 10*unit}}"""
                fun pos(t:Int,x:Float=10*unit,y:Float=6*unit)="""{"e":"pos","t":$t,"id":1,"x":$x,"y":$y}"""
                fun scene(name:String,events:List<String>,raid:String=name):BattleScene {
                    val journal=(listOf(deploy())+events).map(PresentationEvent::fromJson).sortedBy { it.t }
                    return BattleScene(BaseScene(emptyList(),12,12,tile),
                        PresentationRevision("synthetic-motion-$tier-$raid",name,catalogue.getValue("simVersion").jsonPrimitive.int,0,0,journal),
                        mapOf("gloamfang" to frame),unit,tickMs,cadence,brood,playing=false)
                }
                fun plan(scene:BattleScene)=CombatVisualPlan(scene,BattleVisualModel(scene.revision.events,cadence,brood),library)
                fun add(name:String,scene:BattleScene,elapsed:Double?,verify:(CombatVisualPlan,Float)->Unit={_,_->}) {
                    val plan=plan(scene)
                    val tick=if(elapsed==null) plan.playbackExtent.visualEndTick else {
                        fun actual(t:Float)=(t*tickMs-castMs).toDouble()
                        var t=((castMs.toDouble()+elapsed)/tickMs.toDouble()).toFloat()
                        while(actual(t)<elapsed)t=Math.nextUp(t)
                        while(actual(Math.nextDown(t))>=elapsed)t=Math.nextDown(t)
                        check(actual(Math.nextDown(t))<elapsed && actual(t)>=elapsed)
                        t
                    }
                    check(tick>=0 && tick<=plan.playbackExtent.visualEndTick)
                    verify(plan,tick)
                    val expectation=buildJsonObject {
                        put("authoredTierIndex",tier+1);put("actorFrameKey",frame);put("castTick",cast)
                        put("leapBodyKey",leapBody.key);put("lungeBodyKey",lungeBody.key)
                        put("requestedElapsedSinceCastMs",elapsed?.let(::JsonPrimitive) ?: JsonNull)
                        put("actualElapsedSinceCastMs",tick*tickMs-castMs)
                        put("checkpointQuantizationDeltaMs",elapsed?.let { JsonPrimitive((tick*tickMs-castMs).toDouble()-it) } ?: JsonNull)
                        put("actor",plan.actor(1,tick)?.let(::metadata) ?: JsonNull)
                        put("effects",JsonArray(sprites(plan,tick).map(::metadata)))
                        put("positionDeliveries",JsonArray(PositionDelivery.compile(scene.revision.events,cadence,brood,tickMs).values.map { delivery ->
                            buildJsonObject { put("eventOrdinal",delivery.eventOrdinal);put("startTick",delivery.startTick)
                                put("durationMs",delivery.durationMs);put("skip",delivery.skip) }
                        }))
                    }
                    cases+=Case("t${tier+1}-$name",scene.copy(playheadTick=tick),expectation)
                }
                fun cueTimes(body:AuthoredClip,cue:String):List<Double> {
                    check(body.effectByCue[cue] in art.effects)
                    return body.fxCues.getValue(cue).map { (it-1)*1000.0/body.fps }.also { check(it.size==2) }
                }
                val dust=cueTimes(leapBody,"dust");val rend=cueTimes(lungeBody,"rend")
                fun duration(clip:AuthoredClip)=clip.frames.first().size*1000.0/clip.fps
                val plainLeap=scene("leap",listOf(ability("leap")))
                add("leap-cast",plainLeap,0.0)
                add("leap-first-dust",plainLeap,dust.first()) { p,t->check(sprites(p,t).size==1) }
                add("leap-apex",plainLeap,leap.durationMs/2.0) { p,t->
                    val sprite=requireNotNull(p.actor(1,t));check(sprite.y<8*tile && kotlin.math.abs(sprite.depth-8*tile)<.01f)
                }
                add("leap-last-dust",plainLeap,dust.last()) { p,t->check(sprites(p,t).isNotEmpty()) }
                add("leap-travel-end",plainLeap,leap.durationMs.toDouble())
                add("leap-body-end",plainLeap,duration(leapBody))
                add("leap-expired",plainLeap,null) { p,t->check(sprites(p,t).isEmpty()) }
                val plainLunge=scene("lunge-no-position",listOf(ability("lunge")))
                add("lunge-cast",plainLunge,0.0)
                add("lunge-first-rend",plainLunge,rend.first()) { p,t->check(sprites(p,t).size==1) }
                add("lunge-second-rend",plainLunge,rend.last()) { p,t->
                    check(sprites(p,t).size==2);val sprite=requireNotNull(p.actor(1,t));check(sprite.x==4*tile && sprite.y==8*tile)
                }
                add("lunge-rend-tail",plainLunge,rend.last()+duration(art.effects.getValue(lungeBody.effectByCue.getValue("rend")))/2)
                add("lunge-expired",plainLunge,null) { p,t->check(sprites(p,t).isEmpty()) }
                if(tier!=0) continue
                // These endpoint journals exercise the real source delivery compiler, never injected schedules.
                val shortEvents=listOf(ability("leap"),pos(cast+2,4*unit,8*unit),pos(cast+4))
                val short=scene("short-writer",shortEvents,"revision")
                val deliveries=PositionDelivery.compile(short.revision.events,cadence,brood,tickMs).values.toList()
                check(deliveries.last().startTick==(cast+2).toFloat() && deliveries.last().durationMs==2*tickMs && 4*tickMs<leap.durationMs)
                for((name,elapsed) in listOf("delivery" to 2.0,"mid" to 3.0,"endpoint" to 4.0,"arc-resumes" to 4.25))
                    add("short-$name",short,elapsed*tickMs) { p,t->
                        val sprite=requireNotNull(p.actor(1,t))
                        if(name=="endpoint") check(sprite.x==10*tile && sprite.y==6*tile)
                        if(name=="arc-resumes") check(sprite.x<10*tile && sprite.clip.key==leapBody.key)
                    }
                add("short-expired",short,null)
                val long=scene("long-writer",listOf(ability("leap"),pos(cast+cadence+3)))
                check(PositionDelivery.compile(long.revision.events,cadence,brood,tickMs).values.single().startTick==(cast+3).toFloat())
                add("long-delivery",long,3.0*tickMs)
                add("long-mid",long,4.0*tickMs)
                add("long-travel-end",long,leap.durationMs.toDouble())
                add("long-body-end",long,duration(leapBody))
                add("long-endpoint",long,(cadence+3.0)*tickMs) { p,t->check(requireNotNull(p.actor(1,t)).x==10*tile) }
                val death=scene("leap-death",listOf(ability("leap"),"""{"e":"troopDeath","t":${cast+2},"id":1}"""))
                add("death-before",death,1.5*tickMs)
                add("death-after",death,2.5*tickMs) { p,t->
                    val first=requireNotNull(p.actor(1,(cast+2).toFloat()));val later=requireNotNull(p.actor(1,t))
                    check(first.x==later.x && first.y==later.y)
                }
                add("death-expired",death,null)
                val replacement=scene("ability-replacement",listOf(ability("leap"),ability("lunge",cast+2,7*unit,5*unit)))
                add("replacement-before",replacement,1.5*tickMs)
                add("replacement-after",replacement,2.5*tickMs) { p,t->
                    val sprite=requireNotNull(p.actor(1,t));check(sprite.x==7*tile && sprite.y==5*tile)
                }
                add("replacement-expired",replacement,null)
                val immediate=scene("lunge-immediate",listOf(ability("lunge"),pos(cast+cadence)))
                check(PositionDelivery.compile(immediate.revision.events,cadence,brood,tickMs).values.single().startTick==cast.toFloat())
                for((name,elapsed) in listOf("cast" to 0.0,"first-key" to rend.first(),"second-key" to rend.last()))
                    add("immediate-$name",immediate,elapsed) { p,t->
                        val sprite=requireNotNull(p.actor(1,t));check(sprite.x==10*tile && sprite.y==6*tile && sprites(p,t).isEmpty())
                    }
                val delayed=scene("lunge-delayed",listOf(ability("lunge"),pos(cast+2,4*unit,8*unit),pos(cast+4)))
                check(rend.first()<2*tickMs && rend.last()>2*tickMs)
                add("delayed-first-rend",delayed,rend.first()) { p,t->check(sprites(p,t).size==1) }
                add("delayed-snap",delayed,2.0*tickMs) { p,t->
                    val sprite=requireNotNull(p.actor(1,t));check(sprite.x==10*tile && sprite.y==6*tile && sprites(p,t).size==1)
                }
                add("delayed-second-cancelled",delayed,rend.last()) { p,t->check(sprites(p,t).size==1) }
                // Revisit a paused state after later playback, then replace the accepted journal.
                add("rewind-forward",short,4.25*tickMs)
                add("rewind-back",short,3.0*tickMs)
                val revised=scene("no-leap-revision",shortEvents.drop(1),"revision")
                add("revision-without-leap",revised,3.0*tickMs) { p,t->check(sprites(p,t).isEmpty()) }
                add("revision-restored-leap",short,3.0*tickMs)
            }
            check(cases.size==74 && cases.map { it.name }.distinct().size==cases.size)

            val selected=mutableStateOf(cases.first());val selectionKey=mutableStateOf(0)
            val expected=AtomicReference(cases.first());val matching=AtomicInteger()
            val lastFrame=AtomicReference<BattlePlaybackFrame?>(null);val gate=AtomicReference(CountDownLatch(1))
            stage="attach-motion-test-host";receipt("running")
            instrumentation.runOnMainSync {
                host.setContent { MaterialTheme { Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                    Text("SYNTHETIC LEAP / LUNGE · ${selected.value.name} · no account",Modifier.padding(12.dp))
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
        } catch(error: Exception) { receipt("failed");throw error }
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
