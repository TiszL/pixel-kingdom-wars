package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.*
import android.widget.FrameLayout
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.core.view.doOnAttach
import com.badlogic.gdx.backends.android.AndroidApplicationConfiguration
import com.badlogic.gdx.backends.android.AndroidFragmentApplication
import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.network.objects
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.KingdomFragment
import kotlinx.serialization.json.*
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Test APK only. Original bundled art, synthetic events, no account or transport. */
internal object LiveTroopStacksGlHarness {
    private data class Case(val name:String,val scene:BattleScene,val expectedCounts:List<Int>)
    private fun sha(file:File):String {
        val digest=MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer=ByteArray(64*1024);while(true) {
            val count=input.read(buffer);if(count<0)break;digest.update(buffer,0,count)
        } }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
    fun capture(instrumentation:Instrumentation) {
        check(BuildConfig.DEBUG && Build.HARDWARE=="ranchu")
        val context=instrumentation.targetContext
        val directory=File(context.noBackupFilesDir,"live-troop-stacks-gl")
        check(directory.mkdir()) { "Preserve previous stack GL evidence before rerunning" }
        val files=mutableListOf<JsonObject>()
        val runtimeSha=sha(File(context.applicationInfo.sourceDir))
        var stage="launch-offline-preview"
        var activity:MainActivity?=null
        var failure:String?=null
        var catalogueSha:String?=null
        var fallbackFrame:String?=null
        fun receipt(status:String) {
            File(directory,"receipt.json").writeText(buildJsonObject {
                put("status",status);put("stage",stage);put("failure",failure?.let(::JsonPrimitive) ?: JsonNull)
                put("runtimeApkSha256",runtimeSha);put("runtimePackage",context.packageName)
                put("syntheticPresentationOnly",true);put("backendAccessRequested",false)
                put("bundledCatalogueSha256",catalogueSha?.let(::JsonPrimitive) ?: JsonNull)
                put("testOnlyFallbackFrame",fallbackFrame?.let(::JsonPrimitive) ?: JsonNull)
                put("fallbackInjection","Only the selected Highlander combatKey is removed in a private in-memory catalogue copy. Original files and art are unchanged.")
                put("scope","Actual GL captures of authored and fallback stacks through separation, death, seek and revision/reset. Expected counts are intent, not pixel measurements; inspect PNGs.")
                put("files",JsonArray(files))
            }.toString())
        }
        try {
            receipt("running")
            activity=instrumentation.startActivitySync(Intent(context,MainActivity::class.java).putExtra("preview","battle")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            val host=activity
            check(host.intent.getStringExtra("preview")=="battle")
            stage="await-verified-bundled-art";receipt("running")
            var assets:File?=null
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(60)
            while(assets==null && System.nanoTime()<deadline) {
                instrumentation.runOnMainSync {
                    val fragment=host.supportFragmentManager.fragments.filterIsInstance<KingdomFragment>().singleOrNull()
                    if(fragment?.renderer!=null && fragment.assetPath.isNotEmpty())assets=File(fragment.assetPath)
                }
                if(assets==null)Thread.sleep(50)
            }
            val root=requireNotNull(assets)
            check(root.canonicalFile.parentFile==context.noBackupFilesDir.canonicalFile && root.name.matches(Regex("bundled-[a-f0-9]{64}")))
            val catalogue=Json.parseToJsonElement(File(root,"catalogue.json").readText()).jsonObject
            val render=Json.parseToJsonElement(File(root,"render-catalog.json").readText()).jsonObject
            catalogueSha=sha(File(root,"render-catalog.json"))
            val authored=render.objects("actors").first { it.string("type")=="bowman" }
            val fallback=render.objects("actors").first { it.string("type")=="highlander" }
            val authoredFrame=requireNotNull(authored.string("frameKey"))
            fallbackFrame=requireNotNull(fallback.string("frameKey"))
            val tree=JsonReader().parse(File(root,"render-catalog.json").readText())
            tree.get("actors").filter { it.getString("frameKey")==fallbackFrame }.forEach { it.remove("combatKey") }
            val library=CombatArt.catalogue(tree)
            check(authoredFrame in library && fallbackFrame !in library)
            val presentation=catalogue.getValue("presentation").jsonObject
            val constants=catalogue.getValue("constants").jsonObject
            val tickMs=presentation.getValue("tickMs").jsonPrimitive.float
            val tile=presentation.getValue("tilePixels").jsonPrimitive.float
            val unit=presentation.getValue("unitsPerTile").jsonPrimitive.float
            val cadence=constants.getValue("RAID_RULES").jsonObject.getValue("troopFireVisualTicks").jsonPrimitive.int
            val brood=constants.getValue("TROOP_ABILITIES").jsonObject.getValue("hexbarrow").jsonObject.getValue("brood").jsonObject.getValue("positionKeyframeTicks").jsonPrimitive.int
            // Fixture timings leave authored deployment and position delivery completely settled.
            val settled=kotlin.math.ceil(library.getValue(authoredFrame).clips.values.maxOf { it.durationMs }.toDouble()/tickMs).toInt()+1
            val split=settled+2*cadence;val afterSplit=split+cadence
            val dead=afterSplit+cadence;val end=dead+2*settled
            fun event(type:String,t:Int,id:Int,extra:String="")=PresentationEvent.fromJson("""{"e":"$type","t":$t,"id":$id$extra}""")
            fun deploy(id:Int)=event("deploy",0,id,",\"troop\":\"${if(id<=3) "bowman" else "highlander"}\",\"x\":${if(id<=3) 3*unit else 8*unit},\"y\":${7*unit}")
            val journal=(1..6).map(::deploy)+listOf(
                event("pos",split,3,",\"x\":${5*unit},\"y\":${7*unit}"),
                event("pos",split,6,",\"x\":${10*unit},\"y\":${7*unit}"),
                event("troopDeath",dead,2),event("troopDeath",dead,5),event("star",end,0))
            fun scene(revision:String,events:List<PresentationEvent>,tick:Float)=BattleScene(BaseScene(emptyList(),14,12,tile),
                PresentationRevision("synthetic-live-stacks",revision,catalogue.getValue("simVersion").jsonPrimitive.int,0,0,events),
                mapOf("bowman" to authoredFrame,"highlander" to requireNotNull(fallbackFrame)),unit,tickMs,cadence,brood,playheadTick=tick,playing=false)
            val full=scene("complete",journal,settled.toFloat())
            val cases=listOf(
                Case("01-stacked-three",full,listOf(3,3)),
                Case("02-separated-two",full.copy(playheadTick=afterSplit.toFloat()),listOf(2,2)),
                Case("03-death-no-badges",full.copy(playheadTick=dead.toFloat()),emptyList()),
                Case("04-seek-back-three",full,listOf(3,3)),
                Case("05-revision-reused-ids-single",scene("singles",listOf(deploy(1),deploy(4),event("star",end,0)),settled.toFloat()),emptyList()),
                Case("06-empty-reset",scene("empty",listOf(event("star",end,0)),settled.toFloat()),emptyList()),
                Case("07-restored-three",full,listOf(3,3)))
            val expected=AtomicReference<Case?>(null)
            val matching=AtomicInteger();val lastFrame=AtomicReference<BattlePlaybackFrame?>(null)
            val gate=AtomicReference(CountDownLatch(1));val renderError=AtomicReference<String?>(null)
            val game=NativeGameRenderer(FileHandle(root),{},onError={renderError.compareAndSet(null,it)},catalogueTree={tree},onBattleFrame={ frame ->
                val want=expected.get()?.scene
                if(want!=null && frame.raidId==want.revision.raidId && frame.revision==want.revision.revision && frame.playheadTick==want.playheadTick) {
                    lastFrame.set(frame);if(matching.incrementAndGet()>=3)gate.get().countDown()
                } else matching.set(0)
            })
            stage="attach-test-only-gl-host";receipt("running")
            instrumentation.runOnMainSync { host.setContent { Box {} } }
            instrumentation.waitForIdleSync()
            val fragment=LiveTroopStacksTestFragment().apply { renderer=game }
            instrumentation.runOnMainSync {
                check(host.supportFragmentManager.fragments.isEmpty()) { "Offline preview fragment must detach before test GL mounts" }
                val container=FrameLayout(host).apply { id=View.generateViewId() }
                host.setContentView(container)
                host.supportFragmentManager.beginTransaction().add(container.id,fragment,"live-stacks-test-only").commitNow()
            }
            var previous:BattleScene?=null
            for(case in cases) {
                stage=case.name;receipt("running")
                val ready=CountDownLatch(1);gate.set(ready);matching.set(0);lastFrame.set(null);expected.set(case)
                val replace=previous?.revision!=case.scene.revision
                if(replace)game.updateBattle(case.scene) else game.setBattlePlayback(case.scene.playheadTick,1f,false)
                previous=case.scene
                check(ready.await(30,TimeUnit.SECONDS)) { "No stable complete GL frame: ${renderError.get()}" }
                check(renderError.get()==null) { requireNotNull(renderError.get()) }
                val copied=CountDownLatch(1);val result=AtomicInteger(-1);var bitmap:Bitmap?=null
                instrumentation.runOnMainSync {
                    Choreographer.getInstance().postFrameCallback { Choreographer.getInstance().postFrameCallback copy@{
                        if(matching.get()<3 || expected.get()!=case) { copied.countDown();return@copy }
                        val surface=surfaces(host.window.decorView).singleOrNull { it.isAttachedToWindow && it.width>0 && it.height>0 }
                        if(surface==null) { copied.countDown();return@copy }
                        try {
                            bitmap=Bitmap.createBitmap(surface.width,surface.height,Bitmap.Config.ARGB_8888)
                            PixelCopy.request(surface,requireNotNull(bitmap),{code->result.set(code);copied.countDown()},Handler(Looper.getMainLooper()))
                        } catch(_:Exception) { result.set(PixelCopy.ERROR_SOURCE_INVALID);copied.countDown() }
                    } }
                }
                check(copied.await(10,TimeUnit.SECONDS) && result.get()==PixelCopy.SUCCESS && matching.get()>=3)
                val image=requireNotNull(bitmap)
                try {
                    val frame=requireNotNull(lastFrame.get());val output=File(directory,"${case.name}.png")
                    check(frame.revision==case.scene.revision.revision && frame.playheadTick==case.scene.playheadTick)
                    check(!output.exists());output.outputStream().use { check(image.compress(Bitmap.CompressFormat.PNG,100,it)) }
                    files+=buildJsonObject {
                        put("path",output.name);put("sha256",sha(output));put("width",image.width);put("height",image.height)
                        put("tick",frame.playheadTick);put("revision",frame.revision);put("operation",if(replace) "replace-journal" else "seek-same-journal")
                        put("expectedBadgeCountsLeftAuthoredRightFallback",JsonArray(case.expectedCounts.map(::JsonPrimitive)))
                        put("expectedCountsArePixelMeasurement",false);put("matchingCompleteFrameCallbacks",matching.get())
                        put("pixelCopyResult",result.get());put("uiFrameBoundariesAfterMatch",2)
                        put("sourceEvents",JsonArray(case.scene.revision.events.map { Json.parseToJsonElement(it.json) }))
                    }
                } finally { image.recycle() }
            }
            check(files.size==7 && sha(File(root,"render-catalog.json"))==catalogueSha)
            stage="all-checkpoints-captured";receipt("captured-needs-visual-inspection")
        } catch(error:Exception) { failure=error.message;receipt("failed");throw error }
        finally { activity?.let { host -> instrumentation.runOnMainSync { host.finishAndRemoveTask() } };instrumentation.waitForIdleSync() }
    }
    private fun surfaces(view:View):List<SurfaceView> = when(view) {
        is SurfaceView->listOf(view)
        is ViewGroup->(0 until view.childCount).flatMap { surfaces(view.getChildAt(it)) }
        else->emptyList()
    }
}

/** Offline fixture injection is confined to the test APK, never production catalogue admission. */
class LiveTroopStacksTestFragment : AndroidFragmentApplication() {
    lateinit var renderer:NativeGameRenderer
    override fun onCreateView(inflater:LayoutInflater,container:ViewGroup?,state:Bundle?):View =
        initializeForView(renderer,AndroidApplicationConfiguration().apply {
            useAccelerometer=false;useCompass=false;useGyroscope=false;useImmersiveMode=false;numSamples=0
        }).also { surface -> surface.doOnAttach { mounted -> mounted.post {
            if(mounted.isAttachedToWindow && view===mounted)mounted.rootView.postInvalidateOnAnimation()
        } } }
}
