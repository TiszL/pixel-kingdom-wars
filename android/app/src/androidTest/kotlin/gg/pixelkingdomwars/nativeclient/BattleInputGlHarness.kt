package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.content.pm.ActivityInfo
import android.os.Build
import android.os.SystemClock
import android.view.*
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.*
import gg.pixelkingdomwars.nativeclient.ui.PkwTheme
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import kotlinx.serialization.json.*
import java.io.File
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import kotlin.math.floor

/** Real Android contacts through Compose/SurfaceView/GL. Frozen presentation and synthetic pockets use
 * the actual pinned deployment policy: this certifies input plumbing, not production commands. */
internal object BattleInputGlHarness {
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun surfaces(v: View): List<SurfaceView> = when (v) {
        is SurfaceView -> listOf(v)
        is ViewGroup -> (0 until v.childCount).flatMap { surfaces(v.getChildAt(it)) }
        else -> emptyList()
    }
    fun verify(i: Instrumentation, orientation: String?): String {
        check(BuildConfig.DEBUG && BuildConfig.APPLICATION_ID == "gg.pixelkingdomwars.twa.debug" &&
            Build.HARDWARE == "ranchu" && BuildConfig.API_ORIGIN == "https://127.0.0.1:18443")
        require(orientation == null || orientation in setOf("portrait", "landscape"))
        val context = i.targetContext
        val directory = File(context.noBackupFilesDir, "battle-input-gl/${System.currentTimeMillis()}"); check(directory.mkdirs())
        val checks = mutableListOf<String>()
        val captures = mutableListOf<JsonObject>()
        var packIdentity: JsonObject? = null
        data class Placement(val x: Float, val y: Float, val legal: Boolean, val target: BattleDeploymentTarget? = null)
        val placements = Collections.synchronizedList(mutableListOf<Placement>())
        val snapshot = AtomicReference<LocalSceneSnapshot?>()
        val drawnRaid = AtomicReference<String?>()
        var activity: MainActivity? = null; var status = "running"; var failure: String? = null
        fun receipt() { File(directory, "receipt.json").writeText(buildJsonObject {
            put("status", status); put("failure", failure?.let(::JsonPrimitive) ?: JsonNull)
            put("orientation", orientation ?: "portrait"); put("physicalSeekerAcceptance", false)
            put("networkRequests", 0); put("commandSubmissions", 0); put("accountAccessRequested", false)
            put("scope", "Actual MotionEvent → Compose/SurfaceView → GL → current selection callback; frozen presentation only")
            put("pack", packIdentity ?: JsonNull)
            put("checks", JsonArray(checks.map(::JsonPrimitive)))
            put("captures", JsonArray(captures.toList()))
            put("placements", JsonArray(synchronized(placements) { placements.map { p -> buildJsonObject {
                put("x", p.x); put("y", p.y); put("legal", p.legal)
                p.target?.let { put("raidId",it.raidId);put("kind",it.kind);put("unit",it.unit) }
            } } }))
        }.toString()) }
        fun waitFor(label: String, timeout: Long = 45_000, predicate: () -> Boolean) {
            val end = SystemClock.uptimeMillis() + timeout
            while (SystemClock.uptimeMillis() < end) { if (predicate()) return; Thread.sleep(25) }
            error("Timed out: $label")
        }
        fun passed(label: String) { checks += label; receipt() }
        fun capture(name: String) {
            val bitmap = requireNotNull(i.uiAutomation.takeScreenshot())
            val file = File(directory, "$name.png")
            try { file.outputStream().use { check(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)) } }
            finally { bitmap.recycle() }
            captures += buildJsonObject { put("path",file.name);put("sha256",hash(file.readBytes())) }
            receipt()
        }
        try {
            val manifest = context.assets.open("native/manifest.json").use { it.readBytes() }
            val assets = BundledContent.prepare(context.noBackupFilesDir, manifest, debug = true,
                verifier = "battle-input-${BuildConfig.VERSION_CODE}") { context.assets.open("native/$it") }
            fun read(name: String) = Json.parseToJsonElement(File(assets, name).readText()).jsonObject
            val bytes = i.context.assets.open("battle-reliability/stage100-dragons-90.json").use { it.readBytes() }
            val pins = Json.parseToJsonElement(i.context.assets.open("battle-reliability/provenance.json").bufferedReader().use { it.readText() }).jsonObject
            val pin = pins.getValue("fixtures").jsonArray.map { it.jsonObject }.single { it.getValue("path").jsonPrimitive.content == "stage100-dragons-90.json" }
            check(hash(bytes) == pin.getValue("sha256").jsonPrimitive.content)
            val parity = Json.parseToJsonElement(i.context.assets.open("battle-reliability/battlefield.parity.json").bufferedReader().use { it.readText() }).jsonObject
            val catalogue = read("catalogue.json")
            val constants = catalogue.getValue("constants").jsonObject
            check(constants.getValue("RAID_BATTLEFIELD") == parity.getValue("policy")) { "Fresh pinned pack must carry the tested deployment policy" }
            val render = read("render-catalog.json")
            val visual = render.getValue("ground").jsonObject.getValue("currentVisual")
            packIdentity=buildJsonObject {
                put("manifestSha256",hash(manifest));put("sourceCommit",catalogue.getValue("sourceCommit"))
                put("simVersion",catalogue.getValue("simVersion"));put("battlefieldPolicy",parity.getValue("policy"));put("visualContext",visual)
            }
            val fixture = Json.parseToJsonElement(bytes.decodeToString()).jsonObject
            val source = JsonObject(fixture + mapOf("visualContext" to visual, "snapshot" to JsonObject(fixture.getValue("snapshot").jsonObject +
                ("battlefieldVersion" to parity.getValue("policy").jsonObject.getValue("currentVersion")))))
            val mapper = SceneMapper(catalogue,render)
            val battle = mapper.replayScene(source).copy(playing = false)
            check(battle.base.buildings.size == 306)
            val field = requireNotNull(battle.base.battlefield)
            val camera = constants.getValue("RAID_CAMERA").jsonObject
            val rules = constants.getValue("RAID_RULES").jsonObject
            val mode = BattleDeploymentMode("input-test:dragon", camera.getValue("holdConfirmMs").jsonPrimitive.long,
                rules.getValue("deployHoldRepeatMs").jsonPrimitive.long, camera.getValue("panThresholdPx").jsonPrimitive.float, true,
                target=BattleDeploymentTarget(battle.revision.raidId,"deploy","dragon"))
            val controls = SceneCameraControls(camera.getValue("zoomStep").jsonPrimitive.float)
            val selected = mutableStateOf<BattleDeploymentMode?>(mode)
            val scene = mutableStateOf(battle)
            val proofLabel = mutableStateOf("Offline deployment input proof")
            activity = i.startActivitySync(Intent(context, MainActivity::class.java).putExtra("preview", "base")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            val host = activity
            val observer = object : LocalSceneDiagnostics {
                override fun frameStarted() {}; override fun frameCompleted() {}
                override fun state(value: LocalSceneSnapshot) { snapshot.set(value) }
            }
            i.runOnMainSync { host.setContent { PkwTheme { SceneInputScope { CompositionLocalProvider(LocalSceneObserver provides observer) {
                Box(Modifier.fillMaxSize()) {
                    // The proof label and the 80 dp box are this harness's top chrome. Like production's safeBattleCameraInsets it
                    // is a camera inset, so the field clamp keeps the top field corners out from under it at the widest zoom.
                    SceneSurface(assets, scene.value.base, Modifier.fillMaxSize(), battle = scene.value,
                        deploymentMode = selected.value, cameraControls = controls,
                        cameraInsets = CameraInsets(top = (120 * host.resources.displayMetrics.density).toInt()),
                        onFrame = { drawnRaid.set(it.raidId) },
                        onGround = { x, y -> placements += Placement(x, y, true) },
                        onBattleGround = { target,x,y -> placements += Placement(x,y,true,target) },
                        onInvalidDeployment = { x, y -> placements += Placement(x, y, false) })
                    Box(Modifier.align(Alignment.TopEnd).size(80.dp).blockSceneInput().background(Color.DarkGray))
                    Text(proofLabel.value,color=Color.White,modifier=Modifier.align(Alignment.TopStart)
                        .blockSceneInput().background(Color.Black).padding(8.dp))
                }
            } } } } }
            val portrait = orientation != "landscape"
            val requested = if (portrait) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            waitFor("drawn battle and orientation") {
                i.runOnMainSync { if (host.requestedOrientation != requested) host.requestedOrientation = requested }
                snapshot.get()?.let { it.kind == LocalSceneKind.BATTLE && (it.viewportWidth < it.viewportHeight) == portrait && it.queueDepth == 0 } == true
            }
            var surface: SurfaceView? = null
            i.runOnMainSync { surface = surfaces(host.window.decorView).single() }
            val location = IntArray(2); i.runOnMainSync { requireNotNull(surface).getLocationOnScreen(location) }
            fun state() = requireNotNull(snapshot.get())
            fun screen(x: Float, y: Float): Pair<Float, Float> {
                val s = state()
                return (location[0] + s.viewportWidth / 2.0 + (x * battle.base.tilePixels - s.cameraX) / s.cameraZoom).toFloat() to
                    (location[1] + s.viewportHeight / 2.0 + (y * battle.base.tilePixels - s.cameraY) / s.cameraZoom).toFloat()
            }
            var downTime = 0L
            fun event(action: Int, points: List<Pair<Float, Float>>) {
                if (action == MotionEvent.ACTION_DOWN) downTime = SystemClock.uptimeMillis()
                val properties = points.indices.map { n -> MotionEvent.PointerProperties().apply { id = n; toolType = MotionEvent.TOOL_TYPE_FINGER } }.toTypedArray()
                val coordinates = points.map { p -> MotionEvent.PointerCoords().apply { x = p.first; y = p.second; pressure = 1f; size = 1f } }.toTypedArray()
                val e = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, points.size, properties, coordinates,
                    0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
                try { i.sendPointerSync(e) } finally { e.recycle() }
            }
            fun settle() { Thread.sleep(mode.repeatMs + 100); i.waitForIdleSync() }
            fun tap(point: Pair<Float, Float>) { event(MotionEvent.ACTION_DOWN, listOf(point)); Thread.sleep(35); event(MotionEvent.ACTION_UP, listOf(point)); settle() }
            fun reveal(x: Int, y: Int) {
                // D-185: zoom-out stops where the drawn field covers the surface, so a far tile is brought into view the way a
                // player does it, by panning (one-finger drags from the surface centre), before a real in-window contact.
                repeat(24) {
                    val p = screen(x + .5f, y + .5f); val s = state()
                    if (p.first > location[0] + 5 && p.first < location[0] + s.viewportWidth - 5 &&
                        p.second > location[1] + 5 && p.second < location[1] + s.viewportHeight - 5) return
                    val cx = location[0] + s.viewportWidth / 2f; val cy = location[1] + s.viewportHeight / 2f
                    val dx = (cx - p.first).coerceIn(-s.viewportWidth * .35f, s.viewportWidth * .35f)
                    val dy = (cy - p.second).coerceIn(-s.viewportHeight * .3f, s.viewportHeight * .3f)
                    event(MotionEvent.ACTION_DOWN, listOf(cx to cy))
                    for (n in 1..8) { event(MotionEvent.ACTION_MOVE, listOf((cx + dx * n / 8) to (cy + dy * n / 8))); Thread.sleep(16) }
                    event(MotionEvent.ACTION_UP, listOf((cx + dx) to (cy + dy))); settle()
                }
                error("Could not expose tile ($x,$y) by panning")
            }
            fun expectTile(x: Int, y: Int, legal: Boolean = true) {
                val expected=selected.value?.target
                val before = placements.size; tap(screen(x + .5f, y + .5f))
                check(placements.size == before + 1) { "Tile ($x,$y) produced ${placements.size - before} callbacks" }
                val p = placements.last(); check(p.legal == legal && (!legal || floor(p.x).toInt() == x && floor(p.y).toInt() == y)) { "Tile ($x,$y) mapped to $p" }
                if(legal) check(expected!=null && expected.raidId==scene.value.revision.raidId && p.target==expected) {
                    "Typed current troop/hero selection was lost: expected $expected, received ${p.target}"
                }
            }
            val entryZoom = state().cameraZoom
            reveal(15, -7); expectTile(15, -7); passed("reported exterior tile (15,-7) reaches legal callback")
            val interior = (field.claimMin until field.claimMax).flatMap { y -> (field.claimMin until field.claimMax).map { x -> x to y } }
                .first { field.legal(it.first, it.second) }
            expectTile(interior.first, interior.second); passed("empty claim interior deployment")
            val blocked = field.occupied.first { (x, y) -> field.nearest(x + .5f, y + .5f) == null }
            expectTile(blocked.first, blocked.second, false); passed("building interior yields immediate illegal feedback")
            i.runOnMainSync { repeat(32) { controls.zoomOut() } }; Thread.sleep(700)
            val widest = state(); val max = widest.cameraZoom
            // Backend D-185 (supersedes D-183), owner 2026-09-27: "they should be able to see full base art but they should not be able
            // to zoom out in a way to see past it". Where a realm kit is drawn, the widest view is its 98-tile field (REALM_KIT
            // fieldTiles) exactly covering the surface: the whole field on the long axis, nothing past it. Without a drawn
            // world the authored band stands (pre-D-183): the whole versioned field fits the unobscured short axis. (The snapshot
            // counts realm-kit draws only; a layered painting here would read as no drawn world and fail this check loudly.)
            val kitDrawn = widest.realmKitStillDraws + widest.realmKitChunkDraws + widest.realmKitTileQuads > 0
            val kitField = constants.getValue("REALM_KIT").jsonObject.getValue("fieldTiles").jsonPrimitive.int * battle.base.tilePixels
            val clearTop = (120 * host.resources.displayMetrics.density).toInt()
            val expected = if (kitDrawn) kitField / maxOf(widest.viewportWidth, widest.viewportHeight).toFloat()
                else (field.maximum - field.minimum) * battle.base.tilePixels / minOf(widest.viewportWidth, widest.viewportHeight - clearTop).toFloat()
            check(abs(expected - max) < .0005f * expected) {
                "zoom-out must stop at ${if (kitDrawn) "the drawn field covering the surface" else "the authored whole-field fit"}: zoom $max on ${widest.viewportWidth}x${widest.viewportHeight}, expected $expected"
            }
            passed(if (kitDrawn) "zoom-out stops where the drawn field covers the surface, never past it" else "zoom-out keeps the authored whole-field fit without a drawn world")
            // ...while deployment keeps the whole field (owner: "Keep whole field"): every far corner is reached by panning.
            for ((x, y) in listOf(field.minimum to field.minimum, field.maximum - 1 to field.minimum,
                field.minimum to field.maximum - 1, field.maximum - 1 to field.maximum - 1)) { reveal(x, y); expectTile(x, y) }
            passed("all four far battlefield corners reachable by panning at the widest zoom")
            val out = if (portrait) (field.claimMin to field.minimum - 2) else (field.minimum - 2 to field.claimMin)
            val edge = if (portrait) (field.claimMin to field.minimum) else (field.minimum to field.claimMin)
            reveal(edge.first, edge.second)
            // The field clamp keeps the unobscured view on the field, so off-field ground can appear only under the harness
            // chrome inset, where touches are blocked; its rejection without snapping inward is pinned on the JVM by
            // BattlefieldInputTest "nearby placement is deterministic visible and cannot snap an out of field touch".
            val outside = screen(out.first + .5f, out.second + .5f)
            val clear = (120 * host.resources.displayMetrics.density).toInt()
            check(!(outside.first > location[0] && outside.first < location[0] + state().viewportWidth &&
                outside.second > location[1] + clear && outside.second < location[1] + state().viewportHeight)) {
                "off-field tile $out entered the unobscured view at $outside"
            }
            passed("off-field ground never enters the unobscured view at the field edge")
            reveal(15, -7)
            val point = screen(15.5f, -6.5f)
            var count = placements.size
            event(MotionEvent.ACTION_DOWN, listOf(point)); Thread.sleep(mode.holdMs + mode.repeatMs * 4)
            event(MotionEvent.ACTION_UP, listOf(point)); settle()
            check(placements.size >= count + 2) { "Natural rendered hold did not repeat" }
            val released = placements.size; settle(); check(placements.size == released)
            passed("hold repeats at drawn frames and release adds no extra order")
            count = placements.size
            event(MotionEvent.ACTION_DOWN, listOf(point)); Thread.sleep(40)
            i.runOnMainSync { selected.value = mode.copy(identity = "changed-selection") }; Thread.sleep(80)
            event(MotionEvent.ACTION_UP, listOf(point)); settle(); check(placements.size == count)
            i.runOnMainSync { selected.value = mode }
            passed("selection changes cancel queued contacts")
            count = placements.size
            val hud = (location[0] + state().viewportWidth - 25f) to (location[1] + 25f)
            event(MotionEvent.ACTION_DOWN, listOf(hud)); Thread.sleep(mode.holdMs + mode.repeatMs)
            event(MotionEvent.ACTION_UP, listOf(hud)); settle(); check(placements.size == count)
            passed("painted HUD touch cannot deploy")
            val center = (location[0] + state().viewportWidth * .48f) to (location[1] + state().viewportHeight * .5f)
            val second = (center.first + 80f) to center.second
            count = placements.size
            event(MotionEvent.ACTION_DOWN, listOf(center))
            event(MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), listOf(center, second))
            repeat(8) { n -> event(MotionEvent.ACTION_MOVE, listOf(center, (second.first + (n + 1) * 15) to second.second)); Thread.sleep(25) }
            event(MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), listOf(center, (second.first + 120) to second.second))
            Thread.sleep(300); val afterPinch = state()
            repeat(8) { n -> event(MotionEvent.ACTION_MOVE, listOf((center.first + (n + 1) * 5) to (center.second + (n + 1) * 4))); Thread.sleep(25) }
            event(MotionEvent.ACTION_UP, listOf((center.first + 40) to (center.second + 32))); settle()
            val afterPan = state()
            check(placements.size == count && afterPinch.cameraZoom < max)
            check(abs(afterPan.cameraZoom - afterPinch.cameraZoom) < .001 &&
                (abs(afterPan.cameraX - afterPinch.cameraX) > 1 || abs(afterPan.cameraY - afterPinch.cameraY) > 1))
            passed("pinch followed by partial lift returns to one-finger pan without zoom or deployment")
            count = placements.size
            event(MotionEvent.ACTION_DOWN, listOf(center)); event(MotionEvent.ACTION_CANCEL, listOf(center)); settle()
            check(placements.size == count); passed("Android cancel produces no order")
            i.runOnMainSync { controls.fit() }; Thread.sleep(500)
            reveal(15, -7)
            expectTile(15, -7); passed("fresh tap recovers after pinch and cancellation")
            i.runOnMainSync { scene.value = battle.copy(revision = battle.revision.copy(revision = "input-revision-2")) }
            expectTile(15, -7); passed("same raid revision keeps the valid scene interactive")
            capture("dense-field-v3")

            // Frozen walls surround an isolated hole and a complete clearance pocket. The actual renderer
            // dispatches both troop and hero contacts through the same policy; no coordinator or POST is used.
            val side=constants.getValue("RAID_BATTLEFIELD").jsonObject.getValue("deploymentSquareTiles").jsonPrimitive.int
            val pocket=(10 until 10+side).flatMap { y -> (18 until 18+side).map { x -> x to y } }.toSet()
            val ring=buildSet {
                for(y in 8..12) for(x in 7..11) if(x!=9 || y!=10) add(x to y)
                for(y in 8 until 12+side) for(x in 16 until 20+side) if(x to y !in pocket) add(x to y)
            }
            val frozen=JsonObject(fixture.getValue("snapshot").jsonObject+buildJsonObject {
                put("buildings",JsonArray(ring.mapIndexed { n,(x,y)->buildJsonObject {
                    put("id","clearance-wall-$n");put("type","wall");put("level",1);put("tx",x);put("ty",y);put("fw",1);put("fh",1)
                } }))
                put("obstacles",buildJsonArray {});put("deploymentBlockers",buildJsonArray {})
            })
            fun clearanceScene(version:Int)=mapper.previewScene(buildJsonObject {
                put("stage",version);put("visualContext",visual)
                put("snapshot",JsonObject(frozen+("battlefieldVersion" to JsonPrimitive(version))))
            },catalogue.getValue("simVersion").jsonPrimitive.int)
            val v3=clearanceScene(3)
            val v3Mode=mode.copy(identity="clearance-troop",target=BattleDeploymentTarget(v3.revision.raidId,"deploy","dragon"))
            val heroMode=v3Mode.copy(identity="clearance-hero",repeat=false,target=BattleDeploymentTarget(v3.revision.raidId,"hero","vex"))
            i.runOnMainSync { selected.value=v3Mode;scene.value=v3;proofLabel.value="V3 · isolated tile must reject troops and heroes" }
            waitFor("v3 clearance fixture") { state().queueDepth==0 && drawnRaid.get()==v3.revision.raidId }
            Thread.sleep(500);reveal(9,10);expectTile(9,10,false)
            i.runOnMainSync { selected.value=heroMode }
            settle();expectTile(9,10,false)
            passed("v3 isolated hole rejects both troop and hero contact without snapping into a blocked neighbour")
            capture("v3-hole-rejected")
            i.runOnMainSync { proofLabel.value="V3 · all four clear-square corners accepted";selected.value=v3Mode }
            for((x,y) in pocket) { reveal(x,y);expectTile(x,y) }
            i.runOnMainSync { selected.value=heroMode }
            settle();expectTile(18,10)
            passed("v3 every clear-square corner reaches troop input and the same pocket accepts hero input")
            capture("v3-square-accepted")
            val v2=clearanceScene(2)
            i.runOnMainSync { scene.value=v2;selected.value=heroMode.copy(target=BattleDeploymentTarget(v2.revision.raidId,"hero","vex"))
                proofLabel.value="Archived V2 · single empty tile remains legal" }
            waitFor("v2 legacy fixture") { state().queueDepth==0 && drawnRaid.get()==v2.revision.raidId }
            Thread.sleep(500);reveal(9,10);expectTile(9,10)
            passed("archived v2 retains exact single-empty-tile admission on the same frozen walls")
            capture("v2-legacy-hole-accepted")
            status = "passed"; receipt(); return directory.absolutePath
        } catch (error: Throwable) { status = "failed"; failure = error.stackTraceToString(); receipt(); throw error }
        finally { activity?.let { host -> i.runOnMainSync { host.finishAndRemoveTask() } }; i.waitForIdleSync() }
    }
}
