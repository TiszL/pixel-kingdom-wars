package gg.pixelkingdomwars.nativeclient.renderer

import java.util.concurrent.Executor
import kotlin.math.*

/** A single decode slot and a single hand-off. The worker never waits for GL, and GL never joins
 * the worker. Prepared pixels belong to exactly one of this mailbox or its render-thread caller. */
internal class GlobeDetailPreparation<P>(
    private val executor: Executor,
    private val prepare: (Int, () -> Unit) -> P,
    private val release: (P) -> Unit,
    private val wake: () -> Unit,
    private val cancelActive: () -> Unit = {},
) {
    data class Completed<P>(val index: Int, val value: Result<P>)
    private var wanted = emptyList<Int>()
    private var active: Pair<Long, Int>? = null
    private var completed: Completed<P>? = null
    private val failed = mutableSetOf<Int>()
    private var generation = 0L
    private var paused = false
    private var closed = false
    private var afterClose: (() -> Unit)? = null

    @Synchronized fun request(indices: List<Int>) {
        if (closed || paused) return
        wanted = indices.distinct()
        if (active?.second?.let { it !in wanted } == true) cancelActive()
        completed?.takeIf { it.index !in wanted }?.let { discard(it); completed = null }
        schedule()
    }
    @Synchronized fun fail(index: Int) { failed += index }
    @Synchronized fun take(): Completed<P>? = completed.also { completed = null }
    @Synchronized fun pendingCount() = (if (active != null) 1 else 0) + (if (completed != null) 1 else 0)
    @Synchronized fun pause() {
        generation++; paused = true; wanted = emptyList(); failed.clear()
        cancelActive()
        completed?.let(::discard); completed = null
    }
    @Synchronized fun resume() { if (!closed) { paused = false; failed.clear() } }
    @Synchronized fun close(onDrained: () -> Unit) {
        if (closed) return
        closed = true; pause(); afterClose = onDrained
        finishClose()
    }
    private fun discard(value: Completed<P>) { value.value.getOrNull()?.let(release) }
    private fun finishClose() {
        if (closed && active == null) afterClose?.also { afterClose = null }?.invoke()
    }
    private fun schedule() {
        if (closed || paused || active != null || completed != null) return
        val index = wanted.firstOrNull { it !in failed } ?: return
        val work = generation to index
        active = work
        try {
            executor.execute {
                val admitted = synchronized(this) { !closed && !paused && generation == work.first && index in wanted }
                val value = if (admitted) runCatching { prepare(index) {
                    synchronized(this) {
                        check(!closed && !paused && generation == work.first && index in wanted) { "World preparation superseded" }
                    }
                } } else null
                synchronized(this) {
                    active = null
                    if (value != null && !closed && !paused && generation == work.first && index in wanted) {
                        if (value.isFailure) failed += index
                        completed = Completed(index, value)
                        wake()
                    } else {
                        value?.getOrNull()?.let(release)
                        schedule()
                    }
                    finishClose()
                }
            }
        } catch (error: java.util.concurrent.RejectedExecutionException) {
            active = null; failed += index; completed = Completed(index, Result.failure(error)); wake()
        }
    }
}

/** Conservative spherical patch culling. Every cell is enclosed by an angular cap, so clipping
 * the near horizon, poles or dateline cannot drop a patch that contributes a visible pixel. */
internal fun visibleGlobeDetails(sources: List<GlobeDetailSource>, view: GlobeView, viewport: GlobeViewport, coarseWidth: Int): List<Int> {
    val radius = viewport.radius(view)
    if (viewport.width <= 0 || viewport.height <= 0 || radius * 2 * Math.PI / coarseWidth <= .8) return emptyList()
    return sources.indices.filter { index ->
        val source = sources[index]
        val columns = ceil((source.east - source.west) / 8.0).toInt().coerceAtLeast(1)
        val rows = ceil((source.north - source.south) / 8.0).toInt().coerceAtLeast(1)
        val dx = (source.east - source.west) / columns.toDouble()
        val dy = (source.north - source.south) / rows.toDouble()
        val chord = 2 * sin((dx + dy) * Math.PI / 720)
        val margin = radius * chord + 1
        (0 until rows).any { y -> (0 until columns).any { x ->
            val point = GlobeGeometry.project(source.west + (x + .5) * dx, source.south + (y + .5) * dy, view, viewport)
            point.z + chord > 0 && point.x + margin >= 0 && point.x - margin < viewport.width &&
                point.y + margin >= 0 && point.y - margin < viewport.height
        } }
    }.sortedBy { index ->
        val source = sources[index]
        val center = (source.west + source.east) / 2.0
        val longitude = center + GlobeGeometry.wrap(view.lon - center)
        val dx = maxOf(source.west - longitude, longitude - source.east, 0.0)
        val dy = maxOf(source.south - view.lat, view.lat - source.north, 0.0)
        dx * dx + dy * dy
    }
}

/** Same conservative projected island bounds used by painting. The authored chain atlas ceiling
 * stays three; nearest visible chains win without paint-time LRU churn or synchronous disk reads. */
internal fun visibleGlobeChains(islands: List<GlobeIsland>, extent: Double, view: GlobeView, viewport: GlobeViewport, coarseWidth: Int): List<Int> {
    val radius=viewport.radius(view)
    if(viewport.width<=0 || viewport.height<=0 || radius*2*Math.PI/coarseWidth<=1.5)return emptyList()
    return islands.mapNotNull { island ->
        val point=GlobeGeometry.project(island.lon,island.lat,view,viewport)
        val angular=(island.rx+island.ry)*extent*Math.PI/180
        val span=angular*radius+2
        if(point.z+angular<=0 || point.x+span<0 || point.x-span>=viewport.width || point.y+span<0 || point.y-span>=viewport.height)null
        else island.chain to ((point.x-viewport.width/2.0)*(point.x-viewport.width/2.0)+(point.y-viewport.height/2.0)*(point.y-viewport.height/2.0))
    }.sortedBy { it.second }.map { it.first }.distinct().take(3)
}
