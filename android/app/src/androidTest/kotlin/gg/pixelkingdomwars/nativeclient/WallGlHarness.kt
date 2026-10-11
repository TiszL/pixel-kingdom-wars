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
internal object WallGlHarness {
    private data class Case(val name: String,val scene: BattleScene,val expectedMasks: Map<String,Int>)
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
        val directory=File(context.noBackupFilesDir,"walls-gl")
        check(directory.mkdir()) { "Preserve prior wall GL evidence before rerunning" }
        var activity: MainActivity?=null
        var stage="launch-offline-preview"
        var manifest: JsonObject?=null
        val files=mutableListOf<JsonObject>()
        val runtimeApkSha=sha(File(context.applicationInfo.sourceDir))
        fun receipt(status: String) {
            File(directory,"receipt.json").writeText(buildJsonObject {
                put("status",status);put("stage",stage);put("fixture","walls-gl")
                put("syntheticPresentationOnly",true);put("backendAccessRequested",false);put("walletApprovalTested",false)
                put("runtimePackage",context.packageName);put("runtimeApkSha256",runtimeApkSha)
                put("contentVersion",manifest?.get("contentVersion") ?: JsonNull)
                put("sourceCommit",manifest?.get("sourceCommit") ?: JsonNull)
                put("rendererContractVersion",manifest?.get("rendererContractVersion") ?: JsonNull)
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
            check(render.getValue("rendererContractVersion").jsonPrimitive.int>=5)
            val parsed=com.badlogic.gdx.utils.JsonReader().parse(File(root,"render-catalog.json").readText())
            val wallCatalogue=WallCatalogue(parsed);val library=CombatArt.catalogue(parsed)
            val wallEntries=render.objects("walls")
            val levels=wallEntries.filter { it.getValue("mask").jsonPrimitive.int==0 }
                .sortedBy { it.getValue("level").jsonPrimitive.int }.distinctBy { it.string("frameKey") }
                .map { it.getValue("level").jsonPrimitive.int }
            check(levels.size>=4) { "Mixed authored wall tiers missing" }
            fun entry(level: Int,mask: Int)=wallEntries.single {
                it.getValue("level").jsonPrimitive.int==level && it.getValue("mask").jsonPrimitive.int==mask }
            fun wall(id: String,x: Int,y: Int,level: Int): RenderBuilding {
                val e=entry(level,0) // Deliberately unconnected input; renderer must select topology.
                return RenderBuilding(id,requireNotNull(e.string("frameKey")),x.toFloat(),y.toFloat(),
                    e.getValue("footprintWidth").jsonPrimitive.float,e.getValue("footprintHeight").jsonPrimitive.float,type="wall",level=level)
            }
            val presentation=catalogue.getValue("presentation").jsonObject
            val constants=catalogue.getValue("constants").jsonObject
            val tickMs=presentation.getValue("tickMs").jsonPrimitive.float
            val cadence=constants.getValue("RAID_RULES").jsonObject.getValue("troopFireVisualTicks").jsonPrimitive.int
            val brood=constants.getValue("TROOP_ABILITIES").jsonObject.getValue("hexbarrow").jsonObject.getValue("brood").jsonObject.getValue("positionKeyframeTicks").jsonPrimitive.int
            fun scene(name: String,buildings: List<RenderBuilding>,events: List<PresentationEvent>,tick: Float=0f,raid: String=name)=BattleScene(
                BaseScene(buildings,12,12,presentation.getValue("tilePixels").jsonPrimitive.float),
                PresentationRevision("synthetic-wall-$raid",name,catalogue.getValue("simVersion").jsonPrimitive.int,0,0,events),
                emptyMap(),presentation.getValue("unitsPerTile").jsonPrimitive.float,tickMs,cadence,brood,playheadTick=tick,playing=false)
            val cases=mutableListOf<Case>()
            val directions=listOf(0 to -1,1 to 0,0 to 1,-1 to 0)
            for(group in 0..3) {
                val buildings=mutableListOf<RenderBuilding>();val masks=linkedMapOf<String,Int>()
                for(slot in 0..3) {
                    val mask=group*4+slot;val x=3+(slot%2)*6;val y=3+(slot/2)*6
                    val centerLevel=levels[(group+slot)%levels.size]
                    buildings+=wall("center-$mask",x,y,centerLevel);masks["center-$mask"]=mask
                    directions.forEachIndexed { bit,(dx,dy) -> if(mask and (1 shl bit)!=0)
                        buildings+=wall("neighbor-$mask-$bit",x+dx,y+dy,levels[((group+slot)+1+bit%(levels.size-1))%levels.size]) }
                    // A diagonal may change neighboring pieces, but never this center's mask.
                    if(mask==0 || mask==15) buildings+=wall("diagonal-$mask",x+1,y+1,levels[(group+slot+1)%levels.size])
                }
                cases+=Case("masks-${group*4}-${group*4+3}",scene("masks-$group",buildings,emptyList()),masks)
            }
            val row=listOf(wall("left",4,6,levels[0]),wall("middle",5,6,levels[1]),wall("right",6,6,levels[2]))
            fun destroyed(id: String)=PresentationEvent.fromJson("""{"e":"destroyed","t":10,"id":"$id"}""")
            val original=scene("middle-breach",row,listOf(destroyed("middle")),raid="breach")
            val wallModel=WallVisualModel(row,wallCatalogue,original.revision.events)
            val collapseFrame=requireNotNull(wallModel.frameAt("middle",10f))
            val collapse=library.getValue(collapseFrame).clips.getValue("collapse")
            val model=BattleVisualModel(original.revision.events,cadence,brood)
            val extent=CombatVisualPlan(original,model,library,walls=wallModel).playbackExtent
            val before=mapOf("left" to 2,"middle" to 10,"right" to 8)
            val after=mapOf("left" to 0,"middle" to 10,"right" to 0)
            cases+=Case("breach-before",original.copy(playheadTick=9f),before)
            cases+=Case("breach-exact",original.copy(playheadTick=10f),after)
            cases+=Case("breach-collapse",original.copy(playheadTick=10f+collapse.durationMs/tickMs*.5f),after)
            cases+=Case("breach-final",original.copy(playheadTick=extent.visualEndTick),after)
            cases+=Case("breach-rewind",original.copy(playheadTick=9f),before)
            cases+=Case("breach-replacement",scene("left-breach",row,listOf(destroyed("left")),10f,"breach"),
                mapOf("left" to 2,"middle" to 2,"right" to 8))

            val selected=mutableStateOf(cases.first());val selectionKey=mutableStateOf(0)
            val expected=AtomicReference(cases.first());val matching=AtomicInteger()
            val lastFrame=AtomicReference<BattlePlaybackFrame?>(null);val gate=AtomicReference(CountDownLatch(1))
            stage="attach-wall-test-host";receipt("running")
            instrumentation.runOnMainSync {
                host.setContent { MaterialTheme { Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                    Text("SYNTHETIC WALLS · ${selected.value.name} · no account",Modifier.padding(12.dp))
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
                val walls=WallVisualModel(case.scene.base.buildings,wallCatalogue,case.scene.revision.events)
                val visual=BattleVisualModel(case.scene.revision.events,cadence,brood)
                val plan=CombatVisualPlan(case.scene,visual,library,walls=walls)
                val tick=case.scene.playheadTick
                check(tick<=plan.playbackExtent.visualEndTick)
                val topology=case.scene.base.buildings.map { b ->
                    val connection=requireNotNull(walls.frameAt(b.id,tick))
                    val expectedMask=case.expectedMasks[b.id]
                    val selectedMask=wallCatalogue.family(connection)!!.entries.single { it.value==connection }.key
                    val selectedEntry=entry(requireNotNull(b.level),selectedMask)
                    if(expectedMask!=null) check(connection==entry(requireNotNull(b.level),expectedMask).string("frameKey"))
                    val sprite=plan.building(b.id,tick,frameKey=connection,frameSinceTick=walls.frameSinceTick(b.id,tick) ?: 0)
                    buildJsonObject {
                        put("id",b.id);put("level",b.level);put("tileX",b.tileX);put("tileY",b.tileY)
                        put("footprintWidth",b.footprintWidth);put("footprintHeight",b.footprintHeight)
                        put("inputFrame",b.frameKey);put("connectionFrame",connection)
                        put("expectedMask",expectedMask?.let(::JsonPrimitive) ?: JsonNull)
                        put("selectedMask",selectedMask);put("atlasPath",selectedEntry.getValue("atlasPath"))
                        put("anchor",selectedEntry.getValue("anchor"));put("scale",selectedEntry.getValue("scale"))
                        put("worldCenterX",(b.tileX+b.footprintWidth/2)*case.scene.base.tilePixels)
                        put("worldSouthEdgeY",(b.tileY+b.footprintHeight)*case.scene.base.tilePixels)
                        put("destroyed",visual.isDestroyed(b.id,tick));put("combatFrame",sprite?.frameKey?.let(::JsonPrimitive) ?: JsonNull)
                        put("combatX",sprite?.x?.let(::JsonPrimitive) ?: JsonNull);put("combatY",sprite?.y?.let(::JsonPrimitive) ?: JsonNull)
                    }
                }
                val ready=CountDownLatch(1);gate.set(ready);matching.set(0);lastFrame.set(null);expected.set(case)
                instrumentation.runOnMainSync { selected.value=case;selectionKey.value=index+1 }
                check(ready.await(30,TimeUnit.SECONDS)) { "Wall GL progress did not stabilize" }
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
                        put("topology",JsonArray(topology));put("topologyIsModelExpectation",true)
                    }
                } finally { image.recycle() }
            }
            check(files.size==10)
            stage="all-wall-checkpoints-captured";receipt("captured-needs-visual-inspection")
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
