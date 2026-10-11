package gg.pixelkingdomwars.nativeclient.scene.world

import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import androidx.fragment.app.FragmentActivity
import com.badlogic.gdx.backends.android.AndroidFragmentApplication
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeFiles
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmBases
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmEngineWiring
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmGrid
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLoader
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.DecorTables
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.DemoBases
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntent
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldTarget
import gg.pixelkingdomwars.nativeclient.scene.WorldContextFactory
import gg.pixelkingdomwars.nativeclient.ui.world.WorldHudBridge
import gg.pixelkingdomwars.nativeclient.ui.world.WorldHudEvent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.security.MessageDigest

/**
 * Debug-only smoke host for the N1/N2 GL30 world (lead integration, guarded SwiftShader emulator only). The World tab
 * needs a signed-in account and server-admitted world content, which the guarded emulator does not have, so this
 * activity mounts the SAME [WorldEngineFragment] and [WorldEngineHost] the World tab mounts, with:
 * - the debug world bundle (`world/`, hash-checked against `world/content.json`, as in the World tab);
 * - the client pack's globe masks from `files/world-pack/` (pushed by the smoke script from the pinned pack), each file
 *   checked against the APK's own pinned `native/manifest.json` before use;
 * - the realm-map numbers from the APK's bundled `native/catalogue.json`;
 * - no exploration-island art (the chain groups are server-delivered), and no Compose HUD (the HUD needs the account's
 *   `WorldViewModel`): a scripted intent sequence stands in for the HUD's taps.
 *
 *     adb shell am start -n gg.pixelkingdomwars.twa.debug/gg.pixelkingdomwars.nativeclient.scene.world.WorldEngineSmokeActivity --es realm crownlands
 *
 * It logs `[world-smoke] step=<name>` under `PKWWorldGL` at each stage so the smoke script can take a screenshot at each:
 * globe, selected, realm, then the N3 steps — zoomout (the realm pinched to its minimum: the painting in its own sea, never
 * a cut rectangle), map (FlyTo a kingdom at the MAP select distance), true (FlyTo it at the TRUE "My base" distance),
 * base (the kingdom selected) — then minimap, back, done. With no server feed the kingdoms are the web demo population
 * ([DemoBases], NL's debug fallback), offered as the HUD would offer the bounded viewport read. It touches no account,
 * wallet, session or network.
 */
@SuppressLint("SetTextI18n") // a debug-only English readout, never player-facing
class WorldEngineSmokeActivity : FragmentActivity(), AndroidFragmentApplication.Callbacks {
    override fun exit() { runOnUiThread { finish() } }

    private val ui = Handler(Looper.getMainLooper())
    private val bridge = WorldHudBridge()
    private lateinit var text: TextView
    private var realm = "crownlands"
    private var step = "start"
    private var readyAt = 0L
    /** The demo kingdoms (N3 debug fallback) and the one the script visits (yours when there is one). */
    @Volatile private var demo: WorldBases? = null
    private var visit = -1

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(null) // never restore a half-run smoke
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        realm = intent.getStringExtra("realm") ?: realm
        val root = FrameLayout(this)
        val container = FrameLayout(this).apply { id = View.generateViewId() }
        text = TextView(this).apply {
            setTextColor(Color.rgb(232, 224, 200)); setBackgroundColor(Color.argb(160, 0, 0, 0)); typeface = Typeface.MONOSPACE; textSize = 10f
            setPadding(8, 8, 8, 8)
        }
        root.addView(container, FrameLayout.LayoutParams(-1, -1))
        root.addView(text, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        setContentView(root)
        val fragment = WorldEngineFragment()
        fragment.bind(bridge) { line -> if (line != null) text.text = "smoke $realm · $step\n$line" }
        fragment.inputs = { inputs() }
        bridge.listen(::event)
        supportFragmentManager.beginTransaction().add(container.id, fragment, "world-engine-smoke").commitNow()
        Thread({ demo = demoBases() }, "world-smoke-demo").apply { isDaemon = true }.start()
        poll()
    }

    /** NL's debug fallback: the web demo population of [realm] on the catalog's deeds (small verified reads, no chart). */
    private fun demoBases(): WorldBases? = runCatching {
        val config = RealmEngineWiring.config()
        val meta = RealmLoader(AssetWorldFiles(assets), BitmapRealmImages).meta(realm)
        val grid = RealmGrid(meta.x0, meta.y0, meta.cols, meta.rows, config.deedDeg)
        val deeds = realmCatalog(assets).mask(realm, grid, config.deedThisRealm, config.deedOtherRealm)
        DemoBases(DecorTables.load()).snapshot(realm, grid, deeds, config.deedThisRealm, 1L)
    }.onFailure { log("demo bases: ${it.javaClass.simpleName}: ${it.message}") }.getOrNull()

    private fun inputs(): WorldHostInputs? {
        val pack = VerifiedPackDir(File(filesDir, "world-pack"), pins())
        val catalogue = runCatching { Json.parseToJsonElement(assets.open("native/catalogue.json").use { String(it.readBytes(), Charsets.UTF_8) }).jsonObject }
            .onFailure { log("catalogue: ${it.message}") }.getOrNull()
        return WorldHostInputs(assets, AssetWorldFiles(assets), pack, null, realmCatalogueNumbers(catalogue), resources.displayMetrics.density.toDouble())
    }

    /** The APK's own pinned client-pack manifest (`native/manifest.json`): path → sha256 for the globe files. */
    private fun pins(): Map<String, String> = runCatching {
        val m = Json.parseToJsonElement(assets.open("native/manifest.json").use { String(it.readBytes(), Charsets.UTF_8) }).jsonObject
        m.getValue("files").jsonArray.map { it.jsonObject }.filter { it.getValue("path").jsonPrimitive.content.startsWith("atlas/fantasy/globe/") }
            .associate { it.getValue("path").jsonPrimitive.content to it.getValue("sha256").jsonPrimitive.content }
    }.getOrElse { log("manifest: ${it.message}"); emptyMap() }

    private fun event(e: WorldHudEvent) {
        log("event $e")
        when (e) {
            is WorldHudEvent.Dived -> later(6_000) { mark("realm"); zoomOutStep() }
            is WorldHudEvent.Left -> later(5_000) { mark("back"); later(1_000) { mark("done") } }
            is WorldHudEvent.DiveFailed -> mark("dive-failed")
            else -> Unit
        }
    }

    /** The scripted HUD: home globe → select the realm (outline) → enter its map when ready → minimap tap → leave. */
    private fun poll() {
        if (bridge.failure != null) { mark("failed ${bridge.failure}"); return }
        if (!bridge.ready) { ui.postDelayed(::poll, 250); return }
        if (readyAt == 0L) {
            readyAt = System.currentTimeMillis()
            later(5_000) { mark("globe"); select() }
        }
    }

    private fun select() {
        demo?.let { d ->
            // the HUD's bounded viewport read offers the realm's kingdoms; the engine keeps them until its grid exists
            bridge.offer(WorldIntent.SetBases(d))
            visit = (0 until d.size).firstOrNull { d.flags[it] and RealmBases.FLAG_MINE != 0 && d.deedX[it] >= 0 } ?: (0 until d.size).firstOrNull { d.deedX[it] >= 0 } ?: -1
            log("demo bases ${d.size}, visiting #$visit" + (if (visit >= 0) " at ${d.deedX[visit]},${d.deedY[visit]} level ${d.level[visit]}" else ""))
        } ?: log("no demo bases: the realm shows the core's stand-in dots only")
        bridge.offer(WorldIntent.Select(WorldTarget.Realm(realm))); bridge.offer(WorldIntent.FlyTo(WorldTarget.Realm(realm)))
        later(6_000) { mark("selected"); waitReady(0) }
    }

    private fun waitReady(waited: Long) {
        val r = bridge.diveReadiness
        if ((r != null && r.first == realm && r.second >= 1f) || waited > 20_000) {
            log("dive readiness $r after $waited ms"); bridge.offer(WorldIntent.Dive(realm)); return
        }
        later(500) { waitReady(waited + 500) }
    }

    /** The owner's "cut picture": zoom out to the realm's minimum (the camera clamp, 0.6 × fit), then the detail bands. */
    private fun zoomOutStep() {
        bridge.controls?.zoom(-3)
        later(8_000) { mark("zoomout"); bandStep(MAP_D, "map", MAP_WAIT_MS) { bandStep(TRUE_D, "true", TRUE_WAIT_MS) { baseStep() } } }
    }

    /** FlyTo the visited kingdom at [d]; the engine holds the flight at a band gate (the cue says held) until that band
     *  is rehearsed, then the detail settles for [SETTLE_MS] before the screenshot. */
    private fun bandStep(d: Double, name: String, maxMs: Long, next: () -> Unit) {
        val target = target() ?: run { log("no kingdom to visit: $name skipped"); next(); return }
        bridge.offer(WorldIntent.FlyTo(target, d))
        waitBand(name, 0L, maxMs, next)
    }

    private fun waitBand(name: String, waited: Long, maxMs: Long, next: () -> Unit) {
        val cue = bridge.bandGate
        if ((waited >= MIN_BAND_MS && (cue == null || !cue.held)) || waited >= maxMs) {
            log("band cue $cue after $waited ms${if (waited >= maxMs) " (TIMEOUT)" else ""}")
            later(SETTLE_MS) { mark(name); next() }
            return
        }
        later(1_000) { waitBand(name, waited + 1_000, maxMs, next) }
    }

    private fun baseStep() {
        val target = target()
        if (target != null) bridge.offer(WorldIntent.Select(target))
        later(4_000) { mark("base"); minimapStep() }
    }

    private fun target(): WorldTarget.Deed? { val d = demo ?: return null; return if (visit < 0) null else WorldTarget.Deed(realm, d.deedX[visit], d.deedY[visit]) }

    private fun minimapStep() {
        val w = text.rootView.width.toFloat(); val h = text.rootView.height.toFloat()
        val side = w * 0.36f
        bridge.controls?.minimapRect(floatArrayOf(w - side - 24f, h * 0.55f, side, side))
        later(3_000) {
            mark("minimap")
            later(2_000) { bridge.offer(WorldIntent.Leave) }
        }
    }

    private fun mark(name: String) { step = name; log("step=$name") }
    private fun later(ms: Long, block: () -> Unit) { ui.postDelayed(block, ms) }
    private fun log(line: String) = Log.i(WorldContextFactory.TAG, "[world-smoke] $line")

    override fun onDestroy() { ui.removeCallbacksAndMessages(null); bridge.listen(null); super.onDestroy() }

    private companion object {
        /** NU's HudBands.SELECT_D (MAP) and MY_BASE_D (TRUE), device px per deed. */
        const val MAP_D = 700.0
        const val TRUE_D = 1400.0
        /** SwiftShader builds and rehearses the MAP/TRUE programs on the CPU: generous bounds, never timing evidence. */
        const val MIN_BAND_MS = 15_000L
        const val MAP_WAIT_MS = 180_000L
        const val TRUE_WAIT_MS = 240_000L
        const val SETTLE_MS = 12_000L
    }
}

/** A directory of client-pack files, each read checked against the pinned manifest's sha256 (unpinned paths refused). */
private class VerifiedPackDir(private val root: File, private val pins: Map<String, String>) : GlobeFiles {
    override fun read(path: String): ByteArray? {
        val want = pins[path] ?: return null
        val f = File(root, path)
        if (!f.isFile) return null
        val bytes = f.readBytes()
        val have = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        return if (have == want) bytes else null
    }
    override fun expectedSha256(path: String): String? = pins[path]
}
