package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.*
import android.view.*
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.*
import gg.pixelkingdomwars.nativeclient.ui.*
import gg.pixelkingdomwars.nativeclient.ui.battle.LiveBattleScreen
import gg.pixelkingdomwars.nativeclient.ui.home.*
import gg.pixelkingdomwars.nativeclient.ui.kingdom.*
import gg.pixelkingdomwars.nativeclient.ui.more.MoreDestination
import gg.pixelkingdomwars.nativeclient.ui.nav.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.*

/** Actual scene + actual chrome, isolated from the original release package and account graph.
 * System-compositor PNGs and independent GL PixelCopy frames are identified separately. */
internal object FloatingHudHarness {
    private val nextActivityConfiguration=AtomicReference<Configuration?>()
    /** One-shot, test-only context override; separate Dialog windows inherit it from their activity. */
    fun applyActivityConfiguration(activity: android.app.Activity) {
        if(activity !is MainActivity)return
        nextActivityConfiguration.getAndSet(null)?.let { activity.applyOverrideConfiguration(Configuration(it)) }
    }
    private data class Profile(val name: String, val portrait: Boolean, val widthDp: Int, val font: Float)
    private data class Node(val text: String, val description: String, val bounds: Rect, val target: Rect?, val enabled: Boolean) {
        fun matches(label: String) = text.contains(label) || description.contains(label)
        fun json() = buildJsonObject {
            put("text",text);put("description",description);put("enabled",enabled)
            put("bounds",rect(bounds));target?.let { put("target",rect(it)) }
        }
    }
    private fun rect(r: Rect) = buildJsonArray { add(r.left);add(r.top);add(r.right);add(r.bottom) }
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun <T> main(block: () -> T): T {
        val done=CountDownLatch(1);val result=AtomicReference<Result<T>>()
        Handler(Looper.getMainLooper()).post { result.set(runCatching(block));done.countDown() }
        check(done.await(12,TimeUnit.SECONDS)) { "Synthetic main-thread action timed out" };return result.get().getOrThrow()
    }
    private fun frames() { repeat(3) { val done=CountDownLatch(1);main { Choreographer.getInstance().postFrameCallback { done.countDown() } };check(done.await(8,TimeUnit.SECONDS)) } }
    private fun await(label: String, seconds: Long=45, predicate: () -> Boolean) {
        val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(seconds)
        while(System.nanoTime()<deadline) { if(predicate())return;Thread.sleep(40) };error("Timed out: $label")
    }
    private fun nodes(i: Instrumentation): List<Node> {
        check(i.uiAutomation.clearCache()) { "Synthetic accessibility cache could not be cleared" }
        val result=mutableListOf<Node>()
        fun visit(n: AccessibilityNodeInfo?, parent: Rect?=null, enabled: Boolean=true) {
            if(n==null || !n.refresh())return
            val bounds=Rect().also(n::getBoundsInScreen)
            val target=if(n.isClickable)bounds else parent
            val active=if(n.isClickable)n.isEnabled else enabled
            if(n.isVisibleToUser && !bounds.isEmpty)result+=Node(n.text?.toString().orEmpty(),n.contentDescription?.toString().orEmpty(),bounds,target,active)
            repeat(n.childCount) { visit(n.getChild(it),target,active) }
        }
        visit(i.uiAutomation.rootInActiveWindow);return result
    }
    private fun scroll(i: Instrumentation): Boolean {
        check(i.uiAutomation.clearCache())
        fun find(n: AccessibilityNodeInfo?): Boolean {
            if(n==null || !n.refresh())return false
            if(n.isVisibleToUser && n.isScrollable && n.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD))return true
            return (0 until n.childCount).any { find(n.getChild(it)) }
        }
        val changed=find(i.uiAutomation.rootInActiveWindow);if(changed)frames();return changed
    }
    private class Touch(private val i: Instrumentation) {
        private var down=0L
        private val points=linkedMapOf<Int,Pair<Float,Float>>()
        private fun send(action: Int) {
            val properties=points.keys.map { id -> MotionEvent.PointerProperties().apply { this.id=id;toolType=MotionEvent.TOOL_TYPE_FINGER } }.toTypedArray()
            val coordinates=points.values.map { point -> MotionEvent.PointerCoords().apply { x=point.first;y=point.second;pressure=1f;size=1f } }.toTypedArray()
            val event=MotionEvent.obtain(down,SystemClock.uptimeMillis(),action,points.size,properties,coordinates,0,0,1f,1f,0,0,InputDevice.SOURCE_TOUCHSCREEN,0)
            try { i.sendPointerSync(event) } finally { event.recycle() }
        }
        fun down(id: Int,x: Float,y: Float) { if(points.isEmpty())down=SystemClock.uptimeMillis();points[id]=x to y;send(if(points.size==1)MotionEvent.ACTION_DOWN else MotionEvent.ACTION_POINTER_DOWN or ((points.size-1) shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)) }
        fun move(id: Int,x: Float,y: Float) { check(id in points);points[id]=x to y;send(MotionEvent.ACTION_MOVE);Thread.sleep(30) }
        fun up(id: Int) { val index=points.keys.indexOf(id);check(index>=0);send(if(points.size==1)MotionEvent.ACTION_UP else MotionEvent.ACTION_POINTER_UP or (index shl MotionEvent.ACTION_POINTER_INDEX_SHIFT));points.remove(id) }
        fun tap(x: Float,y: Float) { down(0,x,y);Thread.sleep(45);up(0);frames() }
        fun cancel() { if(points.isNotEmpty()) { send(MotionEvent.ACTION_CANCEL);points.clear() } }
    }
    private fun surfaces(view: View): List<SurfaceView> = when(view) {
        is SurfaceView -> listOf(view)
        is ViewGroup -> (0 until view.childCount).flatMap { surfaces(view.getChildAt(it)) }
        else -> emptyList()
    }
    fun capture(i: Instrumentation, orientation: String? = null, homeOnly: Boolean = false, profileName: String? = null): String {
        require(orientation==null || orientation in setOf("portrait","landscape"))
        check(BuildConfig.DEBUG && BuildConfig.APPLICATION_ID=="gg.pixelkingdomwars.twa.debug" && Build.HARDWARE=="ranchu")
        val origin=BuildConfig.API_ORIGIN.toHttpUrl();val octets=origin.host.split('.').mapNotNull(String::toIntOrNull)
        val local=origin.host in setOf("localhost","127.0.0.1") || (octets.size==4 && octets.all { it in 0..255 } &&
            (octets[0]==10 || octets[0]==172 && octets[1] in 16..31 || octets[0]==192 && octets[1]==168))
        check(origin.isHttps && origin.port==18443 && local)
        val directory=File(i.targetContext.noBackupFilesDir,"floating-hud/${System.currentTimeMillis()}");check(directory.mkdirs())
        val observations=mutableListOf<JsonObject>();var stage="prepare";var status="running";var failure: String?=null
        var host: MainActivity?=null;var fixture: FloatingHudFixtures?=null;var cleanup=false
        val snapshot=AtomicReference<LocalSceneSnapshot?>();val registry=AtomicReference<SceneInputRegions?>();val renderedObservations=AtomicLong()
        var surfaceWindow: Any?=null;var physicalWidth=0;var physicalHeight=0
        var currentProfile=Profile("portrait",true,393,1f)
        val mode=mutableStateOf("home");val selected=mutableStateOf<String?>(null);val info=mutableStateOf(false)
        val touches=Touch(i);val selectionLog=mutableListOf<String>();val routes=mutableListOf<String>()
        var assets: File?=null;var content: ContentState?=null;var home: BaseState?=null;var scene: BaseScene?=null
        fun record(kind: String, body: JsonObject=buildJsonObject {}) { observations+=buildJsonObject { put("profile",currentProfile.name);put("kind",kind);body.forEach { (k,v)->put(k,v) } } }
        fun receipt() { File(directory,"receipt.json").writeText(buildJsonObject {
            put("status",status);put("stage",stage);put("failure",failure?.let(::JsonPrimitive)?:JsonNull)
            put("syntheticOnly",true);put("applicationId",BuildConfig.APPLICATION_ID);put("originalReleasePackageTouched",false)
            put("fixtureNetworkTransportConstructed",false);put("accountSessionHydrated",false);put("preferencesChanged",false)
            put("hostScope","Existing MainActivity offline preview constructs its normal application graph/preferences; the replacement synthetic fixture does not use them or hydrate an account.")
            put("profileScope","One-shot activity Configuration override before onCreate, inherited by separate Dialog windows; no global configuration or preference writes.")
            put("physicalSeekerAcceptance",false);put("cleanupCompleted",cleanup)
            put("captureScope","UiAutomation system-compositor screenshots plus separately labeled SurfaceView PixelCopy; no FPS or physical-device claim")
            put("fixtureScope","Hash-pinned historical SIM14 Stage100 events/snapshot retained with current UI/render content. The injected coordinator retains SIM14 and adds a 90-dragon/two-hero reservation and staging clock. Only synthetic receipts are acknowledged; this does not certify SIM15 rules or simulation outcomes.")
            put("forbiddenCalls",fixture?.forbiddenCalls?:0);put("fixtureErrors",JsonArray(fixture?.errors.orEmpty().map(::JsonPrimitive)))
            snapshot.get()?.let { put("lastRendererSnapshot",buildJsonObject { put("kind",it.kind.name);put("width",it.viewportWidth);put("height",it.viewportHeight);put("queueDepth",it.queueDepth);put("pendingWallUploads",it.pendingWallUploads);put("cameraX",it.cameraX);put("cameraY",it.cameraY);put("zoom",it.cameraZoom) }) }
            put("observations",JsonArray(observations))
        }.toString()) }
        fun capture(label: String): List<Node> {
            frames();val ns=nodes(i);val image=requireNotNull(i.uiAutomation.takeScreenshot())
            check(image.width==physicalWidth && image.height==physicalHeight)
            val png=File(directory,"${currentProfile.name}-$label-compositor.png")
            try { png.outputStream().use { check(image.compress(Bitmap.CompressFormat.PNG,100,it)) } } finally { image.recycle() }
            val tree=File(directory,"${currentProfile.name}-$label-accessibility.json");tree.writeText(JsonArray(ns.map(Node::json)).toString())
            val surface=main { surfaces(requireNotNull(host).window.decorView).singleOrNull { it.width>0 && it.height>0 && it.holder.surface.isValid } }
            surface?.let {
                val bitmap=Bitmap.createBitmap(it.width,it.height,Bitmap.Config.ARGB_8888);val done=CountDownLatch(1);var code=-1
                PixelCopy.request(it,bitmap,{ value->code=value;done.countDown() },Handler(Looper.getMainLooper()))
                check(done.await(8,TimeUnit.SECONDS) && code==PixelCopy.SUCCESS)
                try { File(directory,"${currentProfile.name}-$label-gl.png").outputStream().use { stream->check(bitmap.compress(Bitmap.CompressFormat.PNG,100,stream)) } } finally { bitmap.recycle() }
            }
            record("capture",buildJsonObject { put("label",label);put("compositorSha256",sha(png.readBytes()));put("windowWidthPx",physicalWidth);put("windowHeightPx",physicalHeight);put("requestedWidthDp",currentProfile.widthDp);put("density",requireNotNull(host).resources.displayMetrics.density);put("actualWidthDp",requireNotNull(host).resources.configuration.screenWidthDp);put("fontScale",requireNotNull(host).resources.configuration.fontScale) });receipt();return ns
        }
        fun bounded(n: Node) = n.bounds.left>=0 && n.bounds.top>=0 && n.bounds.right<=physicalWidth && n.bounds.bottom<=physicalHeight
        fun target(label: String): Rect {
            val n=nodes(i).firstOrNull { it.matches(label) && bounded(it) && it.target!=null && it.enabled } ?: error("Visible enabled control absent: $label")
            val r=requireNotNull(n.target);val minimum=48f*requireNotNull(host).resources.displayMetrics.density
            check(r.left>=0 && r.top>=0 && r.right<=physicalWidth && r.bottom<=physicalHeight && r.width()>=minimum-2 && r.height()>=minimum-2) { "Control bounds/48dp target failed: $label $r" }
            return r
        }
        fun tap(label: String) { val r=target(label);touches.tap(r.exactCenterX(),r.exactCenterY()) }
        fun camera() = requireNotNull(snapshot.get())
        fun settledGl(after: Long=renderedObservations.get()) { await("two fresh GL observations") { renderedObservations.get()>=after+2 } }
        fun geometry(): SceneInputGeometry = main { requireNotNull(registry.get()).geometry(androidx.compose.ui.geometry.Rect(0f,0f,physicalWidth.toFloat(),physicalHeight.toFloat()),surfaceWindow) }
        fun fieldPoint(worldX: Float,worldY: Float,tilePixels: Float): Pair<Float,Float> {
            val c=camera();return ((worldX*tilePixels-c.cameraX)/c.cameraZoom+physicalWidth/2).toFloat() to ((worldY*tilePixels-c.cameraY)/c.cameraZoom+physicalHeight/2).toFloat()
        }
        fun clearPoint(): Pair<Float,Float> {
            val g=geometry()
            for(y in physicalHeight/3 until physicalHeight*2/3 step 20)for(x in physicalWidth/3 until physicalWidth*2/3 step 20)
                if(g.accepts(x,y,physicalWidth,physicalHeight) && g.accepts(x+110,y+30,physicalWidth,physicalHeight))return x.toFloat() to y.toFloat()
            error("No exposed scene gap for gesture")
        }
        try {
            receipt()
            val bytes=i.context.assets.open("battle-reliability/stage100-dragons-90.json").use { it.readBytes() }
            val provenanceBytes=i.context.assets.open("battle-reliability/provenance.json").use { it.readBytes() }
            val provenance=Json.parseToJsonElement(provenanceBytes.decodeToString()).jsonObject
            val pin=provenance.getValue("fixtures").jsonArray.map { it.jsonObject }.single { it.string("path")=="stage100-dragons-90.json" }
            check(sha(bytes)==pin.string("sha256") && bytes.size==pin.getValue("bytes").jsonPrimitive.int)
            File(directory,"provenance.json").writeBytes(provenanceBytes)
            val canonical=Json.parseToJsonElement(bytes.decodeToString()).jsonObject
            val manifest=i.targetContext.assets.open("native/manifest.json").use { it.readBytes() }
            assets=BundledContent.prepare(i.targetContext.noBackupFilesDir,manifest,debug=true,verifier="floating-hud-${BuildConfig.VERSION_CODE}") { i.targetContext.assets.open("native/$it") }
            fun json(name:String)=Json.parseToJsonElement(File(assets,name).readText()).jsonObject
            content=ContentState(assets=assets,catalogue=json("catalogue.json"),renderCatalogue=json("render-catalog.json"))
            val originalHome=SeekerUiHarness.fixtureHome(System.currentTimeMillis())
            val originalBase=requireNotNull(originalHome.base)
            val canonicalSnapshot=canonical.getValue("snapshot").jsonObject
            val homeRaw=JsonObject(originalBase.raw+mapOf(
                "visualContext" to canonical.getValue("visualContext"),
                "claim" to buildJsonObject { put("min",canonicalSnapshot.getValue("claimMin"));put("max",canonicalSnapshot.getValue("claimMax")) },
                "buildings" to JsonArray(originalBase.raw.getValue("buildings").jsonArray.mapIndexed { index, building ->
                    JsonObject(building.jsonObject+mapOf("tx" to JsonPrimitive(11+index*4),"ty" to JsonPrimitive(12)))
                })))
            home=originalHome.copy(base=BaseSnapshot.from(homeRaw))
            scene=SceneMapper(requireNotNull(requireNotNull(content).catalogue),requireNotNull(requireNotNull(content).renderCatalogue)).baseScene(requireNotNull(requireNotNull(home).base).raw)
            val display=i.targetContext.resources.displayMetrics
            val shortEdge=min(display.widthPixels,display.heightPixels);val longEdge=max(display.widthPixels,display.heightPixels)
            val observer=object:LocalSceneDiagnostics { override fun frameStarted(){};override fun frameCompleted(){};override fun state(value:LocalSceneSnapshot){ snapshot.set(value);renderedObservations.incrementAndGet() } }
            val profiles=listOf(Profile("portrait",true,393,1f),Profile("landscape",false,873,1f),Profile("narrow",true,320,1f),Profile("portrait-large",true,393,1.5f),Profile("landscape-large",false,873,1.5f))
                .filter { it.name==(profileName ?: if(orientation=="landscape") "landscape" else "portrait") }
            require(profiles.size==1) { "Unknown floating HUD profile" }
            require(orientation==null || profiles.single().portrait==(orientation=="portrait")) { "Profile and orientation disagree" }
            for(p in profiles) {
                val previousHost=host
                main { previousHost?.finish();fixture?.close() }
                if(previousHost!=null)await("previous synthetic host destroyed") { previousHost.isDestroyed }
                currentProfile=p;stage="${p.name}-layout";snapshot.set(null);selected.value=null;info.value=false;mode.value="home"
                val expectedWidth=if(p.portrait)shortEdge else longEdge;val expectedHeight=if(p.portrait)longEdge else shortEdge
                val testConfiguration=Configuration(i.targetContext.resources.configuration).apply {
                    densityDpi=(expectedWidth.toFloat()/p.widthDp*160).roundToInt();fontScale=p.font
                    screenWidthDp=p.widthDp;screenHeightDp=(expectedHeight/(densityDpi/160f)).roundToInt()
                    this.orientation=if(p.portrait)Configuration.ORIENTATION_PORTRAIT else Configuration.ORIENTATION_LANDSCAPE
                }
                nextActivityConfiguration.set(testConfiguration)
                host=i.startActivitySync(Intent(i.targetContext,MainActivity::class.java).putExtra("preview","base").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
                val activity=requireNotNull(host)
                check(nextActivityConfiguration.get()==null) { "Synthetic activity did not consume its configuration override" }
                check(activity.intent.getStringExtra("preview")=="base") { "Synthetic activity lost its offline preview launch" }
                stage="${p.name}-fixture"
                main { fixture=FloatingHudFixtures(requireNotNull(content),canonical)
                    activity.setContent {
                        val view=LocalView.current
                        CompositionLocalProvider(LocalSceneObserver provides observer,LocalBackRegistry provides remember { BackRegistry() }) {
                            PkwTheme { androidx.compose.material3.Surface(Modifier.fillMaxSize()) { SceneInputScope {
                                registry.set(LocalSceneInputRegions.current);surfaceWindow=view.windowToken
                                if(mode.value=="home") Home(requireNotNull(home),requireNotNull(content),requireNotNull(scene),selected,info,selectionLog,routes)
                                else LiveBattleScreen(requireNotNull(fixture).model(),requireNotNull(fixture).coordinator,20)
                            } } }
                        }
                    }
                }
                await("resumed synthetic host") { main { activity.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED) } }
                stage="${p.name}-orientation"
                val requestedOrientation=if(p.portrait)ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                var stable=0
                await("stable physical and GL orientation",30) {
                    val ready=main {
                        // Normal resume applies saved preference; restore only this fixture override.
                        if(activity.requestedOrientation!=requestedOrientation) { activity.requestedOrientation=requestedOrientation;stable=0 }
                        physicalWidth=activity.window.decorView.width;physicalHeight=activity.window.decorView.height
                        val surface=surfaces(activity.window.decorView).singleOrNull { it.isAttachedToWindow && it.width>0 && it.height>0 }
                        physicalWidth>0 && physicalHeight>0 && (physicalWidth<physicalHeight)==p.portrait &&
                            surface?.width==physicalWidth && surface.height==physicalHeight
                    }
                    val rendered=snapshot.get()
                    stable=if(ready && rendered?.viewportWidth==physicalWidth && rendered.viewportHeight==physicalHeight)stable+1 else 0
                    stable>=12
                }
                check(abs(activity.resources.configuration.fontScale-p.font)<.001f) { "Synthetic activity font scale did not match the requested profile" }
                stage="${p.name}-home"
                frames();await("rendered home") { snapshot.get()?.let { it.kind==LocalSceneKind.BASE && it.viewportWidth==physicalWidth && it.viewportHeight==physicalHeight }==true }
                capture("home-closed");listOf("MENU","BUILD","MAP","RAID").forEach(::target)
                val before=camera();val point=clearPoint();touches.down(0,point.first,point.second);touches.move(0,point.first+80,point.second+20);touches.up(0)
                await("home camera pan") { camera().cameraX!=before.cameraX || camera().cameraY!=before.cameraY }
                check(selected.value==null)
                val homePinch=clearPoint();val homeZoom=camera().cameraZoom
                touches.down(0,homePinch.first,homePinch.second);touches.down(1,homePinch.first+70,homePinch.second)
                touches.move(1,homePinch.first+110,homePinch.second);await("home pinch") { camera().cameraZoom!=homeZoom }
                val pinchedHome=camera();touches.up(1);touches.move(0,homePinch.first+20,homePinch.second+20)
                await("home remaining finger pans") { camera().cameraX!=pinchedHome.cameraX || camera().cameraY!=pinchedHome.cameraY }
                check(camera().cameraZoom==pinchedHome.cameraZoom);touches.up(0);check(selected.value==null)
                val movedHome=camera();tap("MENU");settledGl();capture("home-menu")
                check(camera().cameraX==movedHome.cameraX && camera().cameraY==movedHome.cameraY && camera().cameraZoom==movedHome.cameraZoom) { "Opening HUD disclosure moved a deliberately framed scene" }
                val expected=MoreDestination.entries.map { homeMenuLabel(it,requireNotNull(home),MailStatus(7,1,1),null,0,0) }+listOf("SHARDS","KEEP","SOL","RAID LOG","TROPHIES","ENERGY","PROFILE","ARMY","DAILY CACHE","SHIELDS / BUILDERS / EXPANSION")
                val found=mutableSetOf<String>()
                for(page in 0..6) { val ns=nodes(i);expected.filter { label->ns.any { it.matches(label)&&bounded(it) } }.forEach(found::add)
                    capture("menu-page-$page");if(found.containsAll(expected))break;if(!scroll(i))break }
                check(found.containsAll(expected)) { "Menu routes/values unreachable: ${expected-found}" };record("menu-reachable",buildJsonObject { put("labels",JsonArray(found.sorted().map(::JsonPrimitive))) })
                // The menu is inset by 8dp; this exposed outer strip is the actual sibling scrim.
                val visibleMenuMarker=MoreDestination.entries.map { homeMenuLabel(it,requireNotNull(home),MailStatus(7,1,1),null,0,0) }
                    .last { label->nodes(i).any { it.matches(label)&&bounded(it) } }
                touches.tap(physicalWidth-4f*physicalWidth/p.widthDp,physicalHeight/2f)
                await("home scrim dismisses only the menu") { nodes(i).none { it.matches(visibleMenuMarker) } }
                check(selected.value==null);check(nodes(i).any { it.matches("MENU") })
                record("home-gesture-boundaries",buildJsonObject { put("panObserved",true);put("pinchToOneFingerPan",true);put("disclosurePreservedCamera",true);put("scrimDidNotSelect",true) })
                // Fit through the real camera bridge before selecting an actual rendered building.
                val beforeFit=renderedObservations.get();main { activity.supportFragmentManager.fragments.filterIsInstance<KingdomFragment>().single().renderer?.requestCameraFit() };settledGl(beforeFit)
                val building=requireNotNull(scene).buildings.first();val select=fieldPoint(building.tileX+building.footprintWidth/2,building.tileY+building.footprintHeight/2,requireNotNull(scene).tilePixels)
                check(geometry().accepts(select.first.toInt(),select.second.toInt(),physicalWidth,physicalHeight)) { "Selected building lies behind chrome" }
                touches.tap(select.first,select.second);await("rendered building selection") { selected.value==building.id }
                capture("selection-compact");tap("DETAILS");capture("selection-details");tap("DONE");tap("Close building details")
                record("selection",buildJsonObject { put("buildingId",building.id);put("baseId",requireNotNull(requireNotNull(home).base).baseId);put("footprint",buildJsonArray { add(building.tileX);add(building.tileY);add(building.footprintWidth);add(building.footprintHeight) }) })
                if (homeOnly) continue
                stage="${p.name}-battle";main { snapshot.set(null);mode.value="battle" };await("real live battle") { fixture?.coordinator?.state?.value?.phase==BattlePhase.STAGING && snapshot.get()?.kind==LocalSceneKind.BATTLE }
                capture("battle-staging");tap("DRAGON, 90 remaining")
                val f=requireNotNull(fixture);val startCamera=camera();val gap=clearPoint()
                touches.down(0,gap.first,gap.second);touches.move(0,gap.first+70,gap.second+15);touches.up(0)
                await("battle camera pan") { camera().cameraX!=startCamera.cameraX || camera().cameraY!=startCamera.cameraY };check(f.commands.isEmpty())
                val pinch=clearPoint();val zoom=camera().cameraZoom
                touches.down(0,pinch.first,pinch.second);touches.down(1,pinch.first+70,pinch.second)
                touches.move(1,pinch.first+110,pinch.second);await("battle pinch") { camera().cameraZoom!=zoom }
                val pinched=camera();touches.up(1);touches.move(0,pinch.first+20,pinch.second+20)
                await("remaining finger pans") { camera().cameraX!=pinched.cameraX || camera().cameraY!=pinched.cameraY }
                check(camera().cameraZoom==pinched.cameraZoom);touches.up(0);check(f.commands.isEmpty())
                val canceled=clearPoint();touches.down(0,canceled.first,canceled.second);touches.cancel();settledGl();check(f.commands.isEmpty())
                val details=target("DRAGON, 90 remaining");val safe=clearPoint()
                touches.down(0,safe.first,safe.second);touches.down(1,details.exactCenterX(),details.exactCenterY());touches.up(1)
                touches.down(2,safe.first+80,safe.second+30);touches.up(2);touches.up(0);frames();check(f.commands.isEmpty())
                tap("Battle details, buffs and camera");capture("battle-details")
                // An injected contact in the modal window cannot reach the GL surface beneath it.
                touches.tap(2f,physicalHeight/2f);settledGl();check(f.commands.isEmpty())
                if(nodes(i).none { it.text=="BATTLE DETAILS" })tap("Battle details, buffs and camera")
                // Short/large-text readers legitimately scroll their complete panel.
                for(page in 0..6) { if(nodes(i).any { it.matches("FIT FIELD")&&bounded(it) })break;check(scroll(i)) { "Camera actions are unreachable in Battle details" } }
                val beforeBattleFit=renderedObservations.get();tap("FIT FIELD");settledGl(beforeBattleFit)
                for(page in 0..6) { if(nodes(i).any { it.text=="DONE"&&bounded(it) })break;check(scroll(i)) { "Battle details close action is unreachable" } }
                tap("DONE");frames()
                val g=geometry();val battleScene=SceneMapper(requireNotNull(requireNotNull(content).catalogue),requireNotNull(requireNotNull(content).renderCatalogue)).liveScene(f.page)
                val snapshotRaw=canonical.getValue("snapshot").jsonObject;val lo=snapshotRaw.getValue("claimMin").jsonPrimitive.int;val hi=snapshotRaw.getValue("claimMax").jsonPrimitive.int
                val legal=(0 until battleScene.base.rows).flatMap { y->(0 until battleScene.base.columns).map { x->x to y } }.filter { (x,y)->!(x in lo until hi && y in lo until hi) }
                    .map { (x,y)->fieldPoint(x+.5f,y+.5f,battleScene.base.tilePixels) }.firstOrNull { (x,y)->g.accepts(x.toInt(),y.toInt(),physicalWidth,physicalHeight) && x>=8 && y>=8 && x<physicalWidth-8 && y<physicalHeight-8 }
                    ?: error("No visible legal SIM14 tile outside the unlocked claim")
                // An uncertain response must not move a card away from the fingertip.
                // Exercise the production screen and exact-ID recovery, not a duplicate layout.
                val stableLabels=listOf("DRAGON,", "VEX hero, ready", "✕ RETREAT", "ATTACK")
                val initialTargets=stableLabels.associateWith { Rect(target(it)) }
                fun assertReadableActions() {
                    val labels=nodes(i)
                    // The pixel label style uses a 26sp line box. A 32sp allowance
                    // includes font rounding but rejects ATTAC/K and split RETREAT.
                    val lineAllowance=32f*activity.resources.displayMetrics.density*p.font
                    listOf("ATTACK","✕ RETREAT","RALLY RDY").forEach { label ->
                        val node=labels.single { it.text==label && bounded(it) }
                        val lines=if(label=="RALLY RDY")2 else 1
                        check(node.bounds.height()<=lineAllowance*lines+2) { "Battle action label wraps inside a word: $label" }
                    }
                }
                fun assertStableTray(label: String) {
                    frames()
                    assertReadableActions()
                    stableLabels.forEach { control -> check(target(control)==initialTargets.getValue(control)) {
                        "$label moved battle thumb target: $control"
                    } }
                }
                assertReadableActions()
                main { f.commandStartsBattle=false;f.commandReply=CompletableDeferred() }
                touches.tap(legal.first,legal.second)
                await("one durable sending request") { f.attemptedCommands.size==1 && f.coordinator.state.value.inFlight.size==1 }
                assertStableTray("Sending")
                val originalId=main { f.coordinator.state.value.pending!!.writes.single().id }
                val statusTarget=target("1 sending · Details")
                check(initialTargets.values.all { !Rect.intersects(statusTarget,it) && statusTarget.bottom<=it.top }) { "Request status must stay above troop/action targets" }
                val heroTarget=initialTargets.getValue("VEX hero, ready")
                touches.tap(heroTarget.exactCenterX(),heroTarget.exactCenterY())
                await("unchanged hero target selects Vex") { nodes(i).any { it.matches("TAP THE FIELD TO DEPLOY · VEX") } }
                check(f.attemptedCommands.size==1) { "Selecting a hero must not deploy another troop" }
                capture("battle-command-sending")
                main { f.commandReply!!.cancel();f.commandReply=null }
                await("uncertain original request") { f.coordinator.state.value.inFlight.isEmpty() && f.coordinator.state.value.pending?.writes?.singleOrNull()?.id==originalId }
                assertStableTray("Awaiting confirmation")
                tap("1 awaiting confirmation · Details")
                target("Close");target("Retry same request")
                main { f.commandReply=CompletableDeferred() }
                tap("Retry same request")
                await("explicit retry uses original request") { f.attemptedCommands.size==2 && f.coordinator.state.value.inFlight.size==1 }
                check(f.attemptedCommands.toList()==listOf(originalId,originalId))
                tap("Close");assertStableTray("Retrying")
                main { f.commandReply!!.complete(Unit);f.commandReply=null }
                await("one captured synthetic command") { f.commands.size==1 && f.coordinator.state.value.pending?.writes?.isEmpty()==true }
                assertStableTray("Receipt")
                check(nodes(i).none { it.matches("sending · Details") || it.matches("awaiting confirmation · Details") })
                record("stable-pending-tray",buildJsonObject { put("states",buildJsonArray { add("empty");add("sending");add("awaiting-confirmation");add("retrying");add("empty") });put("targets",buildJsonObject { initialTargets.forEach { (label,bounds)->put(label,rect(bounds)) } });put("sameHeroTargetSelected",true);put("retryPreservedOriginalId",true) })
                check(f.errors.isEmpty()&&f.forbiddenCalls==0);capture("battle-command-receipt")
                record("input-and-receipt",buildJsonObject { put("panObserved",true);put("pinchObserved",true);put("droppedFingerPanNoCommand",true);put("hudThirdFingerNoCommand",true);put("actionCancelNoCommand",true);put("modalWindowContactNoCommand",true);put("freshLegalTapCommands",JsonArray(f.commands.toList()));put("pendingWrites",f.coordinator.state.value.pending?.writes?.size?:0) })
                receipt()
            }
            status="passed-needs-visual-review";stage="complete"
        } catch(e:Throwable) { status="failed";failure=e.message;throw e }
        finally { nextActivityConfiguration.set(null);touches.cancel();main { host?.finish();fixture?.close() };cleanup=true;receipt() }
        return directory.absolutePath
    }

    @Composable private fun Home(home: BaseState,content: ContentState,scene: BaseScene,selected: MutableState<String?>,info: MutableState<Boolean>,selections:MutableList<String>,routes:MutableList<String>) {
        val requests=remember { HomeRequests() }
        HomeScaffold(AccountState(phase=AccountPhase.SIGNED_IN,identity=Identity("offline-seeker-ui-fixture","UI FIXTURE",20,true)),home,false,null,requests,
            onOpenLand={routes+="land"},onExit={error("Fixture must not exit")},onOpen={routes+=it.name},onProfile={routes+="profile"},onRaidLog={routes+="raid-log"},onCache={routes+="cache"},onPurchases={routes+="purchases"},onForge={routes+="forge"},wallet=WalletFunds("4.075",emptyMap(),System.currentTimeMillis()),mail=MailStatus(7,1,1)) { _,_,_,_->
            val state=KingdomUiState(home=home,assets=content.assets,catalogue=requireNotNull(content).catalogue,renderCatalogue=requireNotNull(content).renderCatalogue,local=KingdomLocal(selectedBuildingId=selected.value,infoOpen=info.value))
            val padding=LocalHomeScenePadding.current;val density=LocalDensity.current;val direction=androidx.compose.ui.platform.LocalLayoutDirection.current
            val insets=with(density) { CameraInsets(padding.calculateLeftPadding(direction).roundToPx(),padding.calculateTopPadding().roundToPx(),padding.calculateRightPadding(direction).roundToPx(),padding.calculateBottomPadding().roundToPx()) }
            BoxWithConstraints(Modifier.fillMaxSize()) {
                val trayHeight=maxHeight*.65f
                SceneSurface(requireNotNull(content.assets),scene,Modifier.fillMaxSize(),cameraInsets=insets,highlights=state.highlights,onSelected={selected.value=it;info.value=false;selections+=it})
                state.selectedBuilding?.let { building ->
                    Box(Modifier.align(Alignment.BottomStart).widthIn(max=480.dp).fillMaxWidth().padding(padding).padding(8.dp)) {
                        BuildingSheet(state,building,false,System.currentTimeMillis(),home.mine,onTrain={},onResearch={},onArmy={},onForge={},onUpgrade={},onFinish={},onCancel={},onRepair={},onCollect={},onToggleRow={},onQuoteRow={},onToggleInfo={info.value=!info.value},onClose={selected.value=null;info.value=false},onConfirm={},maxHeight=trayHeight)
                    }
                }
            }
        }
    }
}
