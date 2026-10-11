package gg.pixelkingdomwars.nativeclient.diagnostics

import androidx.annotation.VisibleForTesting
import java.util.concurrent.atomic.AtomicIntegerArray

/** Account-free, process-local counters. Android installs the optional sink; JVM tests need no platform calls. */
enum class LoadEvent {
    FRAGMENT_CREATE, FRAGMENT_REMOVE, SCENE_MAP, SCENE_SUBMIT, VEIL_SHOWN,
    WORLD_FRAGMENT_CREATE, PRIVATE_CONTENT_PARSE, HTTP, PARK, UNPARK, GL_FRAME, SERVICE_READY,
    /** A new renderer view drew its first complete frame (the opening veil lifts). */
    SCENE_READY,
    /** A Home postcard copy (settled / leaving / disk restore): ok, superseded, failed or skipped. */
    FRAME_CAPTURE,
    /** One line per Home opening: cause, first pixels, time to live, swap (scene-transitions spec §4 step 1). */
    SUMMARY,
    /** PKWFrames: UI-thread frame statistics over the 2 s after a swap (FrameWindows). */
    FRAMES,
    /** A launch's boot stages (BootTimeline): login status, /me, /bases, signed in (selection + /playtest/access), the
     *  public update check (/native/capabilities), content ready, Home composed, the last known base payload restored from
     *  disk, and the first /base, /balances and /tutorial answers. */
    BOOT_SESSION, BOOT_IDENTITY, BOOT_DIRECTORY, BOOT_SIGNED_IN, BOOT_CAPABILITIES, BOOT_CONTENT, BOOT_HOME, BOOT_CACHED_BASE,
    BOOT_BASE_READ, BOOT_BALANCES, BOOT_TUTORIAL,
    /** The first Home read of the launch was asked (readHome began): with BOOT_BASE_READ it splits waiting-to-ask from asking. */
    BOOT_BASE_ASK,
    /** One content-preparation stage (bundle trust/verify, catalogue and render parse, admission): `stage= ms= files= bytes= ok=`. */
    BOOT_CONTENT_STAGE
}

object SceneLoadLog {
    private val counts = AtomicIntegerArray(LoadEvent.entries.size)
    @Volatile var sink: ((String) -> Unit)? = null

    fun mark(event: LoadEvent, detail: String = "") {
        counts.incrementAndGet(event.ordinal)
        if (event != LoadEvent.GL_FRAME) runCatching { sink?.invoke(event.name + if (detail.isEmpty()) "" else " $detail") }
    }
    fun count(event: LoadEvent): Int = counts.get(event.ordinal)
    fun snapshot(): Map<LoadEvent, Int> = LoadEvent.entries.associateWith(::count)
    @VisibleForTesting fun reset() { LoadEvent.entries.forEach { counts.set(it.ordinal, 0) } }

    // Fixed route vocabulary only. Even an all-lowercase private identifier is redacted.
    private val fixed = setOf("base", "bases", "balances", "wallet", "mail", "status", "tester", "me", "chat",
        "tutorial", "claim", "army", "training", "buildings", "receipt", "mine", "quests", "clans", "profile",
        "economy", "market", "forge", "research", "heroes", "notifications")
    fun httpDetail(path: String): String = path.substringBefore('?').substringBefore('#').split('/')
        .filter { it.isNotEmpty() }.take(3).joinToString("/", prefix = "/") { if (it in fixed) it else ":id" }
}
