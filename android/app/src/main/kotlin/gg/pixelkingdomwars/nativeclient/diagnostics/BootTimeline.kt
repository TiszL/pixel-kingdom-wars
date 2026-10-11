package gg.pixelkingdomwars.nativeclient.diagnostics

import java.util.concurrent.ConcurrentHashMap

/**
 * Field measurement 2026-10-06 (Seeker, candidate 05a72df2, cold start): Home went live 9.6 s after process start with
 * SERVICE_READY at 7.5 s, and nothing said where those seconds went. Each boot stage now leaves one PKWLoad line per launch:
 * `BOOT_<STAGE> t=<ms since the launch began> [ms=<the stage's own time>] [<note>]`. The launch begins at process start for
 * the first launch of a process, else when the boot route starts again (an Activity relaunch in a cached process).
 * Account-free: fixed words and numbers only.
 */
internal object BootTimeline {
    private val seen: MutableSet<LoadEvent> = ConcurrentHashMap.newKeySet()
    @Volatile private var originMs: Long? = null

    /** Now on the boot clock, or null where there is no Android clock (JVM tests): every mark is then a no-op. */
    fun clock(): Long? = runCatching { android.os.SystemClock.elapsedRealtime() }.getOrNull()

    /** BootViewModel: each Activity launch measures its own boot; the first of a process counts from process start. */
    fun beginLaunch() {
        val now = clock() ?: return
        originMs = if (originMs == null) runCatching { android.os.Process.getStartElapsedRealtime() }.getOrDefault(now) else now
        seen.clear()
    }

    /** True during the first [windowMs] of this launch (false without an Android clock or before the launch began). */
    fun inWindow(windowMs: Long): Boolean {
        val now = clock() ?: return false; val origin = originMs ?: return false
        return now - origin in 0 until windowMs
    }

    /** Content preparation (ContentRepository's load sink): one BOOT_CONTENT_STAGE line per stage, timed from the launch. */
    fun contentStage(stage: String, ms: Long, files: Int, bytes: Long, ok: Boolean) {
        val now = clock() ?: return
        val since = originMs?.let { now - it }?.let { "t=$it " }.orEmpty()
        SceneLoadLog.mark(LoadEvent.BOOT_CONTENT_STAGE, since + contentStageDetail(stage, ms, files, bytes, ok))
    }

    /** The first [event] of this launch, timed from the launch and, when the caller timed the stage, from [startedAtMs]. */
    fun stage(event: LoadEvent, startedAtMs: Long? = null, note: String = "") {
        val now = clock() ?: return
        if (!seen.add(event)) return
        val origin = originMs ?: runCatching { android.os.Process.getStartElapsedRealtime() }.getOrDefault(now).also { originMs = it }
        SceneLoadLog.mark(event, bootDetail(now - origin, startedAtMs?.let { now - it }, note))
    }
}

/** One content-preparation sample: a fixed stage name and numbers only. Not once-per-launch: every stage that runs is shown. */
internal fun contentStageDetail(stage: String, ms: Long, files: Int, bytes: Long, ok: Boolean): String =
    "stage=$stage ms=$ms files=$files bytes=$bytes ok=$ok"

/** One stage line's detail; [note] is a fixed word from the call site (never an identifier). */
internal fun bootDetail(sinceLaunchMs: Long, stageMs: Long?, note: String = ""): String =
    "t=$sinceLaunchMs" + (stageMs?.let { " ms=$it" } ?: "") + (if (note.isEmpty()) "" else " $note")
