package gg.pixelkingdomwars.nativeclient.scene.probe

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.view.Choreographer
import android.view.LayoutInflater
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.fragment.app.FragmentActivity
import com.badlogic.gdx.backends.android.AndroidApplicationConfiguration
import com.badlogic.gdx.backends.android.AndroidFragmentApplication
import gg.pixelkingdomwars.nativeclient.renderer.world.InputScale
import gg.pixelkingdomwars.nativeclient.scene.FramePacer
import gg.pixelkingdomwars.nativeclient.scene.WorldApplicationFragment
import gg.pixelkingdomwars.nativeclient.scene.WorldContextFactory
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File

/**
 * The N0 GPU device probe (GLOBE-NATIVE-PLAN §8.3), debug builds only. The owner opens it once on the Seeker over USB:
 *
 *     adb shell am start -n gg.pixelkingdomwars.twa.debug/gg.pixelkingdomwars.nativeclient.scene.probe.DeviceProbeActivity
 *
 * It runs by itself for about a minute (keep the phone still and the screen on), shows its progress, and near the end
 * asks for one thing: a banner says DRAG, and the owner drags one finger around the screen for 5 seconds (pacing under
 * touch; after 30 s without a touch it moves on and says so). It writes `world-probe.json` to the app's external
 * files directory
 * (`adb shell cat /sdcard/Android/data/gg.pixelkingdomwars.twa.debug/files/world-probe.json`) and to logcat
 * (`adb logcat -s PKWProbe`, `[world-probe] i/n` chunks). It touches no account, wallet, session or network.
 */
@SuppressLint("SetTextI18n") // a debug-only English readout for the owner's USB session, never player-facing
class DeviceProbeActivity : FragmentActivity(), AndroidFragmentApplication.Callbacks {
    /** libGDX's `AndroidFragmentApplication.onAttach` refuses a host without these callbacks (found on the first guarded
     *  emulator run: the probe crashed at launch). `exit()` is libGDX's `Gdx.app.exit()`, which the probe never calls. */
    override fun exit() { runOnUiThread { finish() } }

    private lateinit var text: TextView
    private lateinit var scroll: ScrollView
    private lateinit var banner: TextView
    private val ui = Handler(Looper.getMainLooper())
    private val stalls = UiStallWatch()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(null) // never restore a half-run probe
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val root = FrameLayout(this)
        val container = FrameLayout(this).apply { id = View.generateViewId() }
        root.addView(container, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        text = TextView(this).apply {
            typeface = Typeface.MONOSPACE; textSize = 10f; setTextColor(Color.WHITE)
            setBackgroundColor(0xAA000000.toInt()); setPadding(24, 96, 24, 24)
            text = "World GPU probe: starting…\n"
        }
        scroll = ScrollView(this).apply { addView(text) }
        root.addView(scroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        // Not clickable, and only as tall as its text: a finger anywhere below it reaches the GL surface.
        banner = TextView(this).apply {
            typeface = Typeface.MONOSPACE; textSize = 22f; setTextColor(Color.BLACK); setBackgroundColor(0xFFFFD54F.toInt())
            setPadding(32, 96, 32, 32); visibility = View.GONE
            text = "DRAG one finger around the screen for 5 seconds"
        }
        root.addView(banner, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        setContentView(root)
        supportFragmentManager.beginTransaction().add(container.id, DeviceProbeFragment()).commitNow()
        stalls.start()
    }

    override fun onDestroy() { stalls.stop(); super.onDestroy() }

    fun status(line: String) { ui.post { text.append(line); text.append("\n") } }

    /** Any thread. The readout grows over the surface and a ScrollView would take the drag, so it hides while the
     *  probe measures pacing under touch. */
    fun touchMode(on: Boolean) {
        ui.post {
            scroll.visibility = if (on) View.GONE else View.VISIBLE
            banner.visibility = if (on) View.VISIBLE else View.GONE
        }
    }

    /** UI thread: the GL thread finished; add the UI-side sections, write the report, show the summary. */
    fun complete(report: ProbeReport) {
        report.put("thermalEnd", thermal(this))
        report.put("uiStalls", stalls.json())
        stalls.stop()
        val json = report.json().toString()
        val missing = report.missing()
        ProbeReport.chunks(json).forEach { Log.i(ProbeReport.TAG, it) }
        val written = runCatching {
            val dir = getExternalFilesDir(null) ?: filesDir
            File(dir, "world-probe.json").apply { writeText(json) }.absolutePath
        }.getOrElse { "not written: ${it.message}" }
        text.append("\nDONE. Report: $written\n")
        text.append(if (missing.isEmpty()) "All sections present.\n" else "MISSING sections: ${missing.joinToString()}\n")
        text.append("\n$json\n")
    }

    companion object {
        fun thermal(context: Context): JsonObject {
            val power = context.getSystemService(PowerManager::class.java)
            val status = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) power?.currentThermalStatus else null
            val headroom = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) power?.getThermalHeadroom(10) else null
            return JsonObject(mapOf("status" to JsonPrimitive(status), "headroom10s" to JsonPrimitive(headroom?.takeIf { it.isFinite() })))
        }

        fun display(activity: FragmentActivity): JsonObject {
            val metrics = activity.resources.displayMetrics
            @Suppress("DEPRECATION") val display = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) activity.display else activity.windowManager.defaultDisplay
            val real = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) activity.windowManager.maximumWindowMetrics.bounds.let { intArrayOf(it.width(), it.height()) }
                else android.util.DisplayMetrics().also { @Suppress("DEPRECATION") display?.getRealMetrics(it) }.let { intArrayOf(it.widthPixels, it.heightPixels) }
            val modes = display?.supportedModes?.map { JsonPrimitive("${it.physicalWidth}x${it.physicalHeight}@${it.refreshRate}") }.orEmpty()
            return JsonObject(mapOf(
                "realWidth" to JsonPrimitive(real[0]), "realHeight" to JsonPrimitive(real[1]),
                "density" to JsonPrimitive(metrics.density), "densityDpi" to JsonPrimitive(metrics.densityDpi),
                "xdpi" to JsonPrimitive(metrics.xdpi), "ydpi" to JsonPrimitive(metrics.ydpi),
                "refreshRate" to JsonPrimitive(display?.refreshRate),
                "mode" to JsonPrimitive(display?.mode?.let { "${it.physicalWidth}x${it.physicalHeight}@${it.refreshRate}" }),
                "supportedModes" to JsonArray(modes),
            ))
        }
    }
}

/** The probe's surface: the world surface stack (WorldGraphics, robust context, pacer) on a GL30 context, with the
 *  buffer fixed to the engine's dpr-2 size (plan §5.5) so the probe can report whether `setFixedSize` holds. */
class DeviceProbeFragment : WorldApplicationFragment() {
    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, state: Bundle?): View {
        val activity = requireActivity() as DeviceProbeActivity
        val log: (String) -> Unit = { Log.i(ProbeReport.TAG, it) }
        val pacer = FramePacer(activity, 60, log)
        val display = DeviceProbeActivity.display(activity)
        val density = activity.resources.displayMetrics.density.toDouble()
        val realW = (display["realWidth"] as JsonPrimitive).content.toInt(); val realH = (display["realHeight"] as JsonPrimitive).content.toInt()
        val fixed = intArrayOf(InputScale.fixedBufferSide(realW, density), InputScale.fixedBufferSide(realH, density))
        val probe = DeviceProbe(activity.applicationContext, { worldGraphics }, pacer, activity::status,
            { report -> activity.runOnUiThread { activity.complete(report) } },
            { delayMs, block -> Handler(Looper.getMainLooper()).postDelayed(block, delayMs) },
            activity::touchMode, display, DeviceProbeActivity.thermal(activity), fixed)
        val config = AndroidApplicationConfiguration().apply {
            useAccelerometer = false; useCompass = false; useGyroscope = false; useImmersiveMode = false; numSamples = 0; useGL30 = true
        }
        val view = initializeWorldView(probe, config, WorldContextFactory(3, log), pacer)
        (view as SurfaceView).holder.setFixedSize(fixed[0], fixed[1])
        return view
    }
}

/** UI-thread stalls while the probe runs (plan §1.2: none > 50 ms). Debug only: it wakes the UI thread every vsync. */
class UiStallWatch {
    private var last = 0L
    private var running = false
    private var frames = 0
    private var over50 = 0
    private var maxGapNs = 0L
    private val callback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!running) return
            if (last != 0L) {
                val gap = frameTimeNanos - last
                if (gap > maxGapNs) maxGapNs = gap
                if (gap > 50_000_000L) over50++
            }
            last = frameTimeNanos; frames++
            Choreographer.getInstance().postFrameCallback(this)
        }
    }

    fun start() { if (running) return; running = true; last = 0L; Choreographer.getInstance().postFrameCallback(callback) }
    fun stop() { running = false; Choreographer.getInstance().removeFrameCallback(callback) }
    fun json() = JsonObject(mapOf("frames" to JsonPrimitive(frames), "gapsOver50Ms" to JsonPrimitive(over50), "maxGapMs" to JsonPrimitive(maxGapNs / 1e6)))
}
