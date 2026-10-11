package gg.pixelkingdomwars.nativeclient.diagnostics

import gg.pixelkingdomwars.nativeclient.renderer.LocalLifecycleStage
import gg.pixelkingdomwars.nativeclient.renderer.LocalSceneSnapshot
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicReferenceArray

/** Main/GL never wait for the sampler or disk. Fixed slots and atomic publication
 * deliberately drop excess observations rather than delaying the measured operation. */
internal class LocalLifecycleWatch {
    internal class Epoch(val generation: Long) {
        val active = AtomicReferenceArray<Entry?>(MAX_ACTIVE)
        val ended = AtomicReferenceArray<LocalLifecycleRecord?>(MAX_ENDED)
        val cursor = AtomicLong()
        val revision = AtomicLong()
        val persisted = AtomicLong()
        val lastSample = AtomicLong(Long.MIN_VALUE)
    }
    internal class Entry(val record: LocalLifecycleRecord, val since: Long) { val ended = AtomicLong(-1) }
    class Ticket internal constructor(internal val epoch: Epoch, internal val slot: Int, internal val entry: Entry)
    class Batch internal constructor(internal val epoch: Epoch, val revision: Long, val records: List<LocalLifecycleRecord>)
    private val state = AtomicReference(Epoch(-1))
    private val sequence = AtomicLong()
    fun reset(generation: Long) { state.set(Epoch(generation)) }
    fun begin(generation: Long, stage: LocalLifecycleStage, snapshot: LocalSceneSnapshot, now: Long, at: Long, build: String): Ticket? {
        val epoch = state.get(); if (epoch.generation != generation || !snapshot.valid()) return null
        val record = LocalLifecycleRecord(at, sequence.incrementAndGet(), stage.name.lowercase(), false, 0, snapshot.kind.name.lowercase(),
            snapshot.queueDepth, snapshot.textureMiB, snapshot.pendingWallUploads, snapshot.viewportWidth, snapshot.viewportHeight,
            snapshot.cameraX, snapshot.cameraY, snapshot.cameraZoom, build)
        val entry = Entry(record, now)
        for (slot in 0 until MAX_ACTIVE) if (epoch.active.compareAndSet(slot, null, entry)) {
            epoch.revision.incrementAndGet(); return Ticket(epoch, slot, entry)
        }
        return null
    }
    fun end(ticket: Ticket, now: Long) {
        val epoch = ticket.epoch; val entry = ticket.entry
        if (state.get() !== epoch || !entry.ended.compareAndSet(-1, now.coerceAtLeast(0))) return
        val record = entry.record.copy(ended = true, durationMs = (now - entry.since).coerceAtLeast(0))
        epoch.ended.set((epoch.cursor.getAndIncrement() % MAX_ENDED).toInt(), record)
        epoch.active.compareAndSet(ticket.slot, entry, null)
        epoch.revision.incrementAndGet()
    }
    fun hasWork(generation: Long): Boolean = state.get().let {
        it.generation == generation && ((0 until MAX_ACTIVE).any { slot -> it.active.get(slot) != null } || it.revision.get() > it.persisted.get())
    }
    /** Observer only. Samples unfinished waits after background/lease close,
     * without requiring any Main acknowledgement or completed GL frame. */
    fun sample(generation: Long, now: Long): Batch? {
        val epoch = state.get(); if (epoch.generation != generation) return null
        val revision = epoch.revision.get(); if (revision == 0L) return null
        val active = (0 until MAX_ACTIVE).mapNotNull { epoch.active.get(it) }
        val last = epoch.lastSample.get()
        if (revision <= epoch.persisted.get() && (active.isEmpty() || last != Long.MIN_VALUE && now - last < 10_000)) return null
        epoch.lastSample.set(now)
        val records = active.map { item ->
            val end = item.ended.get()
            item.record.copy(ended = end >= 0, durationMs = ((if (end >= 0) end else now) - item.since).coerceAtLeast(0))
        } + (0 until MAX_ENDED).mapNotNull { epoch.ended.get(it) }
        return Batch(epoch, revision, records.distinctBy { it.at to it.id }.sortedWith(compareBy({ it.at }, { it.id })))
    }
    fun saved(batch: Batch) { batch.epoch.persisted.accumulateAndGet(batch.revision, ::maxOf) }
    companion object { const val MAX_ACTIVE = 8; const val MAX_ENDED = 32 }
}
