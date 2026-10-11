package gg.pixelkingdomwars.nativeclient.scene

import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import androidx.compose.runtime.mutableStateOf
import gg.pixelkingdomwars.nativeclient.diagnostics.BootTimeline
import gg.pixelkingdomwars.nativeclient.diagnostics.LoadEvent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.File

/** The last `/base` answer this device saw for one account and base, kept like the postcard: [account] is the hashed key
 *  ([ScenePostcards.accountKey]), never the wallet. */
internal class CachedBasePayload(val account: String, val baseId: String, val savedAtMs: Long, val raw: JsonObject)

/** A cached payload older than this is not mapped (a stale base drawn live is worse than the wallpaper for a moment). */
internal const val BASE_CACHE_MAX_AGE_MS = 72L * 60 * 60 * 1000
/** At most one disk write per this interval; the newest payload of the interval is the one written. */
internal const val BASE_CACHE_STORE_EVERY_MS = 60_000L

/** Why the held payload may not stand for this Home (null = it may): no payload, another account, another base, too old. */
internal fun cachedBaseMiss(cached: CachedBasePayload?, account: String?, baseId: String?, nowMs: Long): String? = when {
    cached == null -> "none"
    account == null || cached.account != account -> "account"
    baseId == null || cached.baseId != baseId || cached.raw.baseIdOf() != baseId -> "base"
    nowMs - cached.savedAtMs !in 0..BASE_CACHE_MAX_AGE_MS -> "age"
    else -> null
}

/** Delay before the next disk write: at once for the first, else when the interval since the last write has run out. */
internal fun baseStoreDelayMs(lastWriteMs: Long?, nowMs: Long): Long =
    if (lastWriteMs == null) 0L else (lastWriteMs + BASE_CACHE_STORE_EVERY_MS - nowMs).coerceIn(0L, BASE_CACHE_STORE_EVERY_MS)

internal fun encodeCachedBase(cached: CachedBasePayload): String = buildJsonObject {
    put("v", 1); put("account", cached.account); put("baseId", cached.baseId); put("savedAtMs", cached.savedAtMs)
    put("raw", cached.raw)
}.toString()

/** Null for anything not written by [encodeCachedBase] for [account] (a foreign, partial or tampered file is ignored). */
internal fun decodeCachedBase(text: String, account: String): CachedBasePayload? = runCatching {
    val o = Json.parseToJsonElement(text).jsonObject
    if (o["v"]?.jsonPrimitive?.contentOrNull != "1" || o["account"]?.jsonPrimitive?.contentOrNull != account) return@runCatching null
    val baseId = o["baseId"]?.jsonPrimitive?.contentOrNull ?: return@runCatching null
    val raw = o["raw"]?.jsonObject ?: return@runCatching null
    if (raw.baseIdOf() != baseId) return@runCatching null
    CachedBasePayload(account, baseId, o["savedAtMs"]?.jsonPrimitive?.longOrNull ?: return@runCatching null, raw)
}.getOrNull()

private fun JsonObject.baseIdOf(): String? = (this["baseId"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

/**
 * Cold-start measurement 2026-10-06 (Seeker, 05a72df2: live at 9.6 s): Home could not map its scene until `/base`,
 * `/balances` and `/tutorial` had answered one after another after sign-in. The last `/base` answer is now kept on disk
 * (no-backup storage, one file per hashed account, 72 h) and Home maps its scene from it at once — the drawn base only: its
 * service facts are stripped and taps wait for the server's answer — then the server's answer replaces it in place.
 */
internal object LastBasePayload {
    /** The payload a Home with no server answer yet may draw. Compose state: a restore that lands after Home composed is seen. */
    val held = mutableStateOf<CachedBasePayload?>(null)
    @Volatile private var root: File? = null
    private val worker by lazy { HandlerThread("pkw-base-cache").also { it.start() } }
    private val background by lazy { Handler(worker.looper) }
    private val main by lazy { Handler(Looper.getMainLooper()) }
    private val lock = Any()
    private var pending: CachedBasePayload? = null
    private var scheduled = false
    private var lastWriteMs: Long? = null
    private var offered: JsonObject? = null

    fun install(noBackupDir: File) { root = File(noBackupDir, "last-base") }

    /** Startup, on an IO thread (MainActivity): the newest stored payload is parsed off Main while boot draws. */
    fun prewarm() {
        val started = SystemClock.elapsedRealtime()
        val stored = root?.listFiles().orEmpty().mapNotNull { dir -> File(dir, FILE).takeIf(File::isFile) }.maxByOrNull(File::lastModified) ?: return
        val cached = decodeCachedBase(runCatching { stored.readText() }.getOrNull() ?: return, stored.parentFile?.name ?: return) ?: return
        if (System.currentTimeMillis() - cached.savedAtMs !in 0..BASE_CACHE_MAX_AGE_MS) return
        main.post {
            // A newer answer this process already holds (a relaunch in a cached process) wins over the disk copy.
            if ((held.value?.savedAtMs ?: Long.MIN_VALUE) < cached.savedAtMs) held.value = cached
            BootTimeline.stage(LoadEvent.BOOT_CACHED_BASE, started)
        }
    }

    /** Main thread, for every server `/base` answer Home holds (identity-checked, so a recomposition costs one compare). */
    fun offer(account: String, raw: JsonObject) {
        if (raw === offered) return
        offered = raw
        val baseId = raw.baseIdOf() ?: return
        val entry = CachedBasePayload(account, baseId, System.currentTimeMillis(), raw)
        held.value = entry
        val delayMs = synchronized(lock) {
            pending = entry
            if (scheduled) return
            scheduled = true
            baseStoreDelayMs(lastWriteMs, SystemClock.elapsedRealtime())
        }
        background.postDelayed(write, delayMs)
    }

    private val write = Runnable {
        val entry = synchronized(lock) { scheduled = false; lastWriteMs = SystemClock.elapsedRealtime(); pending.also { pending = null } }
        if (entry != null) persist(entry)
    }

    /** Sign-out (through [ScenePostcards.forget]): memory now; the account's file (every file for null) on the worker. */
    fun forget(account: String?) {
        synchronized(lock) { if (account == null || pending?.account == account) pending = null }
        if (account == null || held.value?.account == account) held.value = null
        offered = null
        val base = root ?: return
        background.post { runCatching { (if (account == null) base else File(base, account)).deleteRecursively() } }
    }

    private fun persist(entry: CachedBasePayload) = runCatching {
        val dir = File(root ?: return@runCatching, entry.account).apply { mkdirs() }
        val temp = File(dir, "$FILE.tmp")
        temp.writeText(encodeCachedBase(entry))
        check(temp.renameTo(File(dir, FILE)))
    }

    private const val FILE = "base.json"
}
