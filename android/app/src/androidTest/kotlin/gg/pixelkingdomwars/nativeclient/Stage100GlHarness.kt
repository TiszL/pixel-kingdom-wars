package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.*
import android.view.Choreographer
import android.view.PixelCopy
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import gg.pixelkingdomwars.nativeclient.ui.PkwTheme
import gg.pixelkingdomwars.nativeclient.ui.LocalNativeAudio
import gg.pixelkingdomwars.nativeclient.ui.chrome.Surface
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.*
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicLong

/** Separate test APK assets, real source-generated events and real GL. No repository actions, account
 * requests, wallet operations, command submission or preference changes. Progress callbacks are NOT frame-time samples. */
internal object Stage100GlHarness {
    private fun hash(bytes: ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun <T> main(block: () -> T): T {
        val done=CountDownLatch(1);val result=AtomicReference<Result<T>>()
        Handler(Looper.getMainLooper()).post { result.set(runCatching(block));done.countDown() }
        check(done.await(12,TimeUnit.SECONDS)) { "Main thread did not answer within 12 seconds" }
        return result.get().getOrThrow()
    }
    private fun await(label: String,seconds: Long=45,predicate: () -> Boolean) {
        val end=System.nanoTime()+TimeUnit.SECONDS.toNanos(seconds)
        while(System.nanoTime()<end) { if(predicate()) return;Thread.sleep(40) }
        error("Timed out: $label")
    }
    private fun frameBoundary() {
        val done=CountDownLatch(1)
        main { Choreographer.getInstance().postFrameCallback { done.countDown() } }
        check(done.await(12,TimeUnit.SECONDS)) { "UI frame boundary did not arrive" }
    }
    private fun surfaces(view: View): List<SurfaceView> = when(view) {
        is SurfaceView -> listOf(view)
        is ViewGroup -> (0 until view.childCount).flatMap { surfaces(view.getChildAt(it)) }
        else -> emptyList()
    }
    fun capture(instrumentation: Instrumentation, requested: String?) {
        check(BuildConfig.DEBUG && Build.HARDWARE=="ranchu")
        val origin=BuildConfig.API_ORIGIN.toHttpUrl();val labels=origin.host.split('.');val octets=labels.mapNotNull(String::toIntOrNull)
        val local=origin.host in setOf("localhost","127.0.0.1") || (labels.size==4 && octets.size==4 && octets.all { it in 0..255 } &&
            (octets[0]==10 || octets[0]==172 && octets[1] in 16..31 || octets[0]==192 && octets[1]==168))
        check(origin.isHttps && origin.port==18443 && local)
        check(requested==null || requested in setOf("portrait","landscape"))
        val context=instrumentation.targetContext;val started=System.currentTimeMillis()
        val directory=File(context.noBackupFilesDir,"stage100-gl/$started");check(directory.mkdirs())
        val rows=Collections.synchronizedList(mutableListOf<JsonObject>())
        val uiIntervals=Collections.synchronizedList(mutableListOf<Double>())
        val phase=AtomicReference("verify-fixtures");val last=AtomicReference<BattlePlaybackFrame?>()
        val chosen=mutableStateOf<BattleScene?>(null);val visible=mutableStateOf(false)
        val performanceEnabled=mutableStateOf(false);var localMetricProbeComplete=false
        var audio: Stage100AudioHarness? = null
        var host: MainActivity?=null;var originalOrientation=ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        var callback: Choreographer.FrameCallback?=null;var priorUiFrame=0L;var sequence=0
        var status="running";var error: String?=null;var cleanup=false
        var manifest: JsonObject?=null;var currentOrientation="unknown"
        val glIntervals=Collections.synchronizedList(mutableListOf<Double>())
        val glDurations=Collections.synchronizedList(mutableListOf<Double>())
        val priorGlFrame=AtomicLong();val glStart=AtomicLong();val lastStateAt=AtomicLong()
        val pendingWitness=AtomicReference<LocalSceneSnapshot?>();val latestSnapshot=AtomicReference<LocalSceneSnapshot?>()
        var lifecycleWithPendingWitness=0
        fun note(kind: String,extra: JsonObject=buildJsonObject {}) {
            synchronized(rows) { check(rows.size<8000);rows+=buildJsonObject {
                put("kind",kind);put("phase",phase.get());put("elapsedMs",System.currentTimeMillis()-started);extra.forEach { (k,v)->put(k,v) }
            } }
        }
        fun receipt() {
            val intervals=synchronized(uiIntervals) { uiIntervals.toList().sorted() }
            File(directory,"receipt.json").writeText(buildJsonObject {
                put("status",status);put("phase",phase.get());put("failure",error?.let(::JsonPrimitive) ?: JsonNull)
                put("syntheticOnly",true);put("accountAccessRequested",false);put("gameplayRequests",0);put("preferencesChanged",false)
                put("physicalSeekerAcceptance",false);put("cleanupCompleted",cleanup)
                put("lifecycleActionsWithPendingWitness",lifecycleWithPendingWitness)
                put("pendingWitnessScope","Real renderer queue/upload snapshot preceding the lifecycle action; no artificial scheduling delay or private-field access")
                put("glObserver",buildJsonObject {
                    put("label","Actual render() intervals and CPU spans, not GPU completion or display presentation timing")
                    put("intervalMs",JsonArray(synchronized(glIntervals) { glIntervals.map(::JsonPrimitive) }))
                    put("renderCpuMs",JsonArray(synchronized(glDurations) { glDurations.map(::JsonPrimitive) }))
                })
                put("pack",manifest?.get("contentVersion") ?: JsonNull);put("sourceCommit",manifest?.get("sourceCommit") ?: JsonNull)
                put("requestedOrientation",requested ?: "both");put("renderProgressCadence","approximately 4Hz, not GL frame timing")
                put("uiChoreographer",buildJsonObject {
                    put("samples",intervals.size);put("label","UI frame intervals; lifecycle gaps excluded; not GL timing")
                    if(intervals.isNotEmpty()) { put("p95Ms",intervals[(intervals.lastIndex*.95).toInt()]);put("maxMs",intervals.last()) }
                })
                put("observations",JsonArray(synchronized(rows) { rows.toList() }))
            }.toString())
        }
        val observer=object : LocalSceneDiagnostics {
            override fun frameStarted() {
                val now=System.nanoTime();glStart.set(now)
                val prior=priorGlFrame.getAndSet(now)
                if(prior!=0L) synchronized(glIntervals) { if(glIntervals.size<20000) glIntervals+=(now-prior)/1e6 }
            }
            override fun frameCompleted() {
                val at=glStart.getAndSet(0)
                if(at!=0L) synchronized(glDurations) { if(glDurations.size<20000) glDurations+=(System.nanoTime()-at)/1e6 }
            }
            override fun state(snapshot: LocalSceneSnapshot) {
                val previous=latestSnapshot.getAndSet(snapshot)
                if(snapshot.queueDepth>0 || snapshot.pendingWallUploads>0) pendingWitness.compareAndSet(null,snapshot)
                val now=System.nanoTime()
                if(previous?.queueDepth!=snapshot.queueDepth || previous?.pendingWallUploads!=snapshot.pendingWallUploads || now-lastStateAt.get()>250_000_000) {
                    lastStateAt.set(now)
                    note("renderer-state",buildJsonObject {
                        put("scene",snapshot.kind.name);put("queueDepth",snapshot.queueDepth);put("pendingWallUploads",snapshot.pendingWallUploads)
                        put("width",snapshot.viewportWidth);put("height",snapshot.viewportHeight);put("textureMiB",snapshot.textureMiB)
                        put("cameraX",snapshot.cameraX);put("cameraY",snapshot.cameraY);put("cameraZoom",snapshot.cameraZoom)
                    })
                }
            }
        }
        try {
            val assetManager=instrumentation.context.assets
            val provenanceBytes=assetManager.open("battle-reliability/provenance.json").use { it.readBytes() }
            val provenance=Json.parseToJsonElement(provenanceBytes.decodeToString()).jsonObject
            File(directory,"provenance.json").writeBytes(provenanceBytes)
            val fixtures=provenance.getValue("fixtures").jsonArray.associate { raw->
                val pin=raw.jsonObject;val name=pin.getValue("path").jsonPrimitive.content
                check(name.matches(Regex("stage100-dragons-(2|8|16|90)\\.json")))
                val bytes=assetManager.open("battle-reliability/$name").use { it.readBytes() }
                check(bytes.size==pin.getValue("bytes").jsonPrimitive.int && hash(bytes)==pin.getValue("sha256").jsonPrimitive.content)
                val fixture=Json.parseToJsonElement(bytes.decodeToString()).jsonObject
                check(fixture["sourceCommit"]==provenance["sourceCommit"] && fixture["simVersion"]==provenance["simVersion"])
                check(fixture.getValue("snapshot").jsonObject.getValue("buildings").jsonArray.size==306)
                check(fixture.getValue("buildingHealth").jsonArray.size==306)
                pin.getValue("revision").jsonPrimitive.int to fixture
            }
            check(fixtures.keys==setOf(2,8,16,90));receipt()
            phase.set("launch-offline-preview")
            host=instrumentation.startActivitySync(Intent(context,MainActivity::class.java).putExtra("preview","base")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            val activity=requireNotNull(host);check(activity.intent.getStringExtra("preview")=="base")
            originalOrientation=main { activity.requestedOrientation }
            var root: File?=null
            await("verified bundled preview") { main {
                activity.supportFragmentManager.fragments.filterIsInstance<KingdomFragment>().singleOrNull()?.let {
                    if(it.renderer!=null && it.assetPath.isNotEmpty()) root=File(it.assetPath)
                };root!=null
            } }
            val assets=requireNotNull(root)
            check(assets.canonicalFile.parentFile==context.noBackupFilesDir.canonicalFile && assets.name.matches(Regex("bundled-[a-f0-9]{64}")))
            fun read(name: String)=Json.parseToJsonElement(File(assets,name).readText()).jsonObject
            manifest=read("manifest.json");check(manifest?.get("simVersion")==provenance["simVersion"])
            val mapper=SceneMapper(read("catalogue.json"),read("render-catalog.json"))
            val scenes=fixtures.mapValues { (_,fixture)->mapper.replayScene(fixture) }
            val prepareAudio = Stage100AudioHarness.prepare(File(directory, "audio-fixture"), read("catalogue.json"), scenes.values)
            main {
                audio = prepareAudio(activity)
                note("audio-admitted", requireNotNull(audio).snapshot())
                activity.setContent { CompositionLocalProvider(LocalSceneObserver provides observer, LocalNativeAudio provides requireNotNull(audio).bus) { PkwTheme { Surface(Modifier.fillMaxSize()) {
                    val scene=chosen.value
                    if(visible.value && scene!=null) SceneSurface(assets,scene.base,Modifier.fillMaxSize(),battle=scene,performance=performanceEnabled.value,
                        onFrame={ frame->last.set(frame);audio?.let { note("audio-frame-state", it.snapshot()) };note("rendered",buildJsonObject {
                            put("revision",frame.revision);put("tick",frame.playheadTick);put("eventEndTick",frame.extent.eventEndTick)
                        }) })
                } } } }
                callback=object : Choreographer.FrameCallback {
                    override fun doFrame(at: Long) {
                        if(activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                            if(priorUiFrame!=0L) synchronized(uiIntervals) { if(uiIntervals.size<20000) uiIntervals+=(at-priorUiFrame)/1e6 }
                            priorUiFrame=at
                        } else priorUiFrame=0
                        Choreographer.getInstance().postFrameCallback(this)
                    }
                };Choreographer.getInstance().postFrameCallback(requireNotNull(callback))
            }
            fun request(n: Int,label: String): BattleScene {
                phase.set(label);pendingWitness.set(null);val raw=scenes.getValue(n)
                val next=raw.copy(revision=raw.revision.copy(revision="stage100-${++sequence}-$n"),playing=true,playheadTick=0f)
                note("requested",buildJsonObject { put("revision",next.revision.revision);put("dragons",n) })
                main { chosen.value=next;visible.value=true };frameBoundary()
                return next
            }
            fun settled(scene: BattleScene) {
                await("rendered ${scene.revision.revision}",60) { last.get()?.revision==scene.revision.revision }
                frameBoundary();frameBoundary();note("audio-state", main { requireNotNull(audio).snapshot() });receipt()
            }
            fun pendingAction(scene: BattleScene,kind: String) {
                await("preparation or commit",15) { pendingWitness.get()!=null || last.get()?.revision==scene.revision.revision }
                val pending=pendingWitness.get();val current=latestSnapshot.get()
                if(pending!=null && ((current?.queueDepth ?: 0)>0 || (current?.pendingWallUploads ?: 0)>0)) lifecycleWithPendingWitness++
                note(kind,buildJsonObject {
                    put("latestAlreadyRendered",last.get()?.revision==scene.revision.revision)
                    put("pendingObserved",pending!=null);put("lastObservedQueueDepth",current?.queueDepth ?: 0)
                    put("lastObservedWallUploads",current?.pendingWallUploads ?: 0)
                })
            }
            fun capture(label: String, window: Boolean=false, expected: BattleScene?=null,
                        tickRange: ClosedFloatingPointRange<Float>?=null) {
                val done=CountDownLatch(1);val result=AtomicReference<Int>();val bitmap=AtomicReference<Bitmap>()
                main {
                    val surface=surfaces(activity.window.decorView).single { it.isAttachedToWindow && it.width>0 && it.height>0 }
                    val size=if(window) activity.window.decorView else surface
                    bitmap.set(Bitmap.createBitmap(size.width,size.height,Bitmap.Config.ARGB_8888))
                    val copied=PixelCopy.OnPixelCopyFinishedListener { code->result.set(code);done.countDown() }
                    if(window) PixelCopy.request(activity.window,bitmap.get(),copied,Handler(Looper.getMainLooper()))
                    else PixelCopy.request(surface,bitmap.get(),copied,Handler(Looper.getMainLooper()))
                }
                check(done.await(12,TimeUnit.SECONDS) && result.get()==PixelCopy.SUCCESS)
                val image=bitmap.get();val output=File(directory,"$label.png")
                val rendered=last.get()
                try {
                    if(expected!=null) check(rendered?.revision==expected.revision.revision) { "Screenshot belongs to another rendered revision" }
                    if(tickRange!=null) check(rendered!=null && rendered.playheadTick in tickRange) { "Screenshot missed its intended rendered tick window" }
                    check(if(currentOrientation=="portrait") image.height>image.width else image.width>image.height) { "Captured pixels do not match requested orientation" }
                    output.outputStream().use { check(image.compress(Bitmap.CompressFormat.PNG,100,it)) }
                    note("screenshot",buildJsonObject { put("path",output.name);put("sha256",hash(output.readBytes()));put("width",image.width);put("height",image.height)
                        put("lastRenderedRevision",rendered?.revision ?: "none")
                        put("lastRenderedTick",rendered?.playheadTick?.let(::JsonPrimitive) ?: JsonNull)
                        put("eventEndTick",rendered?.extent?.eventEndTick?.let(::JsonPrimitive) ?: JsonNull)
                        put("visualEndTick",rendered?.extent?.visualEndTick?.let(::JsonPrimitive) ?: JsonNull)
                        if(tickRange!=null) { put("intendedTickMin",tickRange.start);put("intendedTickMax",tickRange.endInclusive) }
                        put("orientation",currentOrientation);put("includesChrome",window)
                        put("captureSurface",if(window) "android-window-chrome" else "libgdx-surface")
                        put("fullDisplayComposite",false) })
                } finally { image.recycle() };receipt()
            }
            fun captureRenderedWindow(scene: BattleScene,label: String,minimum: Float,maximum: Float) {
                check(minimum<=maximum)
                phase.set(label)
                await("rendered window $minimum..$maximum",45) {
                    val frame=last.get()
                    if(frame?.revision!=scene.revision.revision) false else {
                        check(frame.playheadTick<=maximum) { "First playback skipped required rendered window $minimum..$maximum" }
                        frame.playheadTick>=minimum
                    }
                }
                capture(label,expected=scene,tickRange=minimum..maximum)
            }
            fun settleFixtureOrientation(orientation: String,afterResume: Boolean=false) {
                val wanted=if(orientation=="portrait") ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                val configuration=if(orientation=="portrait") Configuration.ORIENTATION_PORTRAIT else Configuration.ORIENTATION_LANDSCAPE
                main {
                    // DeviceExperience correctly reapplies the saved preference on normal resume.
                    // Restore only this fixture's temporary Activity override; never write settings.
                    activity.requestedOrientation=wanted
                    if(afterResume) { last.set(null);latestSnapshot.set(null) }
                }
                var previous: Pair<Int,Int>?=null;var stable=0
                await("stable $orientation fixture viewport",15) {
                    val dimensions=main {
                        if(activity.resources.configuration.orientation!=configuration) null else {
                            val surface=surfaces(activity.window.decorView).singleOrNull { it.isAttachedToWindow && it.width>0 && it.height>0 }
                            when {
                                surface==null && !visible.value -> 0 to 0
                                surface==null -> null
                                (orientation=="portrait" && surface.height>surface.width) || (orientation=="landscape" && surface.width>surface.height) -> surface.width to surface.height
                                else -> null
                            }
                        }
                    }
                    val snapshot=latestSnapshot.get()
                    val rendererReady=!afterResume || (snapshot!=null && dimensions==(snapshot.viewportWidth to snapshot.viewportHeight))
                    stable=if(dimensions!=null && rendererReady && dimensions==previous) stable+1 else 0
                    previous=dimensions
                    stable>=2
                }
                frameBoundary();frameBoundary()
                note("orientation-settled",buildJsonObject {
                    put("orientation",orientation);put("afterResume",afterResume)
                    put("surfaceWidth",previous?.first ?: 0);put("surfaceHeight",previous?.second ?: 0)
                })
            }
            for(orientation in requested?.let(::listOf) ?: listOf("portrait","landscape")) {
                currentOrientation=orientation;phase.set("$orientation-orient")
                settleFixtureOrientation(orientation)
                val config=main { Configuration(activity.resources.configuration) }
                check(orientation!="landscape" || config.screenHeightDp<500) { "Use a short landscape emulator viewport" }
                note("viewport",buildJsonObject { put("orientation",orientation);put("widthDp",config.screenWidthDp);put("heightDp",config.screenHeightDp) })
                if(!localMetricProbeComplete) {
                    val probe=request(2,"$orientation-local-only-residency")
                    settled(probe)
                    main {
                        val fragment=activity.supportFragmentManager.fragments.filterIsInstance<KingdomFragment>().single()
                        check(!fragment.performanceEnabled && !fragment.diagnosticsEnabled)
                        check(fragment.sceneObserver===observer && fragment.observerVisible)
                    }
                    await("local observer texture residency without samplers",15) {
                        last.get()?.revision==probe.revision.revision && (latestSnapshot.get()?.textureMiB ?: 0.0)>0.0
                    }
                    note("local-only-residency",buildJsonObject {
                        put("performanceSamplerEnabled",false);put("remoteDiagnosticsEnabled",false)
                        put("assetManagerTextureMiB",requireNotNull(latestSnapshot.get()).textureMiB)
                        put("estimateScope","AssetManager textures only; excludes direct ground, wall, font and stroke textures; not total GPU memory")
                        put("lastRenderedRevision",requireNotNull(last.get()).revision)
                    })
                    capture("$orientation-local-only-residency",expected=probe)
                    main { visible.value=false;priorGlFrame.set(0) };frameBoundary();frameBoundary()
                    await("probe surface detached",12) { main { surfaces(activity.window.decorView).none { it.isAttachedToWindow } } }
                    // Performance admission is fixed when the fragment is created. Recreate it,
                    // retaining no callback or queue witness that could certify the old surface.
                    main {
                        last.set(null);latestSnapshot.set(null);pendingWitness.set(null);priorGlFrame.set(0);glStart.set(0)
                        performanceEnabled.value=true;visible.value=true
                    }
                    settled(probe)
                    main { check(activity.supportFragmentManager.fragments.filterIsInstance<KingdomFragment>().single().performanceEnabled) }
                    localMetricProbeComplete=true
                }
                settled(request(2,"$orientation-first"));capture("$orientation-first")
                // Invalid synthetic frame key exercises the normal preparation error route; the
                // verified content directory is never changed. Keep the SceneSurface callback.
                val good=requireNotNull(chosen.value)
                val failureSeen=AtomicReference<String?>()
                main {
                    val fragment=activity.supportFragmentManager.fragments.filterIsInstance<KingdomFragment>().single()
                    val productionCallback=fragment.onPreparationError
                    fragment.onPreparationError={ message->productionCallback(message);if(message!=null) failureSeen.set(message) }
                    val invalid=good.copy(revision=good.revision.copy(revision="stage100-invalid-${++sequence}"),
                        actorFrames=good.actorFrames.mapValues { "fixture-missing-frame" })
                    fragment.renderer!!.updateBattle(invalid)
                }
                phase.set("$orientation-preparation-failure")
                await("recoverable preparation error",30) { failureSeen.get()!=null }
                check(last.get()?.revision==good.revision.revision) { "Failed replacement replaced the last rendered revision" }
                note("preparation-error",buildJsonObject { put("lastRenderedRevision",good.revision.revision);put("retainedScene",true) })
                frameBoundary();frameBoundary();capture("$orientation-retained-error");capture("$orientation-retry-overlay",window=true)
                main {
                    val fragment=activity.supportFragmentManager.fragments.filterIsInstance<KingdomFragment>().single()
                    // Same explicit operation as the production TRY AGAIN control.
                    fragment.renderer!!.updateBattle(requireNotNull(fragment.battle),fragment.audioToken)
                }
                // Last revision alone is insufficient here: require a new actual rendered callback.
                val retryStarted=System.currentTimeMillis()-started
                await("successful explicit retry",30) { synchronized(rows) { rows.any {
                    it["kind"]?.jsonPrimitive?.content=="rendered" &&
                    it["revision"]?.jsonPrimitive?.content==good.revision.revision &&
                    it.getValue("elapsedMs").jsonPrimitive.long>retryStarted
                } } }
                capture("$orientation-retried")
                val background=request(8,"$orientation-background-pending")
                pendingAction(background,"background-request")
                main { priorUiFrame=0;priorGlFrame.set(0);check(activity.moveTaskToBack(true)) }
                await("background",12) { main { !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) } }
                Thread.sleep(350)
                context.startActivity(Intent(context,MainActivity::class.java).putExtra("preview","base").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
                await("resume",12) { main { activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) } }
                priorGlFrame.set(0);note("resumed");settleFixtureOrientation(orientation,afterResume=true)
                settled(background);capture("$orientation-resumed")
                val navigation=request(16,"$orientation-navigation-pending")
                pendingAction(navigation,"navigation-away")
                main { visible.value=false;priorGlFrame.set(0) };frameBoundary();frameBoundary()
                await("surface detached",12) { main { surfaces(activity.window.decorView).none { it.isAttachedToWindow } } }
                // A revision rendered before detach cannot certify the replacement GL surface.
                main { last.set(null);visible.value=true;priorGlFrame.set(0) };settled(navigation);capture("$orientation-returned")
                val dense=request(90,"$orientation-dense")
                settled(dense)
                val activeStart=System.nanoTime()
                val extent=requireNotNull(last.get()).extent
                check(extent.eventEndTick>=220f) { "Dense fixture cannot cover the reported freeze window" }
                capture("$orientation-dense",expected=dense)
                // Never restart or seek this first pass: the 22s freeze and authored terminal
                // effects must be witnessed by actual rendered progression on one revision.
                for(tick in listOf(80f,130f,220f))
                    captureRenderedWindow(dense,"$orientation-dense-tick-${tick.toInt()}",tick,minOf(tick+5f,extent.visualEndTick))
                captureRenderedWindow(dense,"$orientation-dense-event-end",extent.eventEndTick,
                    minOf(extent.eventEndTick+5f,extent.visualEndTick))
                captureRenderedWindow(dense,"$orientation-dense-terminal-tail",extent.visualEndTick,extent.visualEndTick)
                note("first-dense-pass-complete",buildJsonObject {
                    put("revision",dense.revision.revision);put("eventEndTick",extent.eventEndTick);put("visualEndTick",extent.visualEndTick)
                    put("lastRenderedTick",requireNotNull(last.get()).playheadTick);put("uninterrupted",true)
                })
                // Existing PKWPerf needs sixty active GL seconds. Subsequent normal-speed replays
                // begin no earlier than forty seconds after the previous activation.
                val until=activeStart+TimeUnit.SECONDS.toNanos(65);var restart=activeStart+TimeUnit.SECONDS.toNanos(40)
                while(System.nanoTime()<until) {
                    if(System.nanoTime()>=restart) {
                        settled(request(90,"$orientation-steady-replay"));restart=System.nanoTime()+TimeUnit.SECONDS.toNanos(40)
                    }
                    Thread.sleep(250)
                }
                for(n in listOf(2,8,16,90)) request(n,"$orientation-replacement-burst")
                settled(requireNotNull(chosen.value));capture("$orientation-latest")
            }
            phase.set("collect-gl-frame-sampler")
            val command="logcat -d -v epoch --pid=${android.os.Process.myPid()} -s PKWPerf:I '*:S'"
            val text=ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command)).bufferedReader().use { reader->
                reader.lineSequence().take(2000).filter { line->line.trimStart().substringBefore(' ').toDoubleOrNull()?.let { it*1000>=started }==true }.joinToString("\n")
            }
            File(directory,"gl-frame-sampler.log").writeText(text)
            check(text.contains("\"averageFps\"")) { "No GL sampler report captured; do not infer performance from progress callbacks" }
            note("gl-sampler",buildJsonObject { put("path","gl-frame-sampler.log");put("sha256",hash(text.toByteArray())) })
            val audioState = main { requireNotNull(audio).snapshot() }
            check(audioState.getValue("decodedSamples").jsonPrimitive.int > 0 && audioState.getValue("outputWakes").jsonPrimitive.int > 0 &&
                audioState.getValue("peakVoicesAndLoops").jsonPrimitive.int > 1) {
                "No real Android audio decode/output work was observed"
            }
            note("audio-complete", audioState)
            status="captured-needs-visual-review";phase.set("complete")
        } catch(failure: Throwable) { status="failed";error=failure.message;throw failure }
        finally {
            runCatching { main { audio?.close(); audio = null; callback?.let { Choreographer.getInstance().removeFrameCallback(it) };priorUiFrame=0
                host?.let { it.requestedOrientation=originalOrientation;it.finishAndRemoveTask() } };cleanup=true }
                .onFailure { status="failed";error=listOfNotNull(error,"Cleanup did not complete: ${it.message}").joinToString("; ") }
            receipt()
            check(cleanup) { "Harness cleanup did not complete; inspect receipt" }
        }
    }
}
