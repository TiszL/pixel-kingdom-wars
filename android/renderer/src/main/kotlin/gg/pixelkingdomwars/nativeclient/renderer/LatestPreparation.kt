package gg.pixelkingdomwars.nativeclient.renderer

import java.util.concurrent.Executor

/** One running preparation and one replacement. Superseded snapshots never form an executor backlog. */
internal class LatestPreparation(private val executor: Executor) {
    private var next: (() -> Unit)? = null
    private var running = false
    private var closed = false
    private var latestVersion = Long.MIN_VALUE
    @Synchronized fun submit(version: Long, work: () -> Unit) {
        // A late GL repair cannot replace a newer Main-thread scene that was already admitted.
        if (closed || version < latestVersion) return
        latestVersion = version
        next = work
        if (!running) schedule()
    }
    @Synchronized fun depth(): Int = (if (running) 1 else 0) + (if (next != null) 1 else 0)
    @Synchronized fun close() { closed = true; next = null }
    private fun schedule() {
        running = true
        try { executor.execute {
            try {
                val work = synchronized(this) { next.also { next = null } }
                work?.invoke()
            } finally {
                synchronized(this) { running = false; if (!closed && next != null) schedule() }
            }
        } } catch (error: java.util.concurrent.RejectedExecutionException) { running = false; next = null; throw error }
    }
}

/** Operational upload budget, independent of game clocks. A single GL operation cannot be preempted. */
internal class FrameUploadQueue<T>(private val clock: () -> Long = System::nanoTime) {
    private val pending = ArrayDeque<T>()
    val size: Int get() = pending.size
    fun replace(items: Collection<T>) { pending.clear(); pending.addAll(items) }
    fun advance(upload: (T) -> Unit) {
        val start = clock()
        var count = 0
        while (pending.isNotEmpty() && count < 8 && (count == 0 || clock() - start < 2_000_000L)) {
            upload(pending.removeFirst()); count++
        }
    }
}
