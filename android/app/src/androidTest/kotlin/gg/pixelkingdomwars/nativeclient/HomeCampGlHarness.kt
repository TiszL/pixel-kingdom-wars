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

/** Explicit offline server-response fixtures -> real mapper -> verified SceneHost -> real GL.
 * The source army row is authoritative for this test; no training, casualty, or count is inferred. */
internal object HomeCampGlHarness {
    private fun hash(b:ByteArray)=MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    private fun surfaces(v:View):List<SurfaceView> = when(v) {
        is SurfaceView->listOf(v)
        is ViewGroup->(0 until v.childCount).flatMap { surfaces(v.getChildAt(it)) }
        else->emptyList()
    }
    fun capture(i:Instrumentation, expectedManifest:String):String {
        check(BuildConfig.DEBUG && BuildConfig.APPLICATION_ID=="gg.pixelkingdomwars.twa.debug" && Build.HARDWARE=="ranchu" && BuildConfig.API_ORIGIN=="https://127.0.0.1:18443")
        check(expectedManifest.matches(Regex("[a-f0-9]{64}")))
        val context=i.targetContext;val source=File("/data/local/tmp/pkw-camp-fixture")
        val directory=File(context.noBackupFilesDir,"home-camp-gl/${System.currentTimeMillis()}");check(directory.mkdirs())
        val records=mutableListOf<JsonObject>();val frames=AtomicInteger();val last=AtomicReference<LocalSceneSnapshot?>()
        var activity:MainActivity?=null;var status="running";var error:String?=null
        var sceneLease:java.io.Closeable?=null
        fun receipt() { File(directory,"receipt.json").writeText(buildJsonObject {
            put("status",status);put("error",error?.let(::JsonPrimitive) ?: JsonNull);put("manifestSha256",expectedManifest)
            put("verifiedContentRoot",true);put("sceneHostLease",true);put("networkRequests",0);put("accountActions",0)
            put("physicalSeekerAcceptance",false);put("captures",JsonArray(records))
        }.toString()) }
        fun <T> main(block:()->T):T { val value=AtomicReference<T>();i.runOnMainSync { value.set(block()) };return value.get() }
        fun await(label:String, condition:()->Boolean) {
            val end=System.nanoTime()+TimeUnit.SECONDS.toNanos(40)
            while(System.nanoTime()<end) { if(condition())return;Thread.sleep(25) };error("Timed out: $label")
        }
        try {
            val manifest=File(source,"manifest.json").readBytes();check(hash(manifest)==expectedManifest)
            val assets=BundledContent.prepare(context.noBackupFilesDir,manifest,debug=true,full=true,verifier="camp-gl-${BuildConfig.VERSION_CODE}") { p ->
                val privateFile=File(source,p);if(privateFile.isFile) privateFile.inputStream() else context.assets.open("native/$p")
            }
            sceneLease=BundledContent.acquire(assets);check(sceneLease!=null)
            fun read(name:String)=Json.parseToJsonElement(File(assets,name).readText()).jsonObject
            val catalogue=read("catalogue.json");val render=read("render-catalog.json")
            check(render.getValue("campPresentation").jsonObject.getValue("actors").jsonObject.size==6)
            val bytes=i.context.assets.open("battle-reliability/stage100-dragons-90.json").use { it.readBytes() }
            val pins=Json.parseToJsonElement(i.context.assets.open("battle-reliability/provenance.json").bufferedReader().use { it.readText() }).jsonObject
            val pin=pins.getValue("fixtures").jsonArray.map { it.jsonObject }.single { it.getValue("path").jsonPrimitive.content=="stage100-dragons-90.json" }
            check(hash(bytes)==pin.getValue("sha256").jsonPrimitive.content && bytes.size==pin.getValue("bytes").jsonPrimitive.int)
            val snapshot=Json.parseToJsonElement(bytes.decodeToString()).jsonObject.getValue("snapshot").jsonObject
            val mapper=SceneMapper(catalogue,render)
            val types=listOf("bowman","dragon","giant","gloamfang","tunneler","direwyvern")
            // Canonical dense Stage100 home buildings stay intact; ready army comes from
            // the fixture response, separately from the training queue below.
            fun home(counts:List<Pair<String,Int>>, training:Boolean=false, refresh:Int=0)=JsonObject(snapshot+buildJsonObject {
                put("baseId","camp-fixture");put("player",buildJsonObject {put("keepLevel",20-refresh%2)})
                put("claim",buildJsonObject {put("min",snapshot.getValue("claimMin"));put("max",snapshot.getValue("claimMax"))})
                put("army",buildJsonArray {for((type,count) in counts) add(buildJsonObject {put("troop",type);put("level",20);put("count",count)})})
                put("armyStatus",buildJsonObject {put("readyTroopCount",counts.sumOf {it.second});put("trainingTroopCount",if(training)24 else 0);if(training)put("nextReadyAt","2099-01-01T00:00:00Z")})
            })
            val initial=gg.pixelkingdomwars.nativeclient.model.BaseSnapshot.from(home(emptyList(),true))
            check(initial.armyStatus?.trainingTroopCount==24 && initial.armyStatus?.readyTroopCount==0)
            val scene=mutableStateOf(mapper.baseScene(initial.raw))
            check(scene.value.buildings.size==306);check(scene.value.campTroops.isEmpty())
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
            val observer=object:LocalSceneDiagnostics { override val observeCampFrames=true;override fun frameStarted() {};override fun frameCompleted() { frames.incrementAndGet() };override fun state(s:LocalSceneSnapshot) { last.set(s) } }
            main { host.setContent { PkwTheme { CompositionLocalProvider(LocalSceneObserver provides observer,LocalReducedMotion provides reduced.value) {
                SceneSurface(assets,scene.value,Modifier.fillMaxSize(),cameraControls=controls)
            } } } }
            fun settled(label:String) {
                val before=frames.get();val expected=scene.value.campTroops
                val signature=expected.fold(1) { h,t ->31*h+t.identity.hashCode() }
                await(label) {val s=last.get();s?.kind==LocalSceneKind.BASE && s.queueDepth==0 && s.pendingWallUploads==0 &&
                    s.campCount==expected.size && s.campRosterHash==signature && s.campDrawn==expected.size && frames.get()>before+12}
            }
            fun capture(name:String) {
                val surface=main { surfaces(host.window.decorView).single() };val s=requireNotNull(last.get())
                val bitmap=Bitmap.createBitmap(surface.width,surface.height,Bitmap.Config.ARGB_8888);val latch=CountDownLatch(1);var code=-1
                PixelCopy.request(surface,bitmap,{code=it;latch.countDown()},Handler(Looper.getMainLooper()))
                check(latch.await(12,TimeUnit.SECONDS) && code==PixelCopy.SUCCESS)
                try {
                    val file=File(directory,"$name.png");file.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG,100,it)) }
                    records+=buildJsonObject {put("path",file.name);put("sha256",hash(file.readBytes()));put("width",bitmap.width);put("height",bitmap.height)
                        put("cameraX",s.cameraX);put("cameraY",s.cameraY);put("cameraZoom",s.cameraZoom);put("reducedMotion",reduced.value)
                        put("campCount",s.campCount);put("campDrawn",s.campDrawn);put("rosterHash",s.campRosterHash);put("poseHash",s.campPoseHash);put("frameHash",s.campFrameHash)
                        put("uniqueSeats",scene.value.campTroops.map { it.identity }.toSet().size);put("levels",JsonArray(scene.value.campTroops.map {JsonPrimitive(it.level)}))
                        put("queueDepth",s.queueDepth);put("textureMiB",s.textureMiB);put("frames",frames.get());put("buildings",306)}
                } finally { bitmap.recycle() };receipt()
            }
            fun panTo(wx:Float,wy:Float) {
                repeat(20) {
                    val s=requireNotNull(last.get());val surface=main { surfaces(host.window.decorView).single() };val loc=IntArray(2);main { surface.getLocationOnScreen(loc) }
                    val dx=((s.cameraX-wx)/s.cameraZoom).toFloat().coerceIn(-surface.width*.35f,surface.width*.35f)
                    val dy=((s.cameraY-wy)/s.cameraZoom).toFloat().coerceIn(-surface.height*.3f,surface.height*.3f)
                    if(abs(dx)<3 && abs(dy)<3)return
                    val x=loc[0]+surface.width*.5f;val y=loc[1]+surface.height*.5f;val down=SystemClock.uptimeMillis()
                    fun event(a:Int,ex:Float,ey:Float) {val e=MotionEvent.obtain(down,SystemClock.uptimeMillis(),a,ex,ey,0);try{i.sendPointerSync(e)}finally{e.recycle()}}
                    event(MotionEvent.ACTION_DOWN,x,y);for(n in 1..8){event(MotionEvent.ACTION_MOVE,x+dx*n/8,y+dy*n/8);Thread.sleep(16)}
                    event(MotionEvent.ACTION_UP,x+dx,y+dy);settled("pan")
                    if(abs(requireNotNull(last.get()).cameraY-s.cameraY)<.5)return // admitted terrain clamp
                }
            }
            settled("training is not ready army");capture("01-training-empty")
            val ready=mapper.baseScene(home(types.map {it to 4}));check(ready.campTroops.size==24);check(ready.campTroops.all {it.level==20})
            check(ready.campTroops.map {it.identity}.distinct().size==24)
            main {scene.value=ready};settled("ready army compact textures");capture("02-ready-portrait")
            val memoryReady=requireNotNull(last.get()).textureMiB
            main {host.requestedOrientation=ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE}
            await("landscape surface") { val s=last.get();s!=null && s.viewportWidth>s.viewportHeight }
            controls.fit();settled("landscape fit");capture("03-ready-landscape")
            repeat(2){controls.zoomIn()};settled("camp closeup");panTo(15*ready.tilePixels,27*ready.tilePixels);capture("04-camps-moving-a")
            val motionA=requireNotNull(last.get());await("authored walk and idle advance") {val s=last.get();s!=null && s.campPoseHash!=motionA.campPoseHash && s.campFrameHash!=motionA.campFrameHash}
            Thread.sleep(650);capture("05-camps-moving-b")
            main {reduced.value=true};settled("reduced camp motion");capture("06-reduced")
            val held=requireNotNull(last.get());Thread.sleep(450)
            check(last.get()!!.campPoseHash==held.campPoseHash && last.get()!!.campFrameHash==held.campFrameHash)
            val refreshed=mapper.baseScene(home(types.reversed().map {it to 4},refresh=1))
            check(refreshed.campTroops==ready.campTroops)
            main {scene.value=refreshed};settled("same ready roster refresh")
            check(last.get()!!.campPoseHash==held.campPoseHash) {"Same-base refresh moved camp seats"}
            capture("07-refresh-no-duplicates")
            main {scene.value=mapper.baseScene(home(listOf("dragon" to 4,"bowman" to 1)))}
            settled("casualties authoritative army");capture("08-casualties-five")
            main {scene.value=mapper.baseScene(home(emptyList()))};settled("empty army removed");capture("09-empty")
            check(last.get()!!.textureMiB<memoryReady) {"Empty camps retained optional body textures"}
            main {scene.value=ready;reduced.value=false};settled("training refill");capture("10-refilled")
            check(hash(File(assets,"manifest.json").readBytes())==expectedManifest)
            status="passed-needs-visual-review";receipt();return directory.absolutePath
        } catch(f:Throwable) {status="failed";error=f.message;receipt();throw f}
        finally {activity?.let {h->main {h.finishAndRemoveTask()}};i.waitForIdleSync();sceneLease?.close()}
    }
}
