package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import kotlin.math.roundToInt
import android.os.*
import android.view.*
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.*
import gg.pixelkingdomwars.nativeclient.ui.PkwTheme
import kotlinx.serialization.json.*
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Actual production SceneSurface opening shell/GL reveal, using only the original verified bundle
 * and pinned Stage 100 geometry. No pause on Main/GL and no injected preparation delay. */
internal object SceneOpeningGlHarness {
    private fun hash(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun surfaces(v:View):List<SurfaceView> = when(v) {
        is SurfaceView->listOf(v)
        is ViewGroup->(0 until v.childCount).flatMap { surfaces(v.getChildAt(it)) }
        else->emptyList()
    }
    fun capture(i:Instrumentation, replay: Boolean = false):String {
        check(BuildConfig.DEBUG && BuildConfig.APPLICATION_ID=="gg.pixelkingdomwars.twa.debug" && Build.HARDWARE=="ranchu" && BuildConfig.API_ORIGIN=="https://127.0.0.1:18443")
        val context=i.targetContext;val directory=File(context.noBackupFilesDir,"scene-opening-gl/${System.currentTimeMillis()}");check(directory.mkdirs())
        val records=mutableListOf<JsonObject>();val last=AtomicReference<LocalSceneSnapshot?>()
        var activity:MainActivity?=null;var status="running";var error:String?=null
        var replayControls:JsonArray?=null
        val replayTransitions=mutableListOf<JsonObject>()
        fun receipt() { File(directory,"receipt.json").writeText(buildJsonObject {
            put("status",status);put("error",error?.let(::JsonPrimitive) ?: JsonNull);put("originalBundledArtOnly",true)
            put("networkRequests",0);put("accountAccessRequested",false);put("injectedDelay",false);put("physicalSeekerAcceptance",false)
            put("actualReplayScreen",replay);put("fixtureSimVersion",14)
            put("captures",JsonArray(records))
            replayControls?.let { put("replayControls",it) }
            put("replayTransitions",JsonArray(replayTransitions))
        }.toString()) }
        try {
            val manifest=context.assets.open("native/manifest.json").use { it.readBytes() }
            val assets=BundledContent.prepare(context.noBackupFilesDir,manifest,debug=true,verifier="scene-opening-${BuildConfig.VERSION_CODE}") { context.assets.open("native/$it") }
            fun read(name:String)=Json.parseToJsonElement(File(assets,name).readText()).jsonObject
            val bytes=i.context.assets.open("battle-reliability/stage100-dragons-90.json").use { it.readBytes() }
            val pins=Json.parseToJsonElement(i.context.assets.open("battle-reliability/provenance.json").bufferedReader().use { it.readText() }).jsonObject
            val pin=pins.getValue("fixtures").jsonArray.map { it.jsonObject }.single { it.getValue("path").jsonPrimitive.content=="stage100-dragons-90.json" }
            check(hash(bytes)==pin.getValue("sha256").jsonPrimitive.content && bytes.size==pin.getValue("bytes").jsonPrimitive.int)
            val fixture=Json.parseToJsonElement(bytes.decodeToString()).jsonObject
            val catalogue=read("catalogue.json");val renderCatalogue=read("render-catalog.json")
            val scene=SceneMapper(catalogue,renderCatalogue).replayScene(fixture).base
            check(scene.buildings.size==306)
            activity=i.startActivitySync(Intent(context,MainActivity::class.java).putExtra("preview","base").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            val host=activity
            i.runOnMainSync { host.setContent { Box {} } };i.waitForIdleSync()
            val observer=object:LocalSceneDiagnostics { override fun frameStarted() {};override fun frameCompleted() {};override fun state(snapshot:LocalSceneSnapshot) { last.set(snapshot) } }
            val started=System.nanoTime()
            i.runOnMainSync { host.setContent { PkwTheme { Surface { CompositionLocalProvider(LocalSceneObserver provides observer,
                gg.pixelkingdomwars.nativeclient.ui.nav.LocalBackRegistry provides androidx.compose.runtime.remember { gg.pixelkingdomwars.nativeclient.ui.nav.BackRegistry() }) {
                if (replay) gg.pixelkingdomwars.nativeclient.ui.battle.ReplayScreen(
                    gg.pixelkingdomwars.nativeclient.data.ContentState(assets,catalogue,renderCatalogue),fixture,onClose={})
                else SceneSurface(assets,scene,Modifier.fillMaxSize())
            } } } } }
            fun hasOpening():Boolean {
                i.uiAutomation.clearCache()
                fun visit(n:android.view.accessibility.AccessibilityNodeInfo?):Boolean {
                    if(n==null)return false
                    return n.isVisibleToUser && n.text?.toString() in setOf("Opening your kingdom…","Opening the replay…","Entering battle…") || (0 until n.childCount).any { visit(n.getChild(it)) }
                }
                return visit(i.uiAutomation.rootInActiveWindow)
            }
            fun save(name:String,bitmap:Bitmap,scope:String) {
                try {
                    val output=File(directory,name);output.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG,100,it)) }
                    records+=buildJsonObject {
                        put("path",name);put("sha256",hash(output.readBytes()));put("width",bitmap.width);put("height",bitmap.height);put("scope",scope)
                        put("elapsedMs",(System.nanoTime()-started)/1e6);put("rendererKind",last.get()?.kind?.name ?: "not-started")
                    };receipt()
                } finally { bitmap.recycle() }
            }
            var opening=false;var revealed=false
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(45)
            while(System.nanoTime()<deadline && !revealed) {
                val visible=hasOpening()
                if(visible && !opening) {
                    if (replay) {
                        fun labels(n:android.view.accessibility.AccessibilityNodeInfo?):List<String> = if(n==null)emptyList() else
                            listOfNotNull(n.text?.toString()?.takeIf { n.isVisibleToUser })+(0 until n.childCount).flatMap { labels(n.getChild(it)) }
                        check(labels(i.uiAutomation.rootInActiveWindow).none { it in setOf("PAUSE","RESULT","1X") }) {
                            "Replay gameplay controls cover the first-entry shell"
                        }
                    }
                    save("01-opening-compositor.png",requireNotNull(i.uiAutomation.takeScreenshot()),"Actual production loading overlay, system compositor")
                    opening=true
                }
                if(last.get()?.kind==(if(replay)LocalSceneKind.BATTLE else LocalSceneKind.BASE) && !visible) {
                    // Accessibility and renderer delivery can precede Compose's next draw. Observe
                    // natural UI frame commits; never invalidate or otherwise repair the test view.
                    repeat(3) { val frame=CountDownLatch(1)
                        i.runOnMainSync { Choreographer.getInstance().postFrameCallback { frame.countDown() } }
                        check(frame.await(12,TimeUnit.SECONDS))
                    }
                    val composite=requireNotNull(i.uiAutomation.takeScreenshot())
                    val terrainColours=(1..4).flatMap { y->(1..9).map { x->composite.getPixel(composite.width*x/10,composite.height*y/10) } }.toSet().size
                    if (terrainColours<=8) { composite.recycle();Thread.sleep(40);continue }
                    val compositeWidth=composite.width;val compositeHeight=composite.height
                    save("02-revealed-compositor.png",composite,"Actual production reveal, system compositor after UI frames")
                    if (replay) replayControls=verifiedReplayControls(i,host.resources.displayMetrics.density,compositeWidth,compositeHeight)
                    val surface=AtomicReference<SurfaceView>();i.runOnMainSync { surface.set(surfaces(host.window.decorView).single()) }
                    val bitmap=Bitmap.createBitmap(surface.get().width,surface.get().height,Bitmap.Config.ARGB_8888);var result=-1;val copied=CountDownLatch(1)
                    PixelCopy.request(surface.get(),bitmap,{ result=it;copied.countDown() },Handler(Looper.getMainLooper()))
                    check(copied.await(12,TimeUnit.SECONDS) && result==PixelCopy.SUCCESS)
                    save("03-revealed-gl.png",bitmap,"Actual production GL surface, independent PixelCopy")
                    revealed=true
                }
                Thread.sleep(20)
            }
            check(opening) { "No initial loading compositor frame was captured; this run cannot certify first paint" }
            check(revealed) { "The production loading overlay did not reveal the drawn scene" }
            if (replay) {
                val originalOrientation=host.requestedOrientation
                fun endedVisible():Boolean {
                    i.uiAutomation.clearCache()
                    fun visit(node:AccessibilityNodeInfo?):Boolean = node!=null &&
                        (node.isVisibleToUser && node.text?.toString()?.startsWith("REPLAY ENDED ·")==true ||
                            (0 until node.childCount).any { visit(node.getChild(it)) })
                    return visit(i.uiAutomation.rootInActiveWindow)
                }
                fun transition(name:String,landscape:Boolean) {
                    val until=System.nanoTime()+TimeUnit.SECONDS.toNanos(20)
                    while(System.nanoTime()<until) {
                        val size=host.resources.displayMetrics
                        if ((size.widthPixels>size.heightPixels)==landscape && endedVisible()) {
                            // Check the first observable new layout, without waiting for another
                            // size callback or suppressing a collision while measurements catch up.
                            val controls=verifiedReplayControls(i,size.density,size.widthPixels,size.heightPixels,ended=true)
                            val bitmap=requireNotNull(i.uiAutomation.takeScreenshot())
                            check((bitmap.width>bitmap.height)==landscape)
                            save(name,bitmap,"Actual replay after footer/viewport relayout, system compositor")
                            replayTransitions+=buildJsonObject { put("path",name);put("ended",true);put("landscape",landscape);put("controls",controls) }
                            receipt()
                            if(name.startsWith("05-") || name.startsWith("06-")) {
                                // Preserve the immediate compositor too: Android may still be
                                // animating a rotated surface after the actual layout is current.
                                repeat(45) {
                                    val frame=CountDownLatch(1)
                                    i.runOnMainSync { Choreographer.getInstance().postFrameCallback { frame.countDown() } }
                                    check(frame.await(12,TimeUnit.SECONDS))
                                }
                                val settled=requireNotNull(i.uiAutomation.takeScreenshot())
                                val settledControls=verifiedReplayControls(i,host.resources.displayMetrics.density,settled.width,settled.height,ended=true)
                                val settledName=name.replace(".png","-settled.png")
                                save(settledName,settled,"Actual replay after natural Android rotation animation frames")
                                replayTransitions+=buildJsonObject { put("path",settledName);put("ended",true);put("landscape",landscape);put("controls",settledControls) }
                                receipt()
                            }
                            return
                        }
                        Thread.sleep(10)
                    }
                    error("Replay transition did not expose the expected current layout")
                }
                try {
                    val result=requireNotNull(replayControls).map { it.jsonObject }.single { it.getValue("label").jsonPrimitive.content=="RESULT" }
                    val bounds=result.getValue("bounds").jsonArray.map { it.jsonPrimitive.int }
                    val x=(bounds[0]+bounds[2])/2f;val y=(bounds[1]+bounds[3])/2f;val now=SystemClock.uptimeMillis()
                    for(action in listOf(MotionEvent.ACTION_DOWN,MotionEvent.ACTION_UP)) {
                        val event=MotionEvent.obtain(now,SystemClock.uptimeMillis(),action,x,y,0)
                        try { check(i.uiAutomation.injectInputEvent(event,true)) } finally { event.recycle() }
                    }
                    transition("04-ended-portrait-compositor.png",landscape=false)
                    i.runOnMainSync { host.requestedOrientation=ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
                    transition("05-ended-landscape-compositor.png",landscape=true)
                    i.runOnMainSync { host.requestedOrientation=ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
                    transition("06-ended-portrait-return-compositor.png",landscape=false)
                } finally { i.runOnMainSync { host.requestedOrientation=originalOrientation } }
            }
            status="captured-needs-pixel-review";receipt();return directory.absolutePath
        } catch(failure:Throwable) { status="failed";error=failure.message;receipt();throw failure }
        finally { activity?.let { host->i.runOnMainSync { host.finishAndRemoveTask() } };i.waitForIdleSync() }
    }

    /** Observe actual clickable screen bounds, not the layout helper or nominal dp rectangles.
     * Only fixed control labels and the result-summary bounds are retained; no arbitrary text is exported. */
    private fun verifiedReplayControls(i:Instrumentation,density:Float,width:Int,height:Int,ended:Boolean=false):JsonArray {
        val camera=setOf("Zoom in","Zoom out","Fit battlefield")
        val footer=if(ended)setOf("↻ WATCH AGAIN","CLOSE") else setOf("PAUSE","↻ RESTART","RESULT")
        var summary:Rect?=null
        val targets=mutableMapOf<String,Pair<Rect,Boolean>>()
        fun visit(node:AccessibilityNodeInfo?,ancestor:Pair<Rect,Boolean>?=null) {
            if(node==null || !node.isVisibleToUser)return
            val rect=Rect();node.getBoundsInScreen(rect)
            val button=node.isClickable || node.className?.toString()=="android.widget.Button"
            val target=if(button)Rect(rect) to (node.isEnabled && node.isClickable) else ancestor
            val label=listOfNotNull(node.contentDescription?.toString(),node.text?.toString()).firstOrNull { it in camera || it in footer }
            if(label!=null && target!=null && (targets[label]?.first?.top ?: -1)<=target.first.top)targets[label]=target
            if(ended && node.text?.toString()?.startsWith("REPLAY ENDED ·")==true)summary=Rect(rect)
            for(index in 0 until node.childCount)visit(node.getChild(index),target)
        }
        i.uiAutomation.clearCache();visit(i.uiAutomation.rootInActiveWindow)
        check(targets.keys==camera+footer) { "Revealed replay must expose all camera and footer actions: missing ${(camera+footer)-targets.keys}" }
        val display=Rect(0,0,width,height);val minimum=(48*density).roundToInt()
        for((label,value) in targets) {
            val (bounds,enabled)=value
            check(enabled && display.contains(bounds) && bounds.width()>=minimum && bounds.height()>=minimum) {
                "Replay target $label must be fully visible, clickable and at least 48 dp"
            }
        }
        for(label in camera)for(other in targets.keys-label)check(!Rect.intersects(targets.getValue(label).first,targets.getValue(other).first)) {
            "Replay camera target $label intersects $other"
        }
        if(ended) {
            val resultSummary=requireNotNull(summary) { "Ended replay summary must be visible" }
            check(display.contains(resultSummary)) { "Ended replay summary must fit the current viewport" }
            for(label in camera)check(!Rect.intersects(targets.getValue(label).first,resultSummary)) {
                "Replay camera target $label intersects the result summary"
            }
        }
        return JsonArray(targets.toSortedMap().map { (label,value)->buildJsonObject {
            put("label",label);put("enabledClickable",value.second);put("density",density);put("minimumTargetPx",minimum)
            put("bounds",buildJsonArray { add(value.first.left);add(value.first.top);add(value.first.right);add(value.first.bottom) })
            put("camera",label in camera);put("nonIntersecting",true)
        } })
    }

}
