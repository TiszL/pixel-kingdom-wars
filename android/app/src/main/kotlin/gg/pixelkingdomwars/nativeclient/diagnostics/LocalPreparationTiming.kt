package gg.pixelkingdomwars.nativeclient.diagnostics

import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.renderer.*
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicReferenceArray

/** Fixed anonymous ring. Revision/owner bindings are ephemeral; callbacks do no IO and use bounded CAS. */
internal class LocalPreparationTiming(private val mono: () -> Long) {
    internal data class Entry(val ordinal: Long, val since: Long, val at: Long, val build: String,
        val owner: Any?, val allowed: () -> Boolean, val revision: String? = null,
        val renderer: Long? = null, val stages: Map<String,Long> = mapOf("started" to 0L), val outcome: String = "pending")
    internal class Epoch(val generation: Long) {
        val entries = AtomicReferenceArray<Entry?>(LIMIT)
        val cursor = AtomicLong(); val dirty = AtomicLong(); val saved = AtomicLong()
    }
    class Batch internal constructor(internal val epoch: Epoch, val dirty: Long, val records: List<LocalPreparationRecord>)
    private val current = AtomicReference(Epoch(-1))
    private val ordinals = AtomicLong()
    fun reset(generation: Long) {
        val old = current.getAndSet(Epoch(generation))
        repeat(LIMIT) { old.entries.set(it, null) }
    }
    fun begin(generation: Long, owner: Any, at: Long, build: String, allowed: () -> Boolean): BattlePreparationTiming? {
        val epoch = current.get()
        if (epoch.generation != generation || !allowed()) return null
        val ordinal = ordinals.incrementAndGet(); val slot = (epoch.cursor.getAndIncrement() % LIMIT).toInt()
        epoch.entries.set(slot, Entry(ordinal, mono(), at, build, owner, allowed)); epoch.dirty.incrementAndGet()
        return object : BattlePreparationTiming {
            override val ordinal = ordinal
            override fun stage(stage: BattlePreparationStage) { milestone(epoch, slot, ordinal, stage.name.lowercase()) }
            override fun assembled(revision: String) {
                if (!revision.matches(Regex("[a-f0-9]{64}"))) return
                change(epoch, slot, ordinal) { e, _ -> if (e.revision == null) e.copy(revision = revision) else e }
            }
            override fun finish(outcome: BattlePreparationOutcome) { finish(epoch, slot, ordinal, outcome.name.lowercase()) }
        }
    }
    fun mapping(generation: Long, owner: Any, ordinal: Long, revision: String): LocalPreparationTrace? {
        val epoch = current.get()
        if (epoch.generation != generation) return null
        val slot = (0 until LIMIT).firstOrNull { epoch.entries.get(it)?.let { e -> e.ordinal == ordinal && e.owner === owner && e.revision == revision } == true } ?: return null
        // An assembly attempt can map only once. A later local retry must not graft its
        // successful end onto an earlier cancelled mapper's start.
        val admitted = change(epoch, slot, ordinal) { e, elapsed ->
            if ("assembly_complete" !in e.stages || "mapper_queued" in e.stages) e
            else e.copy(stages = e.stages + ("mapper_queued" to elapsed))
        }
        if (!admitted) return null
        return trace(epoch, slot, ordinal, null)
    }
    /** A fresh HTTP assembly reused a retained canonical scene; it did not run a mapper. */
    fun reuse(generation: Long, owner: Any, ordinal: Long, revision: String) {
        val epoch = current.get()
        if (epoch.generation != generation) return
        val slot = (0 until LIMIT).firstOrNull { epoch.entries.get(it)?.let { e ->
            e.ordinal == ordinal && e.owner === owner && e.revision == revision
        } == true } ?: return
        change(epoch, slot, ordinal) { e, elapsed ->
            if ("assembly_complete" !in e.stages || "mapper_queued" in e.stages) e
            else e.copy(outcome = "unchanged", stages = e.stages + ("ended" to elapsed),
                owner = null, revision = null, allowed = { false })
        }
    }
    private fun trace(epoch: Epoch, slot: Int, ordinal: Long, renderer: Long?): LocalPreparationTrace = object : LocalPreparationTrace {
        override fun stage(stage: LocalPreparationStage) {
            val e = epoch.entries.get(slot) ?: return
            if (e.ordinal != ordinal || e.renderer != renderer) return
            milestone(epoch, slot, ordinal, stage.name.lowercase(), renderer)
        }
        override fun renderer(generation: Long): LocalPreparationTrace? {
            if (renderer != null) return null
            val admitted = change(epoch, slot, ordinal) { e, elapsed ->
                if (e.renderer != null || "mapper_completed" !in e.stages) e
                else e.copy(renderer = generation, stages = e.stages + ("renderer_queued" to elapsed))
            }
            return if (admitted) trace(epoch, slot, ordinal, generation) else null
        }
        override fun finish(outcome: LocalPreparationOutcome) {
            if (epoch.entries.get(slot)?.renderer != renderer) return
            change(epoch, slot, ordinal) { e, elapsed ->
                if (e.renderer != renderer) e else e.copy(outcome = outcome.name.lowercase(), stages = e.stages + ("ended" to elapsed), owner = null, revision = null, allowed = { false })
            }
        }
    }
    private fun milestone(epoch: Epoch, slot: Int, ordinal: Long, stage: String, renderer: Long? = null) = change(epoch, slot, ordinal) { e, elapsed ->
        val previous = PREVIOUS[stage]
        if (stage in LOCAL_STAGES && e.renderer != renderer || stage !in STAGES || stage in e.stages || previous != null && previous !in e.stages) e
        else e.copy(stages = e.stages + (stage to elapsed), outcome = if (stage == "first_draw") "drawn" else e.outcome,
            owner = if (stage == "first_draw") null else e.owner, revision = if (stage == "first_draw") null else e.revision,
            allowed = if (stage == "first_draw") ({ false }) else e.allowed)
    }
    private fun finish(epoch: Epoch, slot: Int, ordinal: Long, outcome: String) = change(epoch, slot, ordinal) { e, elapsed ->
        e.copy(outcome = outcome, stages = e.stages + ("ended" to elapsed), owner = null, revision = null, allowed = { false })
    }
    private inline fun change(epoch: Epoch, slot: Int, ordinal: Long, change: (Entry,Long) -> Entry): Boolean {
        repeat(4) {
            val old = epoch.entries.get(slot) ?: return false
            if (current.get() !== epoch || old.ordinal != ordinal || old.outcome != "pending" || !old.allowed()) return false
            val elapsed = mono() - old.since
            if (elapsed !in 0..MAX_MS || elapsed < (old.stages.values.maxOrNull() ?: 0L)) return false
            val next = change(old, elapsed)
            if (next == old) return false
            if (epoch.entries.compareAndSet(slot, old, next)) { epoch.dirty.incrementAndGet(); return true }
        }
        return false
    }
    fun close(owner: Any) {
        val epoch = current.get()
        for (slot in 0 until LIMIT) repeat(4) {
            val old = epoch.entries.get(slot) ?: return@repeat
            if (old.owner !== owner || old.outcome != "pending") return@repeat
            val next = old.copy(owner = null, revision = null, allowed = { false }, outcome = "cancelled",
                stages = old.stages + ("ended" to (mono() - old.since).coerceIn(0, MAX_MS)))
            if (epoch.entries.compareAndSet(slot, old, next)) epoch.dirty.incrementAndGet()
        }
    }
    fun hasWork(generation: Long) = current.get().let { it.generation == generation && it.dirty.get() > it.saved.get() }
    fun sample(generation: Long): Batch? {
        val e = current.get()
        if (e.generation != generation) return null
        repeat(LIMIT) { slot ->
            val old = e.entries.get(slot) ?: return@repeat
            if (old.outcome == "pending" && (!old.allowed() || mono() - old.since > MAX_MS)) {
                val next = old.copy(owner = null, revision = null, outcome = if (old.allowed()) "expired" else "cancelled", allowed = { false })
                if (e.entries.compareAndSet(slot, old, next)) e.dirty.incrementAndGet()
            }
        }
        val dirty = e.dirty.get()
        if (dirty <= e.saved.get()) return null
        return Batch(e, dirty, (0 until LIMIT).mapNotNull { e.entries.get(it)?.let { v ->
            LocalPreparationRecord(v.at, v.ordinal, v.stages, v.outcome, v.build)
        } }.sortedBy { it.ordinal }.takeLast(LIMIT))
    }
    fun saved(batch: Batch) { batch.epoch.saved.accumulateAndGet(batch.dirty, ::maxOf) }
    companion object {
        const val LIMIT = 32
        const val MAX_MS = 120_000L
        private val LOCAL_STAGES = LocalPreparationStage.entries.map { it.name.lowercase() }.toSet()
        val STAGES = setOf("started", "ended") + BattlePreparationStage.entries.map { it.name.lowercase() } + LOCAL_STAGES
        val OUTCOMES = setOf("pending", "drawn", "cancelled", "failed", "unchanged", "superseded", "expired")
        private val PREVIOUS = mapOf("response_headers" to "call_enqueued", "body_read" to "response_headers", "json_parsed" to "body_read",
            "assembly_complete" to "json_parsed", "mapper_started" to "mapper_queued", "mapper_completed" to "mapper_started", "renderer_started" to "renderer_queued",
            "renderer_completed" to "renderer_started", "gl_activated" to "renderer_completed", "first_draw" to "gl_activated")
    }
}
