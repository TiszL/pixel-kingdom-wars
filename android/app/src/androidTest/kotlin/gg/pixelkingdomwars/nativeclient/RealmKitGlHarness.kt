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

/** Revision-5 realm kit on the real GL surface (docs/REALM-KIT-PLAN.md §6 evidence): private hash-pinned
 * fixture pack -> real BundledContent verification -> SceneHost lease -> actual renderer/Android decoder.
 * Modelled on [LayeredGroundGlHarness]; no catalogue or FileHandle bypass, no account or network use.
 * Captures: fitted base (portrait + landscape), the zoom floor (tile LOD unless a still texel is 2 px or less; the record carries
 * the still/chunk/quad counts the renderer measured), the max zoom
 * over the kingdom ring, a water landmark pair 450 ms apart (tile animation), the reduced-motion pair
 * (must be byte-identical), and the expansion rings claim 14 / 26 / 50 from one scene. Under backend D-185 (owner 2026-09-27,
 * superseding D-183's claim + ring bound) the drawn kit field bounds the camera: the zoom floor is the field covering the
 * surface (checked below: never past it, spanning it on the constraining axis) and the landmark pan reaches water anywhere in
 * the field, so the water pair shows the water loop again and the reduced-motion pair covers kit water animation. */
internal object RealmKitGlHarness {
    const val MODE = "realm-kit-gl"
    private fun hash(b:ByteArray)=MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    private fun surfaces(v:View):List<SurfaceView> = when(v) {
        is SurfaceView->listOf(v)
        is ViewGroup->(0 until v.childCount).flatMap { surfaces(v.getChildAt(it)) }
        else->emptyList()
    }
    fun capture(i:Instrumentation, expectedManifest:String, orientation:String?, profile:String?=null):String {
        check(BuildConfig.DEBUG && BuildConfig.APPLICATION_ID=="gg.pixelkingdomwars.twa.debug" && Build.HARDWARE=="ranchu" && BuildConfig.API_ORIGIN=="https://127.0.0.1:18443")
        check(expectedManifest.matches(Regex("[a-f0-9]{64}")))
        require(profile==null || profile=="expansion-rings")
        val context=i.targetContext;val source=File("/data/local/tmp/pkw-realm-kit-fixture")
        val directory=File(context.noBackupFilesDir,"realm-kit-gl/${System.currentTimeMillis()}");check(directory.mkdirs())
        val records=mutableListOf<JsonObject>();val frames=AtomicInteger();val last=AtomicReference<LocalSceneSnapshot?>()
        var activity:MainActivity?=null;var status="running";var error:String?=null
        var sceneLease:java.io.Closeable?=null
        fun receipt() { File(directory,"receipt.json").writeText(buildJsonObject {
            put("status",status);put("error",error?.let(::JsonPrimitive) ?: JsonNull);put("manifestSha256",expectedManifest)
            put("verifiedContentRoot",true);put("sceneHostLease",true);put("decoder","Android BitmapFactory off Main; straight RGBA")
            put("accountAccessRequested",false);put("networkRequests",0);put("physicalSeekerAcceptance",false);put("captures",JsonArray(records))
            put("profile",profile ?: "kit-motion");put("groundRevision",5);put("nativeBuild",BuildConfig.VERSION_CODE)
        }.toString()) }
        fun <T> main(block:()->T):T { val value=AtomicReference<T>();i.runOnMainSync { value.set(block()) };return value.get() }
        fun await(label:String, condition:()->Boolean) {
            val end=System.nanoTime()+TimeUnit.SECONDS.toNanos(50)
            while(System.nanoTime()<end) { if(condition())return;Thread.sleep(25) };error("Timed out: $label")
        }
        try {
            val manifest=File(source,"manifest.json").readBytes();check(hash(manifest)==expectedManifest)
            val assets=BundledContent.prepare(context.noBackupFilesDir,manifest,debug=true,full=true,verifier="realm-kit-gl-${BuildConfig.VERSION_CODE}") { p ->
                val privateFile=File(source,p);if(privateFile.isFile) privateFile.inputStream() else context.assets.open("native/$p")
            }
            sceneLease=BundledContent.acquire(assets);check(sceneLease!=null)
            fun read(name:String)=Json.parseToJsonElement(File(assets,name).readText()).jsonObject
            val catalogue=read("catalogue.json");val render=read("render-catalog.json")
            check(render.getValue("rendererContractVersion").jsonPrimitive.int>=15) { "The fixture pack must be a contract-15 realm kit pack" }
            val bytes=i.context.assets.open("battle-reliability/stage100-dragons-90.json").use { it.readBytes() }
            val pins=Json.parseToJsonElement(i.context.assets.open("battle-reliability/provenance.json").bufferedReader().use { it.readText() }).jsonObject
            val pin=pins.getValue("fixtures").jsonArray.map { it.jsonObject }.single { it.getValue("path").jsonPrimitive.content=="stage100-dragons-90.json" }
            check(hash(bytes)==pin.getValue("sha256").jsonPrimitive.content && bytes.size==pin.getValue("bytes").jsonPrimitive.int)
            val snapshot=Json.parseToJsonElement(bytes.decodeToString()).jsonObject.getValue("snapshot").jsonObject
            val plot=PlotGeometry.from(catalogue,2)
            fun home(claimMin:Int,claimMax:Int)=JsonObject(snapshot+mapOf("claim" to buildJsonObject { put("min",claimMin);put("max",claimMax) },"plotVersion" to JsonPrimitive(plot.version)))
            val defaultMin=snapshot.getValue("claimMin").jsonPrimitive.int;val defaultMax=snapshot.getValue("claimMax").jsonPrimitive.int
            val mapped=SceneMapper(catalogue,render).baseScene(home(defaultMin,defaultMax))
            check(mapped.buildings.size==306 && mapped.camera?.extendedPlot==true)
            val descriptor=render.getValue("layeredGroundV5").jsonObject.getValue("manifests").jsonArray.single().jsonObject
            val realmId=descriptor.getValue("realmId").jsonPrimitive.content
            val rules=RealmKitRules.read(com.badlogic.gdx.utils.JsonReader().parse(File(assets,"catalogue.json").readText()).get("constants"))
            val manifestFile=File(assets,descriptor.getValue("manifestPath").jsonPrimitive.content).readBytes()
            val kit=RealmKitManifest(com.badlogic.gdx.utils.JsonReader().parse(manifestFile.decodeToString()),rules,setOf(realmId),manifestFile.size)
            val field=kit.floorBounds(mapped.tilePixels.toDouble())
            // Landmark: the first baked water tile (row-major), where the surface loop animates; else the field centre.
            val water=kit.grid(RealmKitLayerId.WATER)?.indexOfFirst { it!=0 }?.takeIf { it>=0 }
            val landmark=if(water==null) (rules.fieldOriginTiles+rules.fieldTiles/2).let { it to it } else (water%rules.fieldTiles+rules.fieldOriginTiles) to (water/rules.fieldTiles+rules.fieldOriginTiles)
            val scene=mutableStateOf(mapped.copy(baseId="realm-kit-$realmId",visual=RealmVisual(realmId,2,5)))
            val reduced=mutableStateOf(false)
            val step=catalogue.getValue("constants").jsonObject.getValue("RAID_CAMERA").jsonObject.getValue("zoomStep").jsonPrimitive.float
            val controls=SceneCameraControls(step)
            activity=i.startActivitySync(Intent(context,MainActivity::class.java).putExtra("preview","base").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            val host=activity
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
            fun capture(name:String):String {
                val surface=main { surfaces(host.window.decorView).single() };val s=requireNotNull(last.get())
                val bitmap=Bitmap.createBitmap(surface.width,surface.height,Bitmap.Config.ARGB_8888);val latch=CountDownLatch(1);var code=-1
                PixelCopy.request(surface,bitmap,{code=it;latch.countDown()},Handler(Looper.getMainLooper()))
                check(latch.await(12,TimeUnit.SECONDS) && code==PixelCopy.SUCCESS)
                try {
                    check((1..8).flatMap { y->(1..8).map { x->bitmap.getPixel(bitmap.width*x/9,bitmap.height*y/9) } }.toSet().size>4)
                    val file=File(directory,"$name.png");file.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG,100,it)) }
                    val digest=hash(file.readBytes())
                    val claim=scene.value.camera!!
                    records+=buildJsonObject { put("path",file.name);put("sha256",digest);put("width",bitmap.width);put("height",bitmap.height)
                        put("cameraX",s.cameraX);put("cameraY",s.cameraY);put("cameraZoom",s.cameraZoom);put("reducedMotion",reduced.value)
                        put("queueDepth",s.queueDepth);put("textureMiB",s.textureMiB);put("frames",frames.get());put("buildings",scene.value.buildings.size)
                        put("claimMin",claim.claimMin);put("claimMax",claim.claimMax)
                        put("overviewLod",s.realmKitStillDraws>0);put("realmKitChunkDraws",s.realmKitChunkDraws);put("realmKitTileQuads",s.realmKitTileQuads) // measured by the renderer last frame
                        val left=s.cameraX-bitmap.width*s.cameraZoom/2;val top=s.cameraY-bitmap.height*s.cameraZoom/2
                        val right=s.cameraX+bitmap.width*s.cameraZoom/2;val bottom=s.cameraY+bitmap.height*s.cameraZoom/2
                        put("worldLeft",left);put("worldTop",top);put("worldRight",right);put("worldBottom",bottom)
                        put("outsideLeft",left<field.x);put("outsideRight",right>field.x+field.width)
                        put("outsideTop",top<field.y);put("outsideBottom",bottom>field.y+field.height) }
                    return digest
                } finally { bitmap.recycle();receipt() }
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
            settled("realm kit ready")
            if(profile=="expansion-rings") {
                main { host.requestedOrientation=ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
                await("physical orientation") { main { val b=host.windowManager.currentWindowMetrics.bounds;b.width()>b.height() } }
                for((min,max) in listOf(defaultMin to defaultMax, 2 to 28, plot.min to plot.max)) {
                    main { scene.value=SceneMapper(catalogue,render).baseScene(home(min,max)).copy(baseId="realm-kit-$realmId",visual=RealmVisual(realmId,2,5)) }
                    settled("claim $min..$max");controls.fit();settled("ring fit");capture("ring-$min-$max")
                    repeat(3) { controls.zoomIn() };settled("ring corner zoom");panTo((min-1)*mapped.tilePixels,(min-1)*mapped.tilePixels);capture("ring-$min-$max-corner")
                }
                check(hash(File(assets,"manifest.json").readBytes())==expectedManifest)
                status="captured-needs-pixel-review";receipt();return directory.absolutePath
            }
            for(orient in listOf("portrait","landscape").filter { orientation==null || orientation==it }) {
                main { host.requestedOrientation=if(orient=="portrait") ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
                await("physical orientation") { main { val b=host.windowManager.currentWindowMetrics.bounds;(b.height()>b.width())==(orient=="portrait") } }
                controls.fit();settled("orientation fit");capture("$orient-base")
                repeat(12) { controls.zoomOut() };settled("zoom floor");capture("$orient-floor") // tile LOD expected unless a still texel is 2 px or less (RealmKitManifest.drawsOverview)
                requireNotNull(last.get()).let { s -> val surface=main { surfaces(host.window.decorView).single() }
                    val vw=surface.width*s.cameraZoom;val vh=surface.height*s.cameraZoom
                    // D-185: no HUD chrome here, so the whole surface stays on the kit field and spans it on the constraining axis.
                    check(s.cameraX-vw/2>=field.x-1 && s.cameraX+vw/2<=field.x+field.width+1 && s.cameraY-vh/2>=field.y-1 && s.cameraY+vh/2<=field.y+field.height+1) { "$orient zoom floor framed past the kit field" }
                    check(if(surface.height>surface.width) abs(vh-field.height)<=1 else abs(vw-field.width)<=1) { "$orient zoom floor does not show the whole kit field" } }
                if(orient=="landscape") {
                    repeat(8) { controls.zoomIn() };settled("kingdom ring zoom")
                    panTo((defaultMin-1)*mapped.tilePixels,(defaultMin-1)*mapped.tilePixels);capture("ring-corner-max")
                    repeat(4) { controls.zoomOut() };settled("landmark zoom")
                    // D-185: the pan keeps the view on the kit field, so it reaches the landmark water (or stops at the field edge
                    // nearest it).
                    panTo(landmark.first*mapped.tilePixels,landmark.second*mapped.tilePixels)
                    capture("water-a");Thread.sleep(450);capture("water-b")
                    main { reduced.value=true };settled("reduced motion")
                    val a=capture("reduced-a");Thread.sleep(450);val b=capture("reduced-b")
                    check(a==b) { "Reduced motion must be byte-identical across time" }
                    main { reduced.value=false };settled("resume motion")
                    // A missing accepted realm must fail preparation while retaining this scene.
                    val other=setOf("frostveil","elderwood","sunscar","crownlands","seeker-reach","stormcairn","thornwake","cinderfall").first { it!=realmId }
                    main { scene.value=scene.value.copy(visual=RealmVisual(other,2,5)) };settled("failed replacement retained")
                    capture("replacement-retained")
                    main { scene.value=scene.value.copy(visual=RealmVisual(realmId,2,5)) };settled("valid replacement restored")
                }
            }
            check(hash(File(assets,"manifest.json").readBytes())==expectedManifest)
            status="captured-needs-pixel-review";receipt();return directory.absolutePath
        } catch(f:Throwable) {status="failed";error=f.message;receipt();throw f}
        finally { activity?.let { h->main { h.finishAndRemoveTask() } };i.waitForIdleSync();sceneLease?.close() }
    }
}
