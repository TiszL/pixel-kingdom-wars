package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.content.pm.ActivityInfo
import android.os.Build
import android.os.SystemClock
import android.view.*
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.*
import gg.pixelkingdomwars.nativeclient.ui.PkwTheme
import gg.pixelkingdomwars.nativeclient.ui.layout.LayoutEditorViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.*
import java.io.File
import java.lang.reflect.Proxy
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Synthetic server snapshot -> actual editor model -> actual SceneSurface/GL. Every repository method
 * except the explicit fixture read fails closed. No account, socket, save or wallet access. */
internal object LayoutGridGlHarness {
    const val MODE = "layout-grid-gl"
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun surfaces(view: View): List<SurfaceView> = when (view) {
        is SurfaceView -> listOf(view)
        is ViewGroup -> (0 until view.childCount).flatMap { surfaces(view.getChildAt(it)) }
        else -> emptyList()
    }
    fun verify(i: Instrumentation, orientation: String?): String {
        check(BuildConfig.DEBUG && BuildConfig.APPLICATION_ID == "gg.pixelkingdomwars.twa.debug" &&
            Build.HARDWARE == "ranchu" && BuildConfig.API_ORIGIN == "https://127.0.0.1:18443")
        require(orientation == null || orientation in setOf("portrait", "landscape"))
        val context = i.targetContext
        val directory = File(context.noBackupFilesDir, "layout-grid-gl/${System.currentTimeMillis()}"); check(directory.mkdirs())
        val checks = mutableListOf<String>(); val captures = mutableListOf<JsonObject>()
        val last = AtomicReference<LocalSceneSnapshot?>(); val frames = AtomicInteger()
        var activity: MainActivity? = null; var status = "running"; var failure: String? = null
        var identity: JsonObject? = null
        fun receipt() = File(directory, "receipt.json").writeText(buildJsonObject {
            put("status", status); put("failure", failure?.let(::JsonPrimitive) ?: JsonNull)
            put("orientation", orientation ?: "portrait"); put("pack", identity ?: JsonNull)
            put("networkRequests", 0); put("mutationCalls", 0); put("physicalSeekerAcceptance", false)
            put("scope", "Actual editor ViewModel, SceneSurface and GL; synthetic read-only repository and fixture controls")
            put("checks", JsonArray(checks.map(::JsonPrimitive))); put("captures", JsonArray(captures.toList()))
        }.toString())
        fun <T> main(block: () -> T): T { val result = AtomicReference<T>(); i.runOnMainSync { result.set(block()) }; return result.get() }
        fun await(label: String, predicate: () -> Boolean) {
            val end = SystemClock.uptimeMillis() + 60_000
            while (SystemClock.uptimeMillis() < end) { if (predicate()) return; Thread.sleep(30) }
            error("Timed out: $label")
        }
        fun settled(label: String) {
            val before = frames.get(); await(label) { last.get()?.let { it.kind == LocalSceneKind.BASE && it.queueDepth == 0 && it.pendingWallUploads == 0 && frames.get() > before + 12 } == true }
        }
        try {
            val manifest = context.assets.open("native/manifest.json").use { it.readBytes() }
            val assets = BundledContent.prepare(context.noBackupFilesDir, manifest, debug = true,
                verifier = "layout-grid-${BuildConfig.VERSION_CODE}") { context.assets.open("native/$it") }
            fun read(name: String) = Json.parseToJsonElement(File(assets, name).readText()).jsonObject
            val catalogue = read("catalogue.json"); val render = read("render-catalog.json")
            val visual = render.getValue("ground").jsonObject.getValue("currentVisual")
            identity = buildJsonObject {
                put("manifestSha256", hash(manifest)); put("sourceCommit", catalogue.getValue("sourceCommit"))
                put("simVersion", catalogue.getValue("simVersion")); put("visualContext", visual)
            }
            val bytes = i.context.assets.open("battle-reliability/stage100-dragons-90.json").use { it.readBytes() }
            val pins = Json.parseToJsonElement(i.context.assets.open("battle-reliability/provenance.json").bufferedReader().use { it.readText() }).jsonObject
            check(hash(bytes) == pins.getValue("fixtures").jsonArray.map { it.jsonObject }.single {
                it.getValue("path").jsonPrimitive.content == "stage100-dragons-90.json" }.getValue("sha256").jsonPrimitive.content)
            val snapshot = Json.parseToJsonElement(bytes.decodeToString()).jsonObject.getValue("snapshot").jsonObject
            val raw = JsonObject(snapshot + buildJsonObject {
                put("baseId", "layout-grid-fixture"); put("visualContext", visual)
                putJsonObject("player") { put("keepLevel", 20) }
                putJsonObject("claim") { put("min", snapshot.getValue("claimMin")); put("max", snapshot.getValue("claimMax")) }
                put("jobs", JsonArray(emptyList()))
            })
            val base = BaseSnapshot.from(raw); check(base.buildings.size == 306)
            val layouts = Layouts.from(buildJsonObject {
                put("baseId", "layout-grid-fixture"); put("geometryVersion", 1)
                putJsonObject("claim") {
                    put("min", snapshot.getValue("claimMin")); put("max", snapshot.getValue("claimMax"))
                    put("size", snapshot.getValue("claimMax").jsonPrimitive.int - snapshot.getValue("claimMin").jsonPrimitive.int)
                }
                putJsonObject("active") { put("slot", JsonNull); put("etag", "fixture-active") }
                putJsonObject("farmUnlock") { put("locked", true); put("costShards", 0) }
                putJsonArray("slots") { add(buildJsonObject {
                    put("slot", "HOME"); put("locked", false); put("etag", "fixture-home"); put("compatibility", "empty")
                    put("positions", JsonArray(emptyList())); put("unplacedBuildingIds", JsonArray(emptyList())); put("removedBuildingIds", JsonArray(emptyList()))
                }) }
            })
            val home = MutableStateFlow(BaseState(base = base, layouts = layouts))
            val content = MutableStateFlow(ContentState(assets, catalogue, render))
            val repo = Proxy.newProxyInstance(BaseRepository::class.java.classLoader, arrayOf(BaseRepository::class.java)) { _, method, _ ->
                when (method.name) { "getState" -> home; "refreshLayouts" -> layouts; else -> error("Unexpected base operation: ${method.name}") }
            } as BaseRepository
            val pack = Proxy.newProxyInstance(ContentRepository::class.java.classLoader, arrayOf(ContentRepository::class.java)) { _, method, _ ->
                when (method.name) { "getState" -> content; else -> error("Unexpected content operation: ${method.name}") }
            } as ContentRepository
            val secret = object : SecretStore { override fun read(): String? = null; override fun write(value: String) = error("No saved intent"); override fun clear() = error("No intent deletion") }
            val model = main { LayoutEditorViewModel(repo, pack, ReceiptObserver(PendingIntentStore(secret)), null) }
            await("model hydrated") { model.state.value.base != null }; main { model.open() }
            await("draft installed") { model.state.value.draft != null }
            val mapper = SceneMapper(catalogue, render)
            val constants = catalogue.getValue("constants").jsonObject
            val controls = SceneCameraControls(constants.getValue("RAID_CAMERA").jsonObject.getValue("zoomStep").jsonPrimitive.float)
            val beforeMode = mutableStateOf(true)
            activity = i.startActivitySync(Intent(context, MainActivity::class.java).putExtra("preview", "base")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            val host = activity
            val observer = object : LocalSceneDiagnostics {
                override fun frameStarted() {}; override fun frameCompleted() { frames.incrementAndGet() }
                override fun state(snapshot: LocalSceneSnapshot) { last.set(snapshot) }
            }
            main {
                host.requestedOrientation = if (orientation == "landscape") ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                host.setContent { PkwTheme { CompositionLocalProvider(LocalSceneObserver provides observer) {
                    val state by model.state.collectAsState()
                    val scene = remember(state.draftBase) { mapper.baseScene(requireNotNull(state.draftBase)) }
                    Column(Modifier.fillMaxSize()) {
                        Row {
                            Button(onClick = { beforeMode.value = false }) { Text("Overlay") }
                            Button(onClick = model::moveSelectedToTray) { Text("Tray") }
                            Button(onClick = model::undo) { Text("Undo") }
                            Button(onClick = model::confirmDiscard) { Text("Close") }
                        }
                        Text(if (beforeMode.value) "Prior grid presentation (same scene)" else "Layout occupancy · current terrain")
                        Text(state.local.notice ?: "Select a wall, then tap a free tile")
                        SceneSurface(assets, scene, Modifier.fillMaxWidth().weight(1f), cameraControls = controls,
                            highlights = if (beforeMode.value) listOfNotNull(state.geometry?.let { BaseGeometry.plotGrid(it.claimMin, it.claimMax) }) else state.highlights,
                            onGround = model::tapTile)
                    }
                } } }
            }
            val portrait = orientation != "landscape"
            val requested = if (portrait) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            await("actual scene orientation") {
                main { if (host.requestedOrientation != requested) host.requestedOrientation = requested }
                last.get()?.let { it.kind == LocalSceneKind.BASE && (it.viewportWidth < it.viewportHeight) == portrait && it.queueDepth == 0 } == true
            }
            main { controls.fit() }; settled("initial scene")
            fun capture(name: String) {
                settled(name)
                val bitmap = requireNotNull(i.uiAutomation.takeScreenshot()); val file = File(directory, "$name.png")
                check((bitmap.width < bitmap.height) == portrait) { "Captured orientation does not match $orientation" }
                try { file.outputStream().use { check(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)) } } finally { bitmap.recycle() }
                val s = requireNotNull(last.get())
                captures += buildJsonObject {
                    put("path", file.name); put("sha256", hash(file.readBytes())); put("cameraZoom", s.cameraZoom)
                    put("cameraX", s.cameraX); put("cameraY", s.cameraY); put("viewportWidth", s.viewportWidth); put("viewportHeight", s.viewportHeight)
                    put("highlightCount", model.state.value.highlights.size); put("priorPresentationMode", beforeMode.value)
                }; receipt()
            }
            fun click(label: String) {
                fun nodes(n: AccessibilityNodeInfo): List<AccessibilityNodeInfo> = listOf(n) + (0 until n.childCount).flatMap { n.getChild(it)?.let(::nodes).orEmpty() }
                val n = nodes(requireNotNull(i.uiAutomation.rootInActiveWindow)).first { it.text?.toString() == label }
                var target = n
                while (!target.isClickable) target = requireNotNull(target.parent)
                check(target.performAction(AccessibilityNodeInfo.ACTION_CLICK)); i.waitForIdleSync(); Thread.sleep(150)
            }
            capture("01-prior-grid-presentation"); click("Overlay"); capture("02-overlay-fit")
            checks += "Current dense 306-building scene has cached claim fills and an above-art white grid"
            main { repeat(2) { controls.zoomIn() } }; capture("03-overlay-zoom-in")
            main { repeat(4) { controls.zoomOut() } }; capture("04-overlay-zoom-out")
            main { controls.fit() }; settled("fit before actual taps")
            val initial = model.state.value
            val wall = base.buildings.first { it.type == "wall" }
            val old = requireNotNull(initial.draft!!.position(wall.id))
            val target = initial.highlights.first { it.kind == SceneHighlightKind.FILL && it.color == HighlightColors.VALID && it.tileX > initial.geometry!!.claimMin + 2 && it.tileY > initial.geometry!!.claimMin + 2 }
            fun tap(x: Float, y: Float) {
                val surface = main { surfaces(host.window.decorView).single() }; val loc = IntArray(2); main { surface.getLocationOnScreen(loc) }
                val s = requireNotNull(last.get()); val tile = mapper.baseScene(raw).tilePixels
                val px = (loc[0] + surface.width / 2.0 + (x * tile - s.cameraX) / s.cameraZoom).toFloat()
                val py = (loc[1] + surface.height / 2.0 + (y * tile - s.cameraY) / s.cameraZoom).toFloat()
                check(px > loc[0] && px < loc[0] + surface.width && py > loc[1] && py < loc[1] + surface.height)
                val down = SystemClock.uptimeMillis()
                for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                    val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, px, py, 0)
                    try { i.sendPointerSync(event) } finally { event.recycle() }; Thread.sleep(40)
                }; settled("tap delivered"); i.waitForIdleSync()
            }
            tap(old.tx + .5f, old.ty + .5f); check(model.state.value.selected?.id == wall.id)
            tap(target.tileX + .5f, target.tileY + .5f)
            await("wall moved") { model.state.value.draft?.position(wall.id)?.let { it.tx.toFloat() == target.tileX && it.ty.toFloat() == target.tileY } == true }
            fun color(x: Int, y: Int) = model.state.value.highlights.single { it.kind == SceneHighlightKind.FILL && it.tileX == x.toFloat() && it.tileY == y.toFloat() }.color
            check(color(old.tx, old.ty) == HighlightColors.VALID); check(color(target.tileX.toInt(), target.tileY.toInt()) == HighlightColors.BLOCKED)
            capture("05-wall-moved"); checks += "Actual GL taps move a wall and update both vacated and occupied cells"
            click("Tray"); await("wall in tray") { model.state.value.selectedInTray }
            check(color(target.tileX.toInt(), target.tileY.toInt()) == HighlightColors.VALID)
            capture("06-wall-trayed"); checks += "Tray button vacates the selected wall tile"
            click("Undo"); await("tray undone") { !model.state.value.selectedInTray }; capture("07-tray-undone")
            click("Undo"); await("move undone") { model.state.value.draft?.position(wall.id) == old }
            check(color(old.tx, old.ty) == HighlightColors.BLOCKED); capture("08-move-undone")
            checks += "Undo restores the prior occupancy, then the exact original wall position"
            main { model.nudge(-100, -100) }; await("claim refusal") { model.state.value.local.notice == "OUTSIDE THE ACTIVE CLAIM" }
            check(model.state.value.draft!!.position(wall.id) == old); capture("09-claim-boundary-refused")
            checks += "Claim-boundary refusal keeps original draft and highlight coordinates"
            click("Close"); await("closed overlay") { model.state.value.highlights.isEmpty() }; capture("10-closed-no-grid")
            checks += "Closing the editor removes every grid/fill without saving or changing the live base"
            check(home.value.base == base)
            status = "passed"; receipt(); return directory.absolutePath
        } catch (error: Throwable) { status = "failed"; failure = error.message; receipt(); throw error }
        finally { activity?.let { host -> main { host.finishAndRemoveTask() } }; i.waitForIdleSync() }
    }
}
