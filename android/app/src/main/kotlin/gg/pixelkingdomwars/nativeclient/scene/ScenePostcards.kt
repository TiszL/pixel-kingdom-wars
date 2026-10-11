package gg.pixelkingdomwars.nativeclient.scene

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.view.PixelCopy
import android.view.SurfaceView
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.lifecycle.Lifecycle
import gg.pixelkingdomwars.nativeclient.diagnostics.LoadEvent
import gg.pixelkingdomwars.nativeclient.diagnostics.SceneLoadLog
import kotlinx.serialization.json.*
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/**
 * Owner 2026-10-06 ("black screen is low quality indication … professional solution"; spec scene-transitions §1.1, §4.5):
 * the best picture of a kingdom that is not live yet is its POSTCARD — the last frame its GL surface drew, copied with
 * PixelCopy on a clean Home (no selection, editor, placement or carry) after the camera settles, and again as Home's
 * surface leaves. One full-size postcard in memory; a half-size WebP with a small header on disk, so even a cold start
 * opens on the player's own base. Pixels only: never uploaded, never logged, per account, cleared on sign-out, 72 h max.
 */
internal data class PostcardKey(val account: String, val contentTag: String, val baseId: String, val width: Int, val height: Int)

/** The camera the postcard was drawn with ([gg.pixelkingdomwars.nativeclient.renderer.BaseCameraView] convention). */
internal data class PostcardCamera(val x: Float, val y: Float, val zoom: Float, val moved: Boolean)

internal class Postcard<T : Any>(val key: PostcardKey, val image: T, val camera: PostcardCamera?, val savedAtMs: Long)

internal const val POSTCARD_MAX_AGE_MS = 72L * 60 * 60 * 1000
internal const val POSTCARD_SETTLE_MS = 1_500L
/** A new scene's first settled copy waits past the swap and its 2 s frame window (PKWFrames), so it never costs a swap frame. */
internal const val POSTCARD_FIRST_SETTLE_MS = 2_500L
internal const val POSTCARD_PROACTIVE_EVERY_MS = 10_000L

/** A postcard stands for a scene only for the same account, content generation (its art) and base, at exactly the surface
 *  size it was taken at (another size or orientation would put every building in the wrong place), and while < 72 h old. */
internal fun postcardAdmitted(key: PostcardKey?, savedAtMs: Long, account: String?, contentTag: String?, baseId: String?,
    width: Int, height: Int, nowMs: Long): Boolean =
    postcardMiss(key, savedAtMs, account, contentTag, baseId, width, height, nowMs) == null

/** Why a postcard does not stand for this scene, or null when it does (field report 2026-10-06: a restored postcard showed
 *  `snapshot=miss` with no reason; the phone was in landscape, the postcard portrait). Fixed words only: PKWLoad logs it. */
internal fun postcardMiss(key: PostcardKey?, savedAtMs: Long, account: String?, contentTag: String?, baseId: String?,
    width: Int, height: Int, nowMs: Long): String? = when {
    key == null -> "none"
    account == null || key.account != account -> "account"
    contentTag == null || key.contentTag != contentTag -> "content"
    baseId == null || key.baseId != baseId -> "base"
    width <= 0 || height <= 0 || key.width != width || key.height != height -> "size"
    nowMs - savedAtMs !in 0..POSTCARD_MAX_AGE_MS -> "age"
    else -> null
}

/** A postcard's pixel size per surface dimension: half (drawn pixel-doubled for the second or so it shows). */
internal fun postcardWidth(surfacePx: Int): Int = maxOf(1, surfacePx / 2)

/** How long a cover that finds no postcard waits for a disk restore still running, before it settles on the wallpaper. */
internal const val RESTORE_WAIT_MS = 50L

/** Only a clean Home is a postcard: a selection outline, the layout editor, a placement ghost, a carried building, an open
 *  BUILD tray or a battle would greet the player as if they were still there. */
internal fun postcardClean(editing: Boolean, placing: Boolean, selected: Boolean, carrying: Boolean, buildMenu: Boolean): Boolean =
    !editing && !placing && !selected && !carrying && !buildMenu

/** One postcard in memory: the newest copy request wins (a copy finishing after a newer one began is dropped); a failed copy
 *  keeps the previous postcard; a postcard read from disk never replaces one this process copied or is copying. */
internal class PostcardSlot<T : Any> {
    var shown by mutableStateOf<Postcard<T>?>(null)
        private set
    private var latest = 0L
    /** A disk postcard may fill the slot: at startup, and again after memory pressure emptied it. */
    private var restorable = true
    fun begin(): Long { restorable = false; return ++latest }
    fun complete(request: Long, postcard: Postcard<T>): Boolean {
        if (request != latest) return false
        shown = postcard
        return true
    }
    fun restore(postcard: Postcard<T>): Boolean {
        if (shown != null || !restorable) return false
        shown = postcard
        return true
    }
    /** Memory pressure: the in-memory postcard goes (its disk copy stays) and the disk copy may come back. A copy already in
     *  flight still lands, as the newest. */
    fun trim() { shown = null; restorable = true }
    /** Sign-out: this account's postcard (null = every account) leaves memory, and an in-flight copy cannot bring it back. */
    fun forget(account: String?) {
        if (account == null || shown?.key?.account == account) shown = null
        latest++; restorable = false
    }
}

/** What memory pressure does to the in-memory postcard (ComponentCallbacks2 levels): nothing while the app runs comfortably;
 *  from RUNNING_LOW / UI_HIDDEN the full-size copy (~13 MB) goes and the half-size disk copy (~3 MB) is decoded back; from
 *  BACKGROUND on, nothing stays in memory. The disk copy always stays. */
internal enum class PostcardTrim { KEEP, HALF, DROP }
internal fun postcardTrim(level: Int): PostcardTrim = when {
    level < android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW -> PostcardTrim.KEEP
    level < android.content.ComponentCallbacks2.TRIM_MEMORY_BACKGROUND -> PostcardTrim.HALF
    else -> PostcardTrim.DROP
}

/** The globe's postcard key: one world picture per content generation and surface size (the globe is the same for every
 *  account; the labels and the HUD are Compose and never in it). */
internal const val WORLD_ACCOUNT = "world"
internal const val WORLD_BASE = "globe"
internal fun worldPostcardAdmitted(key: PostcardKey?, savedAtMs: Long, contentTag: String, width: Int, height: Int, nowMs: Long): Boolean =
    postcardAdmitted(key, savedAtMs, WORLD_ACCOUNT, contentTag, WORLD_BASE, width, height, nowMs)

internal fun encodePostcardHeader(key: PostcardKey, camera: PostcardCamera?, savedAtMs: Long): String = buildJsonObject {
    put("v", 1); put("account", key.account); put("contentTag", key.contentTag); put("baseId", key.baseId)
    put("width", key.width); put("height", key.height); put("savedAtMs", savedAtMs)
    if (camera != null) { put("cameraX", camera.x); put("cameraY", camera.y); put("zoom", camera.zoom); put("moved", camera.moved) }
}.toString()

internal class PostcardHeader(val key: PostcardKey, val camera: PostcardCamera?, val savedAtMs: Long)

internal fun decodePostcardHeader(text: String): PostcardHeader? = runCatching {
    val o = Json.parseToJsonElement(text).jsonObject
    require(o["v"]?.jsonPrimitive?.int == 1)
    fun s(name: String) = requireNotNull(o[name]?.jsonPrimitive?.contentOrNull)
    fun i(name: String) = requireNotNull(o[name]?.jsonPrimitive?.intOrNull)
    val key = PostcardKey(s("account"), s("contentTag"), s("baseId"), i("width"), i("height"))
    require(key.width > 0 && key.height > 0)
    val camera = o["zoom"]?.jsonPrimitive?.floatOrNull?.takeIf { it.isFinite() && it > 0f }?.let { zoom ->
        PostcardCamera(requireNotNull(o["cameraX"]?.jsonPrimitive?.floatOrNull), requireNotNull(o["cameraY"]?.jsonPrimitive?.floatOrNull),
            zoom, o["moved"]?.jsonPrimitive?.booleanOrNull == true)
    }
    PostcardHeader(key, camera, requireNotNull(o["savedAtMs"]?.jsonPrimitive?.longOrNull))
}.getOrNull()

/** The process-wide postcard owner (Android side). Copies land on a background thread; state writes go to Main. */
internal object ScenePostcards {
    val slot = PostcardSlot<ImageBitmap>()
    /** Field report 2026-10-06 (MAP → back: one black frame with the world's labels and HUD over it): the globe's last frame,
     *  half size, memory only, drawn BENEATH the world surface. While the surface is up it punches through it; in the frame
     *  where the surface is already gone but the world's own layers are still drawn, this picture is what shows. */
    val world = PostcardSlot<ImageBitmap>()
    @Volatile private var root: File? = null
    private val worker by lazy { HandlerThread("pkw-postcard").also { it.start() } }
    private val background by lazy { Handler(worker.looper) }
    private val main by lazy { Handler(Looper.getMainLooper()) }
    private var lastProactiveMs = 0L
    private val accounts = HashMap<String, String>()
    /** A disk restore is running (startup, or after a trim): a cover choosing its first picture may wait [RESTORE_WAIT_MS]. */
    @Volatile var restoring = false
        private set

    fun install(noBackupDir: File) { root = File(noBackupDir, "scene-postcards") }

    /** A stable, non-reversible folder/key name for a wallet (the wallet itself is never written to disk here). */
    @Synchronized fun accountKey(wallet: String): String = accounts.getOrPut(wallet) {
        MessageDigest.getInstance("SHA-256").digest(wallet.toByteArray()).joinToString("") { "%02x".format(it) }.take(24)
    }

    /** Startup, on an IO thread (MainActivity): the newest stored postcard is decoded off Main so a cold Home opens on it. */
    fun prewarm() {
        restoring = true
        var posted = false
        try {
            val started = SystemClock.elapsedRealtime()
            val stored = root?.listFiles().orEmpty().mapNotNull { dir -> File(dir, HEADER).takeIf(File::isFile) }.maxByOrNull(File::lastModified) ?: return
            val header = decodePostcardHeader(runCatching { stored.readText() }.getOrNull() ?: return) ?: return
            if (System.currentTimeMillis() - header.savedAtMs !in 0..POSTCARD_MAX_AGE_MS) return
            val bitmap = runCatching { BitmapFactory.decodeFile(File(stored.parentFile, IMAGE).path) }.getOrNull() ?: return
            bitmap.prepareToDraw()
            val postcard = Postcard(header.key, bitmap.asImageBitmap(), header.camera, header.savedAtMs)
            main.post {
                val kept = slot.restore(postcard)
                restoring = false
                SceneLoadLog.mark(LoadEvent.FRAME_CAPTURE, "disk ${if (kept) "restored" else "superseded"} ms=${SystemClock.elapsedRealtime() - started}")
            }
            posted = true
        } finally { if (!posted) restoring = false }
    }

    /** Main thread, with the Home surface attached. [proactive]: the settled-camera copy (at most once per 10 s); else the
     *  copy just before the surface leaves. Never on the GL thread or in onPause. */
    fun capture(fragment: KingdomFragment, contentTag: String, proactive: Boolean) {
        val surface = fragment.view as? SurfaceView
        val baseId = fragment.scene?.baseId
        val account = fragment.postcardAccount
        val now = SystemClock.elapsedRealtime()
        val why = if (proactive) "settled" else "leaving"
        if (surface == null || baseId == null || account == null || fragment.battle != null || !fragment.hasPresentedScene ||
            !fragment.postcardClean || !fragment.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) ||
            surface.width <= 0 || surface.height <= 0 || surface.holder.surface?.isValid != true) {
            SceneLoadLog.mark(LoadEvent.FRAME_CAPTURE, "$why skipped"); return
        }
        if (proactive && now - lastProactiveMs < POSTCARD_PROACTIVE_EVERY_MS) return
        if (proactive) lastProactiveMs = now
        val key = PostcardKey(account, contentTag, baseId, surface.width, surface.height)
        val camera = fragment.drawnCamera?.takeIf { it.baseId == baseId && it.width == key.width && it.height == key.height }
            ?.let { PostcardCamera(it.cameraX, it.cameraY, it.zoom, it.moved) }
        val request = slot.begin()
        // Field report 2026-10-06 (every frame after the swap over 16 ms): the postcard is copied at HALF size (~3 MB, not a
        // ~13 MB allocation, upload and full-size draw), and a settled copy allocates and copies on the postcard thread, never
        // on Main. The copy leaving Home stays on Main: the surface is gone right after it.
        val target = surface.holder.surface
        val copy: () -> Unit = {
            runCatching {
                val bitmap = Bitmap.createBitmap(postcardWidth(key.width), postcardWidth(key.height), Bitmap.Config.ARGB_8888)
                PixelCopy.request(target, bitmap, { result ->
                    if (result != PixelCopy.SUCCESS) {
                        main.post { SceneLoadLog.mark(LoadEvent.FRAME_CAPTURE, "$why failed code=$result") }
                        return@request
                    }
                    bitmap.prepareToDraw() // the GPU upload starts now, not on the reopening frame
                    val savedAt = System.currentTimeMillis()
                    val postcard = Postcard(key, bitmap.asImageBitmap(), camera, savedAt)
                    main.post {
                        val kept = slot.complete(request, postcard)
                        SceneLoadLog.mark(LoadEvent.FRAME_CAPTURE, "$why ${if (kept) "ok" else "superseded"} ms=${SystemClock.elapsedRealtime() - now}")
                    }
                    persist(bitmap, key, camera, savedAt) // this background thread: the WebP, never Main
                }, background)
            }.onFailure { failure -> main.post { SceneLoadLog.mark(LoadEvent.FRAME_CAPTURE, "$why failed ${failure.javaClass.simpleName}") } }
        }
        if (proactive) background.post(copy) else copy()
    }

    /** The globe's frame (main thread, the world surface attached, the caller every ≥ 10 s once the globe is ready). */
    fun captureWorld(fragment: androidx.fragment.app.Fragment, contentTag: String) {
        val surface = fragment.view as? SurfaceView
        if (surface == null || !fragment.isAdded || !fragment.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) ||
            surface.width <= 0 || surface.height <= 0 || surface.holder.surface?.isValid != true) {
            SceneLoadLog.mark(LoadEvent.FRAME_CAPTURE, "world skipped"); return
        }
        val key = PostcardKey(WORLD_ACCOUNT, contentTag, WORLD_BASE, surface.width, surface.height)
        val started = SystemClock.elapsedRealtime()
        val request = world.begin()
        runCatching {
            val bitmap = Bitmap.createBitmap(maxOf(1, key.width / 2), maxOf(1, key.height / 2), Bitmap.Config.ARGB_8888)
            PixelCopy.request(surface, bitmap, { result ->
                if (result != PixelCopy.SUCCESS) { main.post { SceneLoadLog.mark(LoadEvent.FRAME_CAPTURE, "world failed code=$result") }; return@request }
                bitmap.prepareToDraw()
                val postcard = Postcard(key, bitmap.asImageBitmap(), null, System.currentTimeMillis())
                main.post {
                    val kept = world.complete(request, postcard)
                    SceneLoadLog.mark(LoadEvent.FRAME_CAPTURE, "world ${if (kept) "ok" else "superseded"} ms=${SystemClock.elapsedRealtime() - started}")
                }
            }, background)
        }.onFailure { SceneLoadLog.mark(LoadEvent.FRAME_CAPTURE, "world failed ${it.javaClass.simpleName}") }
    }

    /** Activity.onTrimMemory (Main): see [postcardTrim]. The globe's picture goes at any trim (it is re-taken on the map). */
    fun trim(level: Int) {
        val action = postcardTrim(level)
        if (action != PostcardTrim.KEEP) world.trim()
        if (action == PostcardTrim.KEEP || slot.shown == null) return
        slot.trim()
        SceneLoadLog.mark(LoadEvent.FRAME_CAPTURE, "trim level=$level ${action.name.lowercase()}")
        if (action == PostcardTrim.HALF) background.post { prewarm() }
    }

    /** Sign-out: memory now; the account's folder (all folders for null) on the background thread. The account's last base
     *  payload ([LastBasePayload]) goes with its postcard. */
    fun forget(wallet: String?) {
        val account = wallet?.let(::accountKey)
        slot.forget(account); world.forget(null)
        LastBasePayload.forget(account)
        val base = root ?: return
        background.post { runCatching { (if (account == null) base else File(base, account)).deleteRecursively() } }
    }

    private fun persist(bitmap: Bitmap, key: PostcardKey, camera: PostcardCamera?, savedAtMs: Long) = runCatching {
        val dir = File(root ?: return@runCatching, key.account).apply { mkdirs() }
        // The copy is already half size; scale only a full-size one (older copies).
        val half = if (bitmap.width <= postcardWidth(key.width)) bitmap else Bitmap.createScaledBitmap(bitmap, maxOf(1, key.width / 2), maxOf(1, key.height / 2), false)
        val image = File(dir, "$IMAGE.tmp"); val header = File(dir, "$HEADER.tmp")
        FileOutputStream(image).use { out ->
            @Suppress("DEPRECATION") val format = if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.WEBP
            half.compress(format, 82, out)
        }
        if (half !== bitmap) half.recycle()
        header.writeText(encodePostcardHeader(key, camera, savedAtMs))
        check(image.renameTo(File(dir, IMAGE)) && header.renameTo(File(dir, HEADER)))
    }

    private const val IMAGE = "postcard.webp"
    private const val HEADER = "postcard.json"
}
