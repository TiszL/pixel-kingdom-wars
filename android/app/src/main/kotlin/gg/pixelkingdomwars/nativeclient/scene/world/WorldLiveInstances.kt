package gg.pixelkingdomwars.nativeclient.scene.world

import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import java.lang.ref.WeakReference
import java.util.Locale

/**
 * Which world objects are still reachable (P0, the 2026-09-26 Seeker OutOfMemoryError: after ~14 min and nine realm
 * visits the Java heap was full in a FRESH host, Graphics at 472 MB, and six hosts had been built; the JVM harness sees
 * no per-visit growth inside one engine, so a host that outlives its dispose is the suspect). Each host, realm engine
 * and globe is tracked by a weak reference, and marked when disposed: a disposed object that stays reachable across
 * World visits is a leak, one that is merely not collected yet drops out at the next GC. Thread-safe (the GL thread
 * tracks and disposes, a test may count from another).
 */
class WorldLiveRegistry {
    private class Entry(obj: Any, val kind: String) : WeakReference<Any>(obj) { @Volatile var disposed = false }
    private val entries = ArrayList<Entry>()

    /** Start tracking [obj] as [kind] (once per object). */
    fun track(kind: String, obj: Any) {
        synchronized(entries) { prune(); if (entries.none { it.get() === obj }) entries += Entry(obj, kind) }
    }

    /** [obj] was disposed: from now on it counts as disposed while it stays reachable. */
    fun disposed(obj: Any) {
        synchronized(entries) { entries.firstOrNull { it.get() === obj }?.let { it.disposed = true } }
    }

    /** Tracked objects of [kind] not collected yet. */
    fun live(kind: String): Int = synchronized(entries) { prune(); entries.count { it.kind == kind } }

    /** Of [live], the ones already disposed. */
    fun liveDisposed(kind: String): Int = synchronized(entries) { prune(); entries.count { it.kind == kind && it.disposed } }

    private fun prune() { entries.removeAll { it.get() == null } }

    /**
     * One diagnostic line (no account data):
     *
     *     [world-memory] <event> hosts 1 (disposed 0) engines 1 (0) globes 1 (0) · java 84.2/256.0 MB
     *         · native 45.1 MB · gl globe 31.0 realm 0.0 core 1.3 MB
     *
     * (one line). `java` is the runtime's used over its max heap, `native` the native heap allocated (-1 where the
     * platform cannot say), `gl` the [core]'s allocator tally per pool (absent without a core).
     */
    fun line(event: String, core: Gl3Core?, nativeBytes: Long, runtime: Runtime = Runtime.getRuntime()): String = buildString(192) {
        append("[world-memory] ").append(event)
        for ((kind, name) in KINDS) append(' ').append(name).append(' ').append(live(kind)).append(" (")
            .append(if (kind == HOST) "disposed " else "").append(liveDisposed(kind)).append(')')
        append(" · java ").append(mb(runtime.totalMemory() - runtime.freeMemory())).append('/').append(mb(runtime.maxMemory())).append(" MB")
        append(" · native ").append(if (nativeBytes < 0) "-1" else mb(nativeBytes)).append(" MB")
        if (core != null) {
            val st = core.stats
            append(" · gl globe ").append(mb(st.gpuBytes(Gl3Pool.GLOBE))).append(" realm ").append(mb(st.gpuBytes(Gl3Pool.REALM)))
                .append(" core ").append(mb(st.gpuBytes(Gl3Pool.CORE))).append(" MB")
        }
    }

    companion object {
        const val HOST = "host"
        const val ENGINE = "engine"
        const val GLOBE = "globe"
        private val KINDS = listOf(HOST to "hosts", ENGINE to "engines", GLOBE to "globes")
        private fun mb(bytes: Long): String = String.format(Locale.ROOT, "%.1f", bytes / 1048576.0)
    }
}

/**
 * The process's registry, live only where [WorldLog] prints (debug builds and QA candidates, the Seeker's evidence;
 * release tracks and formats nothing). The host logs a line at its create and dispose and at every dive.
 */
object WorldLiveInstances {
    val registry = WorldLiveRegistry()
    val enabled: Boolean get() = WorldLog.enabled

    fun track(kind: String, obj: Any) { if (enabled) registry.track(kind, obj) }
    fun disposed(obj: Any) { if (enabled) registry.disposed(obj) }

    /** Logs one [WorldLiveRegistry.line] through [log] (the host's gated logger). */
    fun log(event: String, core: Gl3Core?, log: (String) -> Unit) {
        if (enabled) log(registry.line(event, core, nativeHeapBytes()))
    }

    /** `Debug.getNativeHeapAllocatedSize()`, or -1 off the device (the JVM tests' android.jar stubs throw). */
    private fun nativeHeapBytes(): Long = runCatching { android.os.Debug.getNativeHeapAllocatedSize() }.getOrDefault(-1L)
}
