package gg.pixelkingdomwars.nativeclient.diagnostics

import gg.pixelkingdomwars.nativeclient.network.BattleCommandStage
import gg.pixelkingdomwars.nativeclient.network.BattleCommandTransportTiming
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicReferenceArray

/** Fixed local ring. Callers never wait for IO, a sampler lock, or unbounded CAS retries.
 * Original IDs exist only in the enabled epoch, become unusable after two minutes,
 * are removed on the next sample/close, and never enter records. */
internal class LocalCommandTiming(private val mono: () -> Long) {
    class Session internal constructor() { internal val active = AtomicBoolean(true) }
    internal class Epoch(val generation: Long) {
        val entries = AtomicReferenceArray<Entry?>(LIMIT)
        val cursor = AtomicLong()
        val revision = AtomicLong()
        val saved = AtomicLong()
    }
    internal data class Entry(val session: Session, val alias: Long, val since: Long, val at: Long, val build: String,
        val id: String? = null, val stages: Map<BattleCommandStage, Long> = emptyMap())
    class Ticket internal constructor(internal val epoch: Epoch, internal val slot: Int, internal val alias: Long)
    class Batch internal constructor(internal val epoch: Epoch, val revision: Long, val records: List<LocalCommandRecord>)
    private val epoch = AtomicReference(Epoch(-1))
    private val aliases = AtomicLong()
    fun reset(generation: Long) {
        val old = epoch.getAndSet(Epoch(generation))
        // Old input callbacks can hold their ticket; clearing also releases its ID association.
        for (slot in 0 until LIMIT) old.entries.set(slot, null)
    }
    fun session() = Session()
    /** Selection epochs renew only timing, never the gameplay coordinator. Old tickets stay closed. */
    private data class Selected(val epoch: Long, val session: Session)
    inner class SelectionScope {
        private val selected = AtomicReference<Selected?>(null)
        private val closed = AtomicBoolean(false)
        fun current(selection: Long): Session? {
            if (closed.get()) return null
            repeat(4) {
                val old = selected.get()
                if (old != null && selection < old.epoch) return null
                if (old?.epoch == selection) return old.session.takeIf { it.active.get() }
                val next = Selected(selection, session())
                if (selected.compareAndSet(old, next)) {
                    old?.let { this@LocalCommandTiming.close(it.session) }
                    if (closed.get()) { this@LocalCommandTiming.close(next.session); return null }
                    return next.session
                }
            }
            return null
        }
        fun close() { closed.set(true); selected.getAndSet(null)?.let { this@LocalCommandTiming.close(it.session) } }
    }
    fun close(session: Session) {
        session.active.set(false)
        val current = epoch.get()
        for (slot in 0 until LIMIT) {
            val entry = current.entries.get(slot) ?: continue
            if (entry.session === session) current.entries.compareAndSet(slot, entry, entry.copy(id = null))
        }
    }
    fun input(generation: Long, session: Session, at: Long, build: String): Ticket? {
        val current = epoch.get()
        if (current.generation != generation || !session.active.get()) return null
        val alias = aliases.incrementAndGet()
        val slot = (current.cursor.getAndIncrement() % LIMIT).toInt()
        current.entries.set(slot, Entry(session, alias, mono(), at, build))
        current.revision.incrementAndGet()
        return Ticket(current, slot, alias)
    }
    fun bind(ticket: Ticket, id: String) {
        if (id.isEmpty() || id.length > 128 || epoch.get() !== ticket.epoch) return
        update(ticket.epoch, ticket.slot, ticket.alias) { entry, elapsed ->
            if (entry.id != null) entry else entry.copy(id = id,
                stages = entry.stages + (BattleCommandStage.ORIGINAL_ID_BOUND to elapsed))
        }
    }
    fun stage(generation: Long, session: Session, id: String, stage: BattleCommandStage) {
        if (stage == BattleCommandStage.ORIGINAL_ID_BOUND) return
        val current = epoch.get()
        if (current.generation != generation || !session.active.get()) return
        for (slot in 0 until LIMIT) {
            val entry = current.entries.get(slot) ?: continue
            if (entry.session === session && entry.id == id) {
                update(current, slot, entry.alias) { previous, elapsed ->
                    if (stage in previous.stages) previous else previous.copy(stages = previous.stages + (stage to elapsed))
                }
                return
            }
        }
    }
    /** Claim only the first attempt, so a later retry cannot fill holes in a failed attempt's
     * timeline. The returned callback retains an ordinal, never the original command ID. */
    fun transport(generation: Long, session: Session, id: String): BattleCommandTransportTiming? {
        val current = epoch.get()
        if (current.generation != generation || !session.active.get()) return null
        for (slot in 0 until LIMIT) {
            val entry = current.entries.get(slot) ?: continue
            if (entry.session !== session || entry.id != id) continue
            val alias = entry.alias
            repeat(4) {
                val old = current.entries.get(slot) ?: return null
                if (old.alias != alias || !session.active.get() || epoch.get() !== current ||
                    BattleCommandStage.TRANSPORT_ADMITTED in old.stages) return null
                val elapsed = mono() - old.since
                if (elapsed !in 0..ASSOCIATION_MS) return null
                val next = old.copy(stages = old.stages + (BattleCommandStage.TRANSPORT_ADMITTED to elapsed))
                if (current.entries.compareAndSet(slot, old, next)) {
                    current.revision.incrementAndGet()
                    return BattleCommandTransportTiming { stage -> stageAlias(generation, session, alias, stage) }
                }
            }
            return null
        }
        return null
    }
    fun aliases(generation: Long, session: Session, ids: Set<String>): Map<String,Long> {
        val current=epoch.get()
        if(current.generation!=generation || !session.active.get())return emptyMap()
        return (0 until LIMIT).mapNotNull { current.entries.get(it) }.filter {
            it.session===session && it.id in ids && mono()-it.since in 0..ASSOCIATION_MS
        }.associate { requireNotNull(it.id) to it.alias }
    }
    fun stageAlias(generation: Long, session: Session, alias: Long, stage: BattleCommandStage) {
        val current=epoch.get()
        if(current.generation!=generation || !session.active.get())return
        for(slot in 0 until LIMIT) {
            val entry=current.entries.get(slot) ?: continue
            if(entry.session===session && entry.alias==alias) {
                update(current,slot,alias) { previous,elapsed ->
                    if(stage in previous.stages)previous else previous.copy(stages=previous.stages+(stage to elapsed))
                };return
            }
        }
    }
    private inline fun update(current: Epoch, slot: Int, alias: Long, change: (Entry, Long) -> Entry) {
        repeat(4) {
            val old = current.entries.get(slot) ?: return
            if (old.alias != alias || !old.session.active.get() || epoch.get() !== current) return
            val elapsed = mono() - old.since
            if (elapsed !in 0..ASSOCIATION_MS) {
                current.entries.compareAndSet(slot, old, old.copy(id = null)); return
            }
            val next = change(old, elapsed)
            if (old == next) return
            if (current.entries.compareAndSet(slot, old, next)) { current.revision.incrementAndGet(); return }
        }
    }
    fun hasWork(generation: Long) = epoch.get().let { it.generation == generation && it.revision.get() > it.saved.get() }
    fun sample(generation: Long): Batch? {
        val current = epoch.get(); val revision = current.revision.get()
        if (current.generation != generation) return null
        // Cleanup is independent of dirty report data; it never schedules a disk write.
        for (slot in 0 until LIMIT) {
            val entry = current.entries.get(slot) ?: continue
            if (mono() - entry.since > ASSOCIATION_MS || !entry.session.active.get()) current.entries.compareAndSet(slot, entry, entry.copy(id = null))
        }
        if (revision <= current.saved.get()) return null
        val records = (0 until LIMIT).mapNotNull { slot -> current.entries.get(slot)?.let { entry ->
            LocalCommandRecord(entry.at, entry.alias, entry.stages.mapKeys { it.key.name.lowercase() }, entry.build)
        } }.sortedBy { it.alias }.takeLast(RECORD_LIMIT)
        return Batch(current, revision, records)
    }
    fun saved(batch: Batch) { batch.epoch.saved.accumulateAndGet(batch.revision, ::maxOf) }
    companion object { const val LIMIT = 128; const val RECORD_LIMIT = 64; const val ASSOCIATION_MS = 120_000L }
}
