package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
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
import gg.pixelkingdomwars.nativeclient.content.ContentStore
import gg.pixelkingdomwars.nativeclient.data.FantasyCatalog
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.renderer.*
import kotlinx.serialization.json.*
import java.io.File
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Actual renderer, frozen local artwork and no session/repository/network access. File observation
 * and injected detail failures live only in the instrumentation APK. Timings are emulator evidence. */
internal object WorldDetailGlHarness {
    private fun hash(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun await(label:String,seconds:Long=30,predicate:()->Boolean) {
        val until=System.nanoTime()+TimeUnit.SECONDS.toNanos(seconds)
        while(System.nanoTime()<until) { if(predicate())return;Thread.sleep(40) }
        error("Timed out: $label")
    }
    fun capture(instrumentation:Instrumentation) {
        check(BuildConfig.DEBUG && Build.HARDWARE=="ranchu" && BuildConfig.API_ORIGIN=="https://127.0.0.1:18443")
        val context=instrumentation.targetContext
        fun json(path:String)=Json.parseToJsonElement(context.assets.open("native/$path").bufferedReader().use { it.readText() }).jsonObject
        val render=json("render-catalog.json");val catalogue=json("catalogue.json")
        val fantasy=render.getValue("fantasy").jsonObject;val presentation=fantasy.getValue("presentation").jsonObject
        val identity=hash(JsonObject(fantasy.getValue("globe").jsonObject.filterKeys { it!="groups" }).toString().toByteArray())
        val lease=ContentStore(File(context.noBackupFilesDir,storageNamespace(BuildConfig.API_ORIGIN,"world-content"))).retain(identity)
        val world=catalogue.getValue("constants").jsonObject.getValue("FANTASY_WORLD").jsonObject
        val catalog=FantasyCatalog.parse(json("fantasy/world-v1.json"),world.getValue("columns").jsonPrimitive.int,world.getValue("rows").jsonPrimitive.int)
        val sources=presentation.getValue("regionalDetails").jsonArray.map { item -> val s=item.jsonObject
            GlobeDetailSource(s.getValue("id").jsonPrimitive.content,s.getValue("west").jsonPrimitive.float,s.getValue("east").jsonPrimitive.float,s.getValue("south").jsonPrimitive.float,s.getValue("north").jsonPrimitive.float,s.getValue("width").jsonPrimitive.int,s.getValue("height").jsonPrimitive.int,s.getValue("filterScale").jsonPrimitive.float)
        }
        val chains=presentation.getValue("chains").jsonArray.map { it.jsonObject }
        val shape=presentation.getValue("islands").jsonObject;val ocean=presentation.getValue("ocean").jsonObject;val cloud=presentation.getValue("clouds").jsonObject
        val art=GlobeArt(chains.map { it.getValue("id").jsonPrimitive.content },chains.flatMapIndexed { chain,c -> c.getValue("islands").jsonArray.mapIndexed { slot,item -> val s=item.jsonObject
            GlobeIsland(chain,slot,s.getValue("lon").jsonPrimitive.double,s.getValue("lat").jsonPrimitive.double,s.getValue("rx").jsonPrimitive.double,s.getValue("ry").jsonPrimitive.double)
        } },shape.getValue("cell").jsonPrimitive.int,shape.getValue("atlas").jsonPrimitive.int,shape.getValue("extent").jsonPrimitive.double,
            ocean.getValue("path").jsonPrimitive.content,ocean.getValue("width").jsonPrimitive.int,ocean.getValue("height").jsonPrimitive.int,ocean.getValue("stops").jsonArray.map { it.jsonArray.map { v->v.jsonPrimitive.float }.toFloatArray() },
            cloud.getValue("path").jsonPrimitive.content,cloud.getValue("bankWidth").jsonPrimitive.int,cloud.getValue("bankHeight").jsonPrimitive.int,cloud.getValue("banks").jsonArray.map { item -> val b=item.jsonArray.map { it.jsonPrimitive.double };GlobeCloudBank(b[0],b[1],b[2],b[3]) },
            presentation.getValue("effectsPath").jsonPrimitive.content,catalog.columns,catalog.rows,catalog::isLand,catalog::isGenesis,{lon,lat->catalog.isGenesis(GlobeGeometry.tileAt(lon,lat,catalog.columns,catalog.rows))})
        val started=System.nanoTime();val directory=File(context.noBackupFilesDir,"world-detail-gl/${System.currentTimeMillis()}");check(directory.mkdirs())
        val rows=Collections.synchronizedList(mutableListOf<JsonObject>())
        val last=AtomicReference<GlobeDetailState?>();val fatal=AtomicReference<String?>();val soft=AtomicReference<String?>()
        val picked=AtomicReference<GlobePick?>()
        val failId=AtomicReference<String?>();val firstDecodeGate=CountDownLatch(1)
        var host:MainActivity?=null;var rendererOwnsLease=false;var status="running";var failure:String?=null
        fun note(kind:String,body:JsonObject=buildJsonObject {}) { rows+=buildJsonObject { put("kind",kind);put("elapsedMs",(System.nanoTime()-started)/1e6);body.forEach { (k,v)->put(k,v) } } }
        fun readCount(kind:String)=synchronized(rows) { rows.count { it["kind"]?.jsonPrimitive?.content==kind } }
        fun receipt() { File(directory,"receipt.json").writeText(buildJsonObject {
            put("status",status);put("failure",failure?.let(::JsonPrimitive) ?: JsonNull);put("globeIdentity",identity)
            put("networkRequests",0);put("accountAccessRequested",false);put("physicalSeekerAcceptance",false)
            put("measurement","Android emulator renderer callbacks and file reads; no claim of GPU/display frame timing")
            put("events",JsonArray(synchronized(rows) { rows.toList() }))
        }.toString()) }
        class ObservedFile(file:File):FileHandle(file) {
            override fun child(name:String):FileHandle=ObservedFile(File(file(),name))
            override fun readBytes():ByteArray {
                val regional=sources.firstOrNull { name()=="${it.id}-detail.png" }
                val chain=art.chainIds.firstOrNull { name()=="$it-detail.png" || name()=="$it-detail-mask.png" }
                if(regional==null && chain==null)return super.readBytes()
                val id=regional?.id ?: requireNotNull(chain)
                val kind=if(regional!=null)"detail" else "chain"
                val at=System.nanoTime()
                note("$kind-read-start",buildJsonObject { put("id",id);put("file",name());put("thread",Thread.currentThread().name) })
                check(Thread.currentThread().name=="world-detail") { "World detail PNG decode reached Main/GL" }
                check(firstDecodeGate.await(30,TimeUnit.SECONDS)) { "Fixture decode gate was not released" }
                if(failId.get()==id || failId.get()==name())error("Injected optional-detail read failure")
                return super.readBytes().also { note("$kind-read-complete",buildJsonObject { put("id",id);put("file",name());put("readMs",(System.nanoTime()-at)/1e6);put("bytes",it.size) }) }
            }
        }
        try {
            receipt()
            host=instrumentation.startActivitySync(Intent(context,MainActivity::class.java).putExtra("preview","base").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            val activity=host
            instrumentation.runOnMainSync { activity.setContent { Box {} } };instrumentation.waitForIdleSync()
            val game=FantasyGlobeRenderer(ObservedFile(lease.directory),GlobeView(),sources,art,false,
                { _,_-> },{picked.set(it)}, { fatal.set(it) },{lease.close()}, {note("coarse-ready")}, {soft.set(it)}, { state ->
                    last.set(state);note("detail-state",buildJsonObject { put("resident",JsonArray(state.residentIds.map(::JsonPrimitive)));put("chains",JsonArray(state.residentChains.map(::JsonPrimitive)));put("activatingChain",state.activatingChain?.let(::JsonPrimitive) ?: JsonNull);put("pending",state.pending);put("coarseReady",state.coarseReady);put("paused",state.paused);put("zoom",state.view.zoom);put("lon",state.view.lon);put("lat",state.view.lat) })
                })
            val fragment=WorldDetailTestFragment().apply { renderer=game }
            instrumentation.runOnMainSync {
                check(activity.supportFragmentManager.fragments.isEmpty())
                val container=FrameLayout(activity).apply { id=View.generateViewId() };activity.setContentView(container)
                note("gl-mount-start");activity.supportFragmentManager.beginTransaction().add(container.id,fragment,"world-detail-test").commitNow();rendererOwnsLease=true
            }
            fun stable(label:String,predicate:(GlobeDetailState)->Boolean) { await(label) { fatal.get()?.let { error(it) };last.get()?.let(predicate)==true };receipt() }
            fun screenshot(name:String) {
                // A renderer callback precedes eglSwapBuffers. Enter the next GL iteration,
                // then observe both the actual surface and system compositor independently.
                val glBoundary=CountDownLatch(1)
                Gdx.app.postRunnable { glBoundary.countDown() };Gdx.graphics.requestRendering()
                check(glBoundary.await(12,TimeUnit.SECONDS)) { "GL frame boundary did not arrive" }
                fun surfaces(v:View):List<SurfaceView> = when(v) {
                    is SurfaceView->listOf(v)
                    is ViewGroup->(0 until v.childCount).flatMap { surfaces(v.getChildAt(it)) }
                    else->emptyList()
                }
                val surface=AtomicReference<SurfaceView>();val uiBoundary=CountDownLatch(1)
                instrumentation.runOnMainSync {
                    surface.set(surfaces(activity.window.decorView).single())
                    activity.window.decorView.postInvalidateOnAnimation()
                    Choreographer.getInstance().postFrameCallback { uiBoundary.countDown() }
                }
                check(uiBoundary.await(12,TimeUnit.SECONDS))
                val glImage=Bitmap.createBitmap(surface.get().width,surface.get().height,Bitmap.Config.ARGB_8888)
                val copied=CountDownLatch(1);var copyResult=-1
                PixelCopy.request(surface.get(),glImage,{ result->copyResult=result;copied.countDown() },Handler(Looper.getMainLooper()))
                check(copied.await(12,TimeUnit.SECONDS) && copyResult==PixelCopy.SUCCESS)
                fun nonBlank(bitmap:Bitmap)= (1..15).flatMap { y->(1..15).map { x->bitmap.getPixel(bitmap.width*x/16,bitmap.height*y/16) } }.toSet().size>4
                check(nonBlank(glImage)) { "Actual world surface is blank" }
                val glFile=File(directory,"$name-gl.png");glFile.outputStream().use { check(glImage.compress(Bitmap.CompressFormat.PNG,100,it)) };glImage.recycle()
                note("capture",buildJsonObject { put("path",glFile.name);put("sha256",hash(glFile.readBytes()));put("scope","GL surface PixelCopy") })
                val image=instrumentation.uiAutomation.takeScreenshot() ?: error("Compositor capture unavailable")
                check(nonBlank(image)) { "System compositor world capture is blank" }
                val file=File(directory,"$name.png");file.outputStream().use { check(image.compress(Bitmap.CompressFormat.PNG,100,it)) };image.recycle()
                note("capture",buildJsonObject { put("path",file.name);put("sha256",hash(file.readBytes()));put("scope","system compositor") });receipt()
            }
            stable("coarse overview") { it.coarseReady && it.residentIds.isEmpty() }
            val events=synchronized(rows) { rows.toList() }
            val readyAt=events.first { it["kind"]?.jsonPrimitive?.content=="coarse-ready" }.getValue("elapsedMs").jsonPrimitive.double
            check(events.filter { it["kind"]?.jsonPrimitive?.content=="detail-read-start" }.all { it.getValue("elapsedMs").jsonPrimitive.double>=readyAt })
            note("coarse-first-with-test-held-decode");screenshot("01-coarse-overview")
            game.setView(GlobeView(26.0,23.0,32.0));firstDecodeGate.countDown();stable("heartlands detail") { it.residentIds==listOf("heartlands") && it.pending==0 };screenshot("02-heartlands")
            val readsBefore=readCount("detail-read-start")
            game.setView(GlobeView(28.0,25.0,24.0));await("nearby camera") { last.get()?.view?.zoom==24.0 };Thread.sleep(250)
            game.setView(GlobeView(26.0,23.0,32.0));await("warm detail camera") { last.get()?.view?.zoom==32.0 };Thread.sleep(250)
            check(readCount("detail-read-start")==readsBefore);note("warm-camera-no-decode");screenshot("03-warm-heartlands")
            failId.set("cinderfall");game.setView(GlobeView(-150.0,-56.0,32.0));await("nonfatal detail failure") { soft.get()!=null }
            check(fatal.get()==null && last.get()?.coarseReady==true);screenshot("04-failed-detail-coarse-retained")
            failId.set(null);game.retryDetails();stable("same-world detail retry") { "cinderfall" in it.residentIds && it.pending==0 }
            check(soft.get()==null);screenshot("05-detail-retry")
            instrumentation.runOnMainSync { activity.moveTaskToBack(true) };stable("actual Android pause") { it.paused && it.residentIds.isEmpty() }
            // startActivitySync waits for a new Activity and can strand a SINGLE_TOP reentry.
            instrumentation.runOnMainSync { context.startActivity(Intent(context,MainActivity::class.java).putExtra("preview","base").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
            stable("Android resume detail") { !it.paused && "cinderfall" in it.residentIds && it.pending==0 };screenshot("06-resumed-world")
            val island=art.islands.first();val chainId=art.chainIds[island.chain]
            failId.set("$chainId-detail-mask.png")
            val islandView=GlobeGeometry.focusIsland(island,art.extent,GlobeViewport(Gdx.graphics.width,Gdx.graphics.height),Gdx.graphics.density.toDouble())
            game.setView(islandView);await("atomic island mask failure") { soft.get()!=null }
            check(fatal.get()==null && last.get()?.coarseReady==true && chainId !in last.get()!!.residentChains)
            screenshot("07-island-mask-failed-coarse-retained")
            // Select a known interior mask pixel on the instrumentation thread. Production picks
            // may only consult already prepared masks; this fixture lookup cannot warm GL state.
            val mask=android.graphics.BitmapFactory.decodeFile(File(lease.directory,"atlas/fantasy/globe/generated/$chainId-detail-mask.png").absolutePath)
            val originX=island.slot%3*art.cell;val originY=island.slot/3*art.cell
            var tap:Pair<Int,Int>?=null
            try {
                outer@ for(y in 2 until art.cell-2)for(x in 2 until art.cell-2) {
                    if((-2..2).any {dy->(-2..2).any {dx->mask.getPixel(originX+x+dx,originY+y+dy) ushr 16 and 255 != 1}})continue
                    val lon=island.lon+((x+.5)/art.cell*2-1)*art.extent*island.rx
                    val lat=island.lat+(1-(y+.5)/art.cell*2)*art.extent*island.ry
                    if(art.islandAt(lon,lat)?.island!=island)continue
                    val point=GlobeGeometry.project(lon,lat,islandView,GlobeViewport(Gdx.graphics.width,Gdx.graphics.height))
                    if(point.z>0 && point.x in 8.0..Gdx.graphics.width-8.0 && point.y in 8.0..Gdx.graphics.height-8.0) {
                        tap=point.x.toInt() to point.y.toInt();break@outer
                    }
                }
            } finally { mask.recycle() }
            val target=requireNotNull(tap) { "No visible authored island interior" }
            fun pick(label:String):GlobePick {
                picked.set(null)
                val before=readCount("chain-read-start")
                Gdx.app.postRunnable { Gdx.input.inputProcessor.touchDown(target.first,target.second,0,0);Gdx.input.inputProcessor.touchUp(target.first,target.second,0,0) }
                Gdx.graphics.requestRendering();await(label) { picked.get()!=null }
                check(readCount("chain-read-start")==before) { "Picking started a synchronous mask read" }
                return requireNotNull(picked.get())
            }
            val coarsePick=pick("coarse chain pick")
            check(coarsePick.chain==island.chain && coarsePick.island==null) { "A pending mask must not invent an island hit" }
            failId.set(null);game.retryDetails()
            stable("atomic island pair ready") { chainId in it.residentChains && it.pending==0 }
            check(synchronized(rows) { rows.any { it["activatingChain"]?.jsonPrimitive?.contentOrNull==chainId } }) { "Color and mask activation did not yield between uploads" }
            check(pick("loaded island pick").let { it.chain==island.chain && it.island==island.slot })
            note("island-pair-atomic-worker-read-and-cached-mask-pick");screenshot("08-island-pair-ready")
            check(fatal.get()==null);status="passed";receipt()
        } catch(error:Throwable) { status="failed";failure=error.message;receipt();throw error }
        finally {
            firstDecodeGate.countDown()
            host?.let { activity -> instrumentation.runOnMainSync { activity.finishAndRemoveTask() } };instrumentation.waitForIdleSync()
            if(!rendererOwnsLease)lease.close()
        }
    }
}

class WorldDetailTestFragment:AndroidFragmentApplication() {
    lateinit var renderer:FantasyGlobeRenderer
    override fun onCreateView(inflater:LayoutInflater,container:ViewGroup?,state:Bundle?):View = initializeForView(renderer,
        AndroidApplicationConfiguration().apply { useAccelerometer=false;useCompass=false;useGyroscope=false;useImmersiveMode=false;numSamples=0 }).also { surface ->
            surface.doOnAttach { mounted->mounted.post { if(mounted.isAttachedToWindow)mounted.rootView.postInvalidateOnAnimation() } }
        }
}
