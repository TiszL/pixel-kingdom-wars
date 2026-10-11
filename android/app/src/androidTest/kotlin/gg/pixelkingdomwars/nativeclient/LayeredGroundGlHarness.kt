package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.os.*
import android.view.*
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.AbstractComposeView
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.model.PlotGeometry
import gg.pixelkingdomwars.nativeclient.scene.*
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.PkwTheme
import kotlinx.serialization.json.*
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs

/** Private hash-pinned fixture -> real BundledContent verification -> SceneHost
 * lease -> actual renderer/Android decoder. No catalogue or FileHandle bypass. */
internal object LayeredGroundGlHarness {
    private fun hash(b:ByteArray)=MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    private fun surfaces(v:View):List<SurfaceView> = when(v) {
        is SurfaceView->listOf(v)
        is ViewGroup->(0 until v.childCount).flatMap { surfaces(v.getChildAt(it)) }
        else->emptyList()
    }
    fun capture(i:Instrumentation, expectedManifest:String, orientation:String?, profile:String?=null):String {
        check(BuildConfig.DEBUG && BuildConfig.APPLICATION_ID=="gg.pixelkingdomwars.twa.debug" && Build.HARDWARE=="ranchu" && BuildConfig.API_ORIGIN=="https://127.0.0.1:18443")
        check(expectedManifest.matches(Regex("[a-f0-9]{64}")))
        require(profile==null || profile=="perimeter-full50")
        val perimeter=profile=="perimeter-full50"
        if(perimeter)require(orientation=="landscape")
        val context=i.targetContext;val source=File("/data/local/tmp/pkw-layered-ground-fixture")
        val directory=File(context.noBackupFilesDir,"layered-ground-gl/${System.currentTimeMillis()}");check(directory.mkdirs())
        val records=mutableListOf<JsonObject>();val frames=AtomicInteger();val last=AtomicReference<LocalSceneSnapshot?>()
        var activity:MainActivity?=null;var status="running";var error:String?=null
        var sceneLease:java.io.Closeable?=null
        fun receipt() { File(directory,"receipt.json").writeText(buildJsonObject {
            put("status",status);put("error",error?.let(::JsonPrimitive) ?: JsonNull);put("manifestSha256",expectedManifest)
            put("verifiedContentRoot",true);put("sceneHostLease",true);put("decoder","Android BitmapFactory off Main; straight RGBA")
            put("accountAccessRequested",false);put("networkRequests",0);put("physicalSeekerAcceptance",false);put("captures",JsonArray(records))
            put("profile",profile ?: "corrected-motion");put("nativeBuild",BuildConfig.VERSION_CODE)
        }.toString()) }
        fun <T> main(block:()->T):T { val value=AtomicReference<T>();i.runOnMainSync { value.set(block()) };return value.get() }
        fun await(label:String, condition:()->Boolean) {
            val end=System.nanoTime()+TimeUnit.SECONDS.toNanos(50)
            while(System.nanoTime()<end) { if(condition())return;Thread.sleep(25) };error("Timed out: $label")
        }
        try {
            val manifest=File(source,"manifest.json").readBytes();check(hash(manifest)==expectedManifest)
            val assets=BundledContent.prepare(context.noBackupFilesDir,manifest,debug=true,full=true,verifier="layered-gl-${BuildConfig.VERSION_CODE}") { p ->
                val privateFile=File(source,p);if(privateFile.isFile) privateFile.inputStream() else context.assets.open("native/$p")
            }
            sceneLease=BundledContent.acquire(assets);check(sceneLease!=null)
            fun read(name:String)=Json.parseToJsonElement(File(assets,name).readText()).jsonObject
            val catalogue=read("catalogue.json");val render=read("render-catalog.json")
            val bytes=i.context.assets.open("battle-reliability/stage100-dragons-90.json").use { it.readBytes() }
            val pins=Json.parseToJsonElement(i.context.assets.open("battle-reliability/provenance.json").bufferedReader().use { it.readText() }).jsonObject
            val pin=pins.getValue("fixtures").jsonArray.map { it.jsonObject }.single { it.getValue("path").jsonPrimitive.content=="stage100-dragons-90.json" }
            check(hash(bytes)==pin.getValue("sha256").jsonPrimitive.content && bytes.size==pin.getValue("bytes").jsonPrimitive.int)
            val snapshot=Json.parseToJsonElement(bytes.decodeToString()).jsonObject.getValue("snapshot").jsonObject
            val plot=if(perimeter)PlotGeometry.from(catalogue,2) else null
            val home=JsonObject(snapshot+mapOf("claim" to buildJsonObject {
                put("min",plot?.min?.let(::JsonPrimitive) ?: snapshot.getValue("claimMin"))
                put("max",plot?.max?.let(::JsonPrimitive) ?: snapshot.getValue("claimMax"))
            })+if(plot!=null)mapOf("plotVersion" to JsonPrimitive(plot.version)) else emptyMap())
            val mapped=SceneMapper(catalogue,render).baseScene(home)
            check(mapped.buildings.size==306)
            // Four copies of existing authored cannon seats expose every outer
            // buildable corner. These are fixture-only, never account mutations.
            val template=if(plot==null)mapped else {
                check(mapped.camera?.extendedPlot==true && mapped.columns==plot.size)
                val cannon=mapped.buildings.first { it.type=="cannon" }
                val xs=listOf(plot.min.toFloat(),plot.max-cannon.footprintWidth)
                val ys=listOf(plot.min.toFloat(),plot.max-cannon.footprintHeight)
                mapped.copy(buildings=mapped.buildings+xs.flatMapIndexed { x,tx -> ys.mapIndexed { y,ty ->
                    cannon.copy(id="perimeter-corner-$x-$y",tileX=tx,tileY=ty)
                } })
            }
            val descriptor=render.getValue("layeredGround").jsonObject.getValue("manifests").jsonArray.single().jsonObject
            val ground=LayeredRealmGround(com.badlogic.gdx.utils.JsonReader().parse(File(assets,descriptor.getValue("manifestPath").jsonPrimitive.content).readText()))
            val field=ground.floorBounds(template.tilePixels.toDouble())
            val scene=mutableStateOf(template.copy(baseId="layered-thornwake",visual=RealmVisual("thornwake",2,3)))
            val reduced=mutableStateOf(perimeter)
            val step=catalogue.getValue("constants").jsonObject.getValue("RAID_CAMERA").jsonObject.getValue("zoomStep").jsonPrimitive.float
            val controls=SceneCameraControls(step)
            activity=i.startActivitySync(Intent(context,MainActivity::class.java).putExtra("preview","base").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            val host=activity
            // Let the launched Activity commit its initial layout, then remove
            // its composition while still attached. The test mounts a fresh root
            // instead of swapping content during an in-flight initial measure.
            repeat(3) { val committed=CountDownLatch(1);main { Choreographer.getInstance().postFrameCallback { committed.countDown() } };check(committed.await(12,TimeUnit.SECONDS)) }
            main {
                val container=host.findViewById<ViewGroup>(android.R.id.content)
                (0 until container.childCount).map { container.getChildAt(it) }.filterIsInstance<AbstractComposeView>().forEach { it.disposeComposition() }
                container.removeAllViews()
            };i.waitForIdleSync()
            val observer=object:LocalSceneDiagnostics { override fun frameStarted() {};override fun frameCompleted() { frames.incrementAndGet() };override fun state(s:LocalSceneSnapshot) { last.set(s) } }
            main { host.setContent { PkwTheme { CompositionLocalProvider(LocalSceneObserver provides observer, LocalReducedMotion provides reduced.value) {
                SceneSurface(assets,scene.value,Modifier.fillMaxSize(),cameraControls=controls)
            } } } }
            fun settled(label:String) { val before=frames.get();await(label) { val s=last.get();s?.kind==LocalSceneKind.BASE && s.queueDepth==0 && s.pendingWallUploads==0 && frames.get()>before+8 } }
            fun capture(name:String) {
                val surface=main { surfaces(host.window.decorView).single() };val s=requireNotNull(last.get())
                val bitmap=Bitmap.createBitmap(surface.width,surface.height,Bitmap.Config.ARGB_8888);val latch=CountDownLatch(1);var code=-1
                PixelCopy.request(surface,bitmap,{code=it;latch.countDown()},Handler(Looper.getMainLooper()))
                check(latch.await(12,TimeUnit.SECONDS) && code==PixelCopy.SUCCESS)
                try {
                    check((1..8).flatMap { y->(1..8).map { x->bitmap.getPixel(bitmap.width*x/9,bitmap.height*y/9) } }.toSet().size>4)
                    val file=File(directory,"$name.png");file.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG,100,it)) }
                    records+=buildJsonObject { put("path",file.name);put("sha256",hash(file.readBytes()));put("width",bitmap.width);put("height",bitmap.height)
                        put("cameraX",s.cameraX);put("cameraY",s.cameraY);put("cameraZoom",s.cameraZoom);put("reducedMotion",reduced.value)
                        put("queueDepth",s.queueDepth);put("textureMiB",s.textureMiB);put("frames",frames.get());put("buildings",template.buildings.size)
                        put("claimMin",template.camera!!.claimMin);put("claimMax",template.camera!!.claimMax)
                        val left=s.cameraX-bitmap.width*s.cameraZoom/2;val top=s.cameraY-bitmap.height*s.cameraZoom/2
                        val right=s.cameraX+bitmap.width*s.cameraZoom/2;val bottom=s.cameraY+bitmap.height*s.cameraZoom/2
                        put("worldLeft",left);put("worldTop",top);put("worldRight",right);put("worldBottom",bottom)
                        put("outsideLeft",left<field.x);put("outsideRight",right>field.x+field.width)
                        put("outsideTop",top<field.y);put("outsideBottom",bottom>field.y+field.height) }
                } finally { bitmap.recycle() };receipt()
            }
            fun panTo(wx:Float,wy:Float) {
                repeat(32) {
                    val s=requireNotNull(last.get());val surface=main { surfaces(host.window.decorView).single() };val loc=IntArray(2);main { surface.getLocationOnScreen(loc) }
                    val dx=((s.cameraX-wx)/s.cameraZoom).toFloat().coerceIn(-surface.width*.35f,surface.width*.35f)
                    val dy=((s.cameraY-wy)/s.cameraZoom).toFloat().coerceIn(-surface.height*.3f,surface.height*.3f)
                    if(abs(dx)<3 && abs(dy)<3)return
                    val x=loc[0]+surface.width*.5f;val y=loc[1]+surface.height*.5f;val down=SystemClock.uptimeMillis()
                    fun event(a:Int,ex:Float,ey:Float) { val e=MotionEvent.obtain(down,SystemClock.uptimeMillis(),a,ex,ey,0);try { i.sendPointerSync(e) } finally { e.recycle() } }
                    event(MotionEvent.ACTION_DOWN,x,y);for(n in 1..8) {event(MotionEvent.ACTION_MOVE,x+dx*n/8,y+dy*n/8);Thread.sleep(16)}
                    event(MotionEvent.ACTION_UP,x+dx,y+dy);settled("pan")
                }
            }
            /** Backend D-185 (owner 2026-09-27, superseding D-183's claim + ring bound): the layered painting is the drawn world,
             *  so no view leaves it ([edge] must touch its side), and the zoom floor spans it on the constraining axis ([covers]).
             *  This harness mounts no HUD chrome or camera insets, so the whole surface is the pan rectangle. */
            fun inField(label:String,edge:String?=null,covers:Boolean=false) {
                val s=requireNotNull(last.get());val surface=main { surfaces(host.window.decorView).single() }
                val l=s.cameraX-surface.width*s.cameraZoom/2;val r=s.cameraX+surface.width*s.cameraZoom/2
                val t=s.cameraY-surface.height*s.cameraZoom/2;val b=s.cameraY+surface.height*s.cameraZoom/2
                check(l>=field.x-1 && r<=field.x+field.width+1 && t>=field.y-1 && b<=field.y+field.height+1) { "$label framed past the drawn world: $l,$t..$r,$b" }
                when(edge) { "north"->check(abs(t-field.y)<=1) { "$label: the north edge was not reached" }
                    "south"->check(abs(b-field.y-field.height)<=1) { "$label: the south edge was not reached" }
                    "west"->check(abs(l-field.x)<=1) { "$label: the west edge was not reached" }
                    "east"->check(abs(r-field.x-field.width)<=1) { "$label: the east edge was not reached" } }
                if(covers) check(if(surface.height>surface.width) abs(b-t-field.height)<=1 else abs(r-l-field.width)<=1) { "$label: the zoom floor does not span the drawn world" }
            }
            settled("accepted ground ready")
            for(profile in listOf("portrait","landscape").filter { orientation==null || orientation==it }) {
                main { host.requestedOrientation=if(profile=="portrait") ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
                await("physical orientation") { main { val b=host.windowManager.currentWindowMetrics.bounds;(b.height()>b.width())==(profile=="portrait") } }
                controls.fit();settled("orientation fit");capture("$profile-base")
                if(perimeter) {
                    val fit=requireNotNull(last.get())
                    // D-185: the 50x50 fit (its claim fit, clamped to the floor where that was wider than the painting) stays on the
                    // painting, and the perimeter pans reach each of its edges, never past.
                    inField("full50 fit")
                    panTo(fit.cameraX.toFloat(),field.y.toFloat());inField("perimeter-north","north");capture("perimeter-north")
                    panTo(fit.cameraX.toFloat(),(field.y+field.height).toFloat());inField("perimeter-south","south");capture("perimeter-south")
                    controls.fit();settled("return to full50 fit")
                    repeat(3) { controls.zoomIn() };settled("perimeter close view")
                    panTo((field.x-field.width).toFloat(),fit.cameraY.toFloat());inField("perimeter-west","west");capture("perimeter-west")
                    panTo((field.x+field.width*2).toFloat(),fit.cameraY.toFloat());inField("perimeter-east","east");capture("perimeter-east")
                    continue
                }
                repeat(12) { controls.zoomOut() };settled("zoom out");if(template.camera!=null) inField("$profile zoom floor",covers=true);capture("$profile-field")
                if(profile=="landscape") {
                    repeat(4) { controls.zoomIn() };settled("landmark zoom")
                    panTo((-34+1172f/1254*98)*template.tilePixels,(-34+100f/1254*98)*template.tilePixels)
                    capture("waterfall-a");Thread.sleep(450);capture("waterfall-b")
                    main { reduced.value=true };settled("reduced motion");capture("reduced-a");Thread.sleep(450);capture("reduced-b")
                    main { reduced.value=false };settled("resume motion")
                    // A missing accepted realm must fail preparation while retaining this scene.
                    main { scene.value=scene.value.copy(visual=RealmVisual("frostveil",2,3)) };settled("failed replacement retained")
                    capture("replacement-retained")
                    main { scene.value=scene.value.copy(visual=RealmVisual("thornwake",2,3)) };settled("valid replacement restored")
                }
            }
            check(hash(File(assets,"manifest.json").readBytes())==expectedManifest)
            status="captured-needs-pixel-review";receipt();return directory.absolutePath
        } catch(f:Throwable) {status="failed";error=f.message;receipt();throw f}
        finally { activity?.let { h->main { h.finishAndRemoveTask() } };i.waitForIdleSync();sceneLease?.close() }
    }
}
