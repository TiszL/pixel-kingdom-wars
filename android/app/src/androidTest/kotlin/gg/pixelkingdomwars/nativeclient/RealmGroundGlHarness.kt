package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.os.*
import android.view.*
import android.widget.FrameLayout
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.core.view.doOnAttach
import com.badlogic.gdx.Gdx
import com.badlogic.gdx.backends.android.AndroidApplicationConfiguration
import com.badlogic.gdx.backends.android.AndroidFragmentApplication
import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.SceneMapper
import kotlinx.serialization.json.*
import java.io.File
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.*

/** Test APK only. Generated candidate ground is pinned by the launch argument and each ordinary
 * renderer digest check. Actor files remain the verified installed bundle. No pack publication,
 * account graph, network, gameplay mutation, release-package change, or device FPS claim. */
internal object RealmGroundGlHarness {
    private fun hash(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun <T> main(block:()->T):T {
        val done=CountDownLatch(1);val result=AtomicReference<Result<T>>()
        Handler(Looper.getMainLooper()).post { result.set(runCatching(block));done.countDown() }
        check(done.await(12,TimeUnit.SECONDS)) { "Main did not finish the fixture operation" };return result.get().getOrThrow()
    }
    private fun await(label:String,seconds:Long=45,predicate:()->Boolean) {
        val until=System.nanoTime()+TimeUnit.SECONDS.toNanos(seconds)
        while(System.nanoTime()<until) { if(predicate())return;Thread.sleep(40) };error("Timed out: $label")
    }
    private fun surfaces(v:View):List<SurfaceView> = when(v) {
        is SurfaceView->listOf(v)
        is ViewGroup->(0 until v.childCount).flatMap { surfaces(v.getChildAt(it)) }
        else->emptyList()
    }
    fun capture(i:Instrumentation,fixtureSha256:String,orientation:String?):String {
        check(BuildConfig.DEBUG && BuildConfig.APPLICATION_ID=="gg.pixelkingdomwars.twa.debug" && Build.HARDWARE=="ranchu")
        check(BuildConfig.API_ORIGIN=="https://127.0.0.1:18443")
        require(fixtureSha256.matches(Regex("[a-f0-9]{64}")))
        require(orientation==null || orientation in setOf("portrait","landscape"))
        val context=i.targetContext
        val candidateRoot=File(context.noBackupFilesDir,"realm-ground-candidate")
        val candidateBytes=File(candidateRoot,"candidate.json").readBytes();check(hash(candidateBytes)==fixtureSha256)
        val candidate=Json.parseToJsonElement(candidateBytes.decodeToString()).jsonObject
        check(candidate.getValue("kind").jsonPrimitive.content=="private-candidate-ground-r2" && !candidate.getValue("productionAdmission").jsonPrimitive.boolean)
        val ground=candidate.getValue("ground").jsonObject
        val rules=GroundPresentation(JsonReader().parse(ground.toString()))
        val allowed=candidate.getValue("files").jsonArray.associate { row ->
            val entry=row.jsonObject;val path=entry.getValue("path").jsonPrimitive.content
            check(path.matches(Regex("atlas/fantasy/ground-v4/[a-z-]+\\.png")))
            val file=File(candidateRoot,path);check(file.canonicalPath.startsWith(candidateRoot.canonicalPath+"/"))
            val bytes=file.readBytes();check(bytes.size.toLong()==entry.getValue("size").jsonPrimitive.long && hash(bytes)==entry.getValue("sha256").jsonPrimitive.content)
            path to file
        }
        check(allowed.size==rules.realms.size && rules.realms.all { realm ->
            val visual=RealmVisual(realm,2,2);val source=rules.sourceFor(visual)
            rules.resolve(visual)==visual && source.path in allowed && hash(allowed.getValue(source.path).readBytes())==source.sha256
        })
        val directory=File(context.noBackupFilesDir,"realm-ground-gl/${System.currentTimeMillis()}");check(directory.mkdirs())
        File(directory,"candidate.json").writeBytes(candidateBytes)
        val events=Collections.synchronizedList(mutableListOf<JsonObject>())
        val last=AtomicReference<LocalSceneSnapshot?>();val completed=AtomicLong();val failure=AtomicReference<String?>()
        val diagnostics=Collections.synchronizedList(mutableListOf<String>())
        var host:MainActivity?=null;var stage="prepare";var status="running";var realm="";var profile=""
        var currentScene:BaseScene?=null;var reduced=false
        var coreSha="";var originalRenderSha="";var fixturePin=""
        fun note(kind:String,body:JsonObject) { events+=buildJsonObject { put("kind",kind);put("realm",realm);put("profile",profile);put("stage",stage);body.forEach { (key,value)->put(key,value) } } }
        fun receipt() { File(directory,"receipt.json").writeText(buildJsonObject {
            put("status",status);put("stage",stage);put("failure",failure.get()?.let(::JsonPrimitive) ?: JsonNull)
            put("candidateSha256",fixtureSha256);put("bundledManifestSha256",coreSha);put("originalRenderCatalogueSha256",originalRenderSha)
            put("stage100FixtureSha256",fixturePin);put("buildings",currentScene?.buildings?.size ?: 0)
            put("runtimePackage",context.packageName);put("runtimeVersionCode",BuildConfig.VERSION_CODE)
            put("candidateDiagnosticCatalogue",true);put("productionContentAdmission",false);put("accountAccessRequested",false);put("networkRequests",0)
            put("scope","Real native renderer with canonical Stage 100 buildings and source-generated r2 ground; natural physical portrait/landscape surface, camera fit/zoom/pan and reduced motion. No production HUD or physical Seeker/FPS acceptance.")
            put("diagnostics",JsonArray(synchronized(diagnostics) { diagnostics.map(::JsonPrimitive) }));put("events",JsonArray(synchronized(events) { events.toList() }))
        }.toString()) }
        try {
            val manifest=context.assets.open("native/manifest.json").use { it.readBytes() };coreSha=hash(manifest)
            val assets=BundledContent.prepare(context.noBackupFilesDir,manifest,debug=true,verifier="realm-candidate-${BuildConfig.VERSION_CODE}") { context.assets.open("native/$it") }
            val renderBytes=File(assets,"render-catalog.json").readBytes();originalRenderSha=hash(renderBytes)
            val render=Json.parseToJsonElement(renderBytes.decodeToString()).jsonObject
            val catalogue=Json.parseToJsonElement(File(assets,"catalogue.json").readText()).jsonObject
            val privateRender=JsonObject(render+mapOf("ground" to ground))
            val provenanceBytes=i.context.assets.open("battle-reliability/provenance.json").use { it.readBytes() }
            val provenance=Json.parseToJsonElement(provenanceBytes.decodeToString()).jsonObject
            val pin=provenance.getValue("fixtures").jsonArray.map { it.jsonObject }.single { it.getValue("path").jsonPrimitive.content=="stage100-dragons-90.json" }
            val fixtureBytes=i.context.assets.open("battle-reliability/stage100-dragons-90.json").use { it.readBytes() }
            fixturePin=hash(fixtureBytes);check(fixturePin==pin.getValue("sha256").jsonPrimitive.content && fixtureBytes.size==pin.getValue("bytes").jsonPrimitive.int)
            File(directory,"provenance.json").writeBytes(provenanceBytes)
            val fixture=Json.parseToJsonElement(fixtureBytes.decodeToString()).jsonObject
            val snapshot=fixture.getValue("snapshot").jsonObject
            // Canonical snapshot bounds become the mapper's existing home-camera contract. The
            // candidate changes only visual context, never building coordinates or footprints.
            val homeSnapshot=JsonObject(snapshot+mapOf("claim" to buildJsonObject { put("min",snapshot.getValue("claimMin"));put("max",snapshot.getValue("claimMax")) }))
            val template=SceneMapper(catalogue,privateRender).baseScene(homeSnapshot)
            check(template.buildings.size==306 && template.camera!=null)
            val root=object:FileHandle(assets) {
                override fun child(name:String):FileHandle=allowed[name]?.let(::FileHandle) ?: super.child(name)
            }
            val observer=object:LocalSceneDiagnostics {
                override fun frameStarted() {}
                override fun frameCompleted() { completed.incrementAndGet() }
                override fun state(snapshot:LocalSceneSnapshot) { last.set(snapshot) }
            }
            val game=NativeGameRenderer(root,{},onError={failure.compareAndSet(null,it)},catalogueTree={JsonReader().parse(privateRender.toString())},
                onDiagnostic={ synchronized(diagnostics) { if(it !in diagnostics && diagnostics.size<100)diagnostics+=it } },localDiagnostics=observer)
            val zoomStep=catalogue.getValue("constants").jsonObject.getValue("RAID_CAMERA").jsonObject.getValue("zoomStep").jsonPrimitive.float
            val controls=SceneCameraControls(zoomStep);game.setCameraControls(controls)
            stage="launch-offline-preview";receipt()
            host=i.startActivitySync(Intent(context,MainActivity::class.java).putExtra("preview","base").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            val activity=host
            main { activity.setContent { Box {} } };i.waitForIdleSync()
            main {
                check(activity.supportFragmentManager.fragments.isEmpty())
                val container=FrameLayout(activity).apply { id=View.generateViewId() };activity.setContentView(container)
                activity.supportFragmentManager.beginTransaction().add(container.id,RealmGroundTestFragment().apply { renderer=game },"realm-ground-candidate").commitNow()
            }
            fun settled(label:String) {
                val before=completed.get()
                await(label) { failure.get()?.let { error(it) };last.get()?.let { it.kind==LocalSceneKind.BASE && it.queueDepth==0 && it.pendingWallUploads==0 && completed.get()>before+3 }==true }
                check(diagnostics.none { it.contains("ground ") && (it.contains("legacy") || it.contains("integrity")) }) { "Candidate ground fallback: $diagnostics" }
            }
            fun capture(name:String) {
                stage=name;settled(name)
                val boundary=CountDownLatch(1);Gdx.app.postRunnable { boundary.countDown() };check(boundary.await(12,TimeUnit.SECONDS))
                val surface=main { surfaces(activity.window.decorView).single().also { activity.window.decorView.postInvalidateOnAnimation() } }
                val frame=CountDownLatch(1);main { Choreographer.getInstance().postFrameCallback { frame.countDown() } };check(frame.await(12,TimeUnit.SECONDS))
                val state=requireNotNull(last.get());val scene=requireNotNull(currentScene)
                val physical=main { activity.windowManager.currentWindowMetrics.bounds }
                check(state.viewportWidth==surface.width && state.viewportHeight==surface.height && surface.width==physical.width() && surface.height==physical.height()) { "Scene does not fill physical window" }
                val copy=Bitmap.createBitmap(surface.width,surface.height,Bitmap.Config.ARGB_8888)
                val copied=CountDownLatch(1);var code=-1
                PixelCopy.request(surface,copy,{ code=it;copied.countDown() },Handler(Looper.getMainLooper()))
                check(copied.await(12,TimeUnit.SECONDS) && code==PixelCopy.SUCCESS)
                val system=i.uiAutomation.takeScreenshot() ?: error("Compositor capture unavailable")
                try {
                    for((kind,image) in listOf("gl" to copy,"compositor" to system)) {
                        check((1..15).flatMap { y->(1..15).map { x->image.getPixel(image.width*x/16,image.height*y/16) } }.toSet().size>4) { "$kind capture is blank" }
                        val file=File(directory,"$profile-$realm-$name-$kind.png");check(!file.exists())
                        file.outputStream().use { check(image.compress(Bitmap.CompressFormat.PNG,100,it)) }
                        note("capture",buildJsonObject {
                            put("path",file.name);put("sha256",hash(file.readBytes()));put("width",image.width);put("height",image.height);put("scope",kind)
                            put("reducedMotion",reduced);put("cameraX",state.cameraX);put("cameraY",state.cameraY);put("cameraZoom",state.cameraZoom)
                            put("tilePixels",scene.tilePixels);put("baseColumns",scene.columns);put("baseRows",scene.rows)
                            put("viewportWidth",state.viewportWidth);put("viewportHeight",state.viewportHeight);put("fullPhysicalWindow",true)
                            put("queueDepth",state.queueDepth);put("pendingWallUploads",state.pendingWallUploads);put("completedFrames",completed.get())
                        })
                    }
                } finally { copy.recycle();system.recycle() };receipt()
            }
            fun panTo(worldX:Float,worldY:Float) {
                repeat(6) {
                    val state=requireNotNull(last.get());val surface=main { surfaces(activity.window.decorView).single() }
                    val location=IntArray(2);main { surface.getLocationOnScreen(location) }
                    val dx=((state.cameraX-worldX)/state.cameraZoom).toFloat().coerceIn(-surface.width*.36f,surface.width*.36f)
                    val dy=((state.cameraY-worldY)/state.cameraZoom).toFloat().coerceIn(-surface.height*.32f,surface.height*.32f)
                    if(abs(dx)<3 && abs(dy)<3)return
                    val x=location[0]+surface.width*.5f;val y=location[1]+surface.height*.5f;val down=SystemClock.uptimeMillis()
                    fun event(action:Int,ex:Float,ey:Float) { MotionEvent.obtain(down,SystemClock.uptimeMillis(),action,ex,ey,0).also { e->try { i.sendPointerSync(e) } finally { e.recycle() } } }
                    event(MotionEvent.ACTION_DOWN,x,y)
                    for(step in 1..8) { event(MotionEvent.ACTION_MOVE,x+dx*step/8,y+dy*step/8);Thread.sleep(20) }
                    event(MotionEvent.ACTION_UP,x+dx,y+dy);settled("camera pan")
                }
            }
            for(p in listOf("portrait","landscape").filter { orientation==null || orientation==it }) {
                profile=p;stage="rotate"
                main { activity.requestedOrientation=if(p=="portrait") ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
                await("$p physical viewport") { main { val bounds=activity.windowManager.currentWindowMetrics.bounds;(bounds.height()>bounds.width())==(p=="portrait") } }
                for(id in rules.realms) {
                    realm=id;reduced=false;game.setReducedMotion(false)
                    currentScene=template.copy(baseId="diagnostic-$id",visual=RealmVisual(id,2,2));game.updateBase(requireNotNull(currentScene))
                    settled("$id candidate ready");controls.fit();settled("$id fitted")
                    capture("fit-a");Thread.sleep(720);capture("fit-b")
                    if(p=="landscape") {
                        repeat(2) { controls.zoomIn() };settled("representative zoom");capture("buildings-zoom")
                        val art=rules.artFor(RealmVisual(id,2,2))
                        val feature=requireNotNull(art.features).filter { it.kind !in setOf("dust","foliage") }.minByOrNull { val cx=art.sourceSize/2f;abs(it.x-cx)+abs(it.y-cx) } ?: requireNotNull(art.features).first()
                        val tile=template.tilePixels
                        val x=(art.worldOriginTiles+feature.x.toFloat()/art.sourceSize*art.worldTiles)*tile
                        val y=(art.worldOriginTiles+feature.y.toFloat()/art.sourceSize*art.worldTiles)*tile
                        note("landmark-seat",buildJsonObject { put("kind",feature.kind);put("sourceX",feature.x);put("sourceY",feature.y);put("worldX",x);put("worldY",y) })
                        panTo(x,y);capture("landmark-a");Thread.sleep(720);capture("landmark-b")
                        reduced=true;game.setReducedMotion(true);settled("reduced motion");capture("reduced-a");Thread.sleep(720);capture("reduced-b")
                        reduced=false;game.setReducedMotion(false)
                        val bounds=baseWorldBounds(template.columns,template.rows,tile,requireNotNull(template.camera).skirtTiles)
                        panTo((bounds.left+bounds.right)/2,bounds.bottom);capture("bottom-edge")
                    }
                }
            }
            check(hash(File(assets,"render-catalog.json").readBytes())==originalRenderSha)
            check(hash(File(candidateRoot,"candidate.json").readBytes())==fixtureSha256)
            status="captured-needs-pixel-review";stage="complete";receipt();return directory.absolutePath
        } catch(error:Throwable) { status="failed";failure.compareAndSet(null,error.message ?: error.javaClass.simpleName);receipt();throw error }
        finally { host?.let { main { it.finishAndRemoveTask() } };i.waitForIdleSync() }
    }
}

class RealmGroundTestFragment:AndroidFragmentApplication() {
    lateinit var renderer:NativeGameRenderer
    override fun onCreateView(inflater:LayoutInflater,container:ViewGroup?,state:Bundle?):View=initializeForView(renderer,
        AndroidApplicationConfiguration().apply { useAccelerometer=false;useCompass=false;useGyroscope=false;useImmersiveMode=false;numSamples=0 }).also { surface ->
        surface.doOnAttach { mounted->mounted.post { if(mounted.isAttachedToWindow)mounted.rootView.postInvalidateOnAnimation() } }
    }
}
