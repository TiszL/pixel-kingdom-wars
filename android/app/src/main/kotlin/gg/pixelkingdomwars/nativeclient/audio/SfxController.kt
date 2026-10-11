package gg.pixelkingdomwars.nativeclient.audio

import kotlinx.coroutines.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import java.io.Closeable

private class SfxCache(private val budget: PcmBudget, private val mixer: SfxMixer) : Closeable {
    private data class Entry(val clip: PcmClip, val lease: AudioAssetLease, var used: Long)
    private val entries = mutableMapOf<String, Entry>()
    private val pins = mutableMapOf<String, Int>()
    private var sequence = 0L
    init { budget.reclaim = ::reclaim }
    @Synchronized fun has(id: String) = id in entries
    @Synchronized fun <T> withClip(id: String, block: (PcmClip) -> T): T? = entries[id]?.let { it.used = ++sequence; block(it.clip) }
    @Synchronized fun put(id: String, clip: PcmClip, lease: AudioAssetLease) {
        check(id !in entries); entries[id] = Entry(clip, lease, ++sequence)
    }
    @Synchronized fun pin(ids: Collection<String>) { ids.forEach { pins[it] = (pins[it] ?: 0) + 1 } }
    @Synchronized fun unpin(ids: Collection<String>) { ids.forEach { val n = (pins[it] ?: 0) - 1; if (n > 0) pins[it] = n else pins.remove(it) } }
    @Synchronized private fun reclaim(required: Long) {
        val candidates = entries.entries.filter { (pins[it.key] ?: 0) == 0 && mixer.retained(it.key) == 0 }
            .sortedWith(compareBy<Map.Entry<String, Entry>> { it.value.used }.thenBy { it.key })
        for ((id, entry) in candidates) {
            if (required <= budget.limit - budget.usedBytes()) break
            entries.remove(id); entry.clip.close(); entry.lease.close()
        }
    }
    @Synchronized override fun close() {
        entries.values.forEach { it.clip.close(); it.lease.close() }; entries.clear(); pins.clear()
    }
}

class SfxBank internal constructor(val ready: Deferred<Unit>, private val release: () -> Unit) : Closeable {
    var isClosed = false; private set
    override fun close() { if (!isClosed) { isClosed = true; release() } }
}

data class SfxDiagnostics(val decodedBytes: Long, val activeLoads: Int, val voicesAndLoops: Int)

/** Main-dispatcher SFX owner. MusicController supplies its SINGLE focus admission; this class
 * never asks Android for focus. Only current events play. Warm completions cannot replay a
 * one-shot; loop completions require an unclosed current actor/ambience handle. */
class SfxController(
    private val scope: CoroutineScope, private val source: AudioAssetSource,
    private val decoder: SfxDecoder, private val outputFactory: SfxOutputFactory,
    private val nowMs: () -> Long,
    private val planningDispatcher: CoroutineDispatcher = Dispatchers.Default,
) : Closeable {
    private class Load(val id: String, val definition: AudioDefinition, val pack: AudioPack, val ticket: Long) {
        val done = CompletableDeferred<Unit>(); var job: Job? = null; var demands = 0
    }
    private var context: MusicContext? = null
    private var enabled = false; private var closed = false; private var epoch = 0L
    private var generation = 0L
    val contentGeneration: Long get() = generation
    var definitionsRevision = 0L; private set
    private var budget: PcmBudget? = null
    private var mixer: SfxMixer? = null
    private var cache: SfxCache? = null
    private var output: SfxOutput? = null
    private var outputFailed = false
    private var definitions: AudioDefinitions? = null
    private var definitionsLoadedFor: String? = null
    private var manifestJob: Job? = null
    private var nextManifestAttempt = 0L
    private val capacityRejected = mutableSetOf<String>()
    private val failedUntil = mutableMapOf<String, Long>()
    val isAudible: Boolean get() = enabled && !closed && !outputFailed
    private val loads = mutableMapOf<String, Load>()
    private val queue = ArrayDeque<Load>()
    private var activeLoads = 0 // Includes cancelled old-generation decoders until their finally returns.
    private val banks = mutableSetOf<SfxBank>()
    private val loops = mutableSetOf<Closeable>()
    private var ambience: Closeable? = null
    private var ambienceFamily: String? = null
    private var ambienceScreen: String? = null

    /** Called synchronously by the sole focus owner, on main, before any subsequent game cue. */
    fun update(value: MusicContext?, focused: Boolean, explicitRetry: Boolean = true) {
        if (closed) return
        val old = context
        val replaced = old?.identity !== value?.identity || old?.pack?.identity != value?.pack?.identity
        val allowed = value?.foreground == true && value.soundFx && value.pack != null && focused
        if (replaced || !allowed) stopPlayback()
        if (replaced) {
            generation++; manifestJob?.cancel(); manifestJob = null
            cache?.close(); cache = null; mixer = null; definitions = null; definitionsLoadedFor = null; nextManifestAttempt = 0; capacityRejected.clear(); failedUntil.clear()
        }
        context = value; enabled = allowed
        val pack = value?.pack ?: return
        if (cache == null) {
            val allocation = budget ?: PcmBudget(pack.runtime.maxDecodedBytes).also { budget = it }
            allocation.setLimit(pack.runtime.maxDecodedBytes)
            mixer = SfxMixer(pack.runtime); cache = SfxCache(allocation, requireNotNull(mixer))
            definitions = AudioDefinitions.from(pack)
        }
        if (!allowed) return
        if (replaced || explicitRetry) outputFailed = false
        if (outputFailed) { enabled = false; return }
        ensureOutput(); loadManifest(); updateAmbience(); pump()
    }
    private fun ensureOutput() {
        if (!enabled || outputFailed || output != null) return
        val selected = mixer ?: return
        val ticket = epoch
        output = try { outputFactory.create(selected) {
            if (!closed && ticket == epoch && mixer === selected) {
                stopPlayback(); outputFailed = true
            }
        } } catch (_: Exception) { outputFailed = true; null }
    }
    private fun current(ticket: Long) = !closed && enabled && !outputFailed && generation == ticket

    private fun loadManifest() {
        val pack = context?.pack ?: return
        if (manifestJob?.isActive == true || definitionsLoadedFor == pack.identity || nowMs() < nextManifestAttempt) return
        val ticket = generation
        manifestJob = scope.launch {
            var lease: AudioAssetLease? = null
            try {
                lease = source.acquire(pack, setOf("audio/sfx-ai/manifest.json"))
                ensureActive(); if (!current(ticket)) return@launch
                val file = lease.file("audio/sfx-ai/manifest.json")
                // Same technical JSON cap as the existing verified content transport.
                require(file.length() <= 16L * 1024 * 1024)
                val parsed = withContext(Dispatchers.IO) { Json.parseToJsonElement(file.readText()).jsonObject }
                ensureActive(); if (!current(ticket)) return@launch
                val prepared = withContext(planningDispatcher) { AudioDefinitions.from(pack, parsed) }
                ensureActive(); if (!current(ticket)) return@launch
                definitions = prepared; definitionsLoadedFor = pack.identity; definitionsRevision++
                updateAmbience()
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { if (generation == ticket) nextManifestAttempt = audioRetryDeadline(nowMs(), audioRetryDelayMs(error, pack.runtime.manifestRetryDelayMs)) }
            finally { lease?.close() }
        }
    }

    /** A one-shot never holds an old event behind a network/decode promise. */
    fun playFamily(family: String, key: String, fallback: String? = null,
                   gain: Float = 1f, priority: AudioPriority = AudioPriority.NORMAL): Boolean {
        if (!enabled || outputFailed || closed || !gain.isFinite()) return false
        val selected = definitions?.resolve(family, key)
        if (selected != null && cache?.has(selected.id) == true) return playReady(selected.id, gain, priority)
        selected?.let { warm(it.id) }
        return fallback?.let { play(it, gain, priority) } ?: false
    }
    fun play(id: String, gain: Float = 1f, priority: AudioPriority = AudioPriority.NORMAL): Boolean {
        if (!enabled || outputFailed || closed || !gain.isFinite()) return false
        if (cache?.has(id) == true) return playReady(id, gain, priority)
        warm(id); return false
    }
    private fun playReady(id: String, gain: Float, priority: AudioPriority): Boolean {
        val selected = mixer ?: return false
        val played = cache?.withClip(id) { selected.oneShot(id, it, gain.coerceIn(0f, 1f), priority, nowMs()) } == true
        if (played) { ensureOutput(); output?.wake() }
        return played
    }

    /** Current actors own this handle. Sharing a cue shares a source and uses max gain.
     * A closed handle during cold loading can never start a loop afterward. */
    fun loopFamily(family: String, key: String, fallback: String? = null, gain: Float = 1f): Closeable {
        if (!enabled || outputFailed || closed || !gain.isFinite()) return Closeable { }
        val selected = definitions?.resolve(family, key, loop = true)
        val definition = if (selected != null && cache?.has(selected.id) == true) selected
            else { selected?.let { warm(it.id) }; fallback?.let { definitions?.get(it) } }
            ?: return Closeable { }
        if (!definition.loopSafe) return Closeable { }
        return loop(definition, gain)
    }
    private fun loop(definition: AudioDefinition, gain: Float): Closeable {
        val ticket = epoch; val selectedMixer = mixer ?: return Closeable { }; val selectedCache = cache ?: return Closeable { }
        var stopped = false; var token: Long? = null; var waiter: Job? = null
        selectedCache.pin(listOf(definition.id))
        lateinit var handle: Closeable
        handle = Closeable {
            if (!stopped) { stopped = true; waiter?.cancel(); token?.let { selectedMixer.stopLoop(definition.id, it) }
                selectedCache.unpin(listOf(definition.id)); loops.remove(handle) }
        }
        loops += handle
        val load = demand(definition.id)
        waiter = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                if (load != null) withTimeoutOrNull(load.pack.runtime.bankReadyDeadlineMs) { load.done.await() }
                if (stopped || closed || !enabled || outputFailed || ticket != epoch || mixer !== selectedMixer) return@launch
                token = selectedCache.withClip(definition.id) { selectedMixer.loop(definition.id, it, definition, gain.coerceIn(0f, 1f)) }
                if (token != null) { ensureOutput(); output?.wake() }
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { /* Invalid loop metadata remains silent. */ }
            finally { load?.let(::releaseDemand) }
        }
        return handle
    }
    private fun updateAmbience() {
        val screen = context?.screen ?: return
        val family = ambienceFamilyForScreen(screen)
        if (ambience != null && family == ambienceFamily && screen == ambienceScreen) return
        ambience?.close(); ambience = null; ambienceFamily = family; ambienceScreen = screen
        val definition = family?.let { definitions?.resolve(it, screen, loop = true) } ?: return
        if (enabled) ambience = loop(definition, context!!.pack!!.runtime.ambienceVolume)
    }

    fun bank(ids: Collection<String>): SfxBank {
        val selected = cache; val unique = ids.distinct().filter { definitions?.get(it) != null }
        val held = mutableListOf<Load>(); val ready = CompletableDeferred<Unit>()
        var timer: Job? = null; var released = false
        lateinit var bank: SfxBank
        fun abandonLoads() { held.toList().forEach(::releaseDemand); held.clear() }
        bank = SfxBank(ready) {
            if (!released) { released = true; timer?.cancel(); abandonLoads(); selected?.unpin(unique); capacityRejected.clear(); banks.remove(bank); ready.complete(Unit) }
        }
        if (!enabled || closed || outputFailed || selected == null) { bank.close(); return bank }
        banks += bank; selected.pin(unique)
        unique.forEach { demand(it)?.let(held::add) }
        val runtime = context!!.pack!!.runtime
        timer = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try { withTimeoutOrNull(runtime.bankReadyDeadlineMs) { held.toList().forEach { it.done.await() } } }
            finally { abandonLoads(); ready.complete(Unit) }
        }
        return bank
    }
    fun warm(id: String) {
        val load = demand(id) ?: return
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try { withTimeoutOrNull(load.pack.runtime.bankReadyDeadlineMs) { load.done.await() } }
            finally { releaseDemand(load) }
        }
    }
    private fun demand(id: String): Load? {
        if (mixer?.drainEnded()?.isNotEmpty() == true) capacityRejected.clear()
        if (id in capacityRejected || nowMs() < (failedUntil[id] ?: Long.MIN_VALUE)) return null
        if (!enabled || closed || outputFailed || cache?.has(id) == true) return null
        val pack = context?.pack ?: return null
        val definition = definitions?.get(id) ?: return null
        val load = loads[id]?.takeUnless { it.job?.isCancelled == true } ?: Load(id, definition, pack, generation).also { loads[id] = it; queue += it }
        load.demands++; pump(); return load
    }
    private fun releaseDemand(load: Load) {
        load.demands--
        if (load.demands <= 0 && !load.done.isCompleted) { queue.remove(load); load.job?.cancel(); if (load.job == null) finish(load) }
    }
    private fun finish(load: Load) {
        if (loads[load.id] === load) loads.remove(load.id)
        load.done.complete(Unit)
    }
    private fun pump() {
        val runtime = context?.pack?.runtime ?: return
        while (enabled && !closed && !outputFailed && activeLoads < runtime.preloadConcurrency && queue.isNotEmpty()) {
            val load = queue.removeFirst()
            if (!current(load.ticket) || load.demands <= 0) { finish(load); continue }
            activeLoads++
            val selectedCache = requireNotNull(cache); val allocation = requireNotNull(budget)
            load.job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
                var lease: AudioAssetLease? = null; var clip: PcmClip? = null
                try {
                    lease = source.acquire(load.pack, setOf(load.definition.path))
                    ensureActive(); if (!current(load.ticket) || load.demands <= 0) return@launch
                    clip = decoder.decode(lease.file(load.definition.path), allocation)
                    ensureActive(); if (!current(load.ticket) || load.demands <= 0 || cache !== selectedCache) return@launch
                    selectedCache.put(load.id, clip, lease); clip = null; lease = null
                } catch (error: CancellationException) { throw error }
                catch (_: PcmCapacityException) { if (current(load.ticket)) capacityRejected += load.id }
                catch (error: Exception) {
                    // A new frame/cue is not a reason to retry a failed optional download.
                    // Keep ready sounds playable; only this missing sample waits before a new demand.
                    if (current(load.ticket)) failedUntil[load.id] = audioRetryDeadline(nowMs(),
                        audioRetryDelayMs(error, load.pack.runtime.manifestRetryDelayMs))
                }
                finally { clip?.close(); lease?.close(); activeLoads--; finish(load); pump() }
            }
        }
    }
    private fun stopPlayback() {
        epoch++; enabled = false
        output?.close(); output = null
        mixer?.stopAll()
        ambience?.close(); ambience = null; ambienceFamily = null; ambienceScreen = null
        loops.toList().forEach { it.close() }; banks.toList().forEach { it.close() }
        manifestJob?.cancel(); manifestJob = null
        queue.toList().forEach { finish(it) }; queue.clear()
        loads.values.toList().forEach { it.job?.cancel() }
    }
    suspend fun awaitDefinitions() { manifestJob?.join() }
    fun familyIds(families: Collection<String>): List<String> = definitions?.familyIds(families).orEmpty()
    /** Capture immutable definitions on Main, resolve the journal on a worker. The caller
     * owns cancellation; stale account/manifest results never install into a current bank. */
    fun prepareBattleBanks(plan: List<BattleAudioCue>, ready: (PreparedBattleBanks) -> Unit): Job {
        val values = definitions; val runtime = context?.pack?.runtime
        val selectedGeneration = generation; val selectedRevision = definitionsRevision
        return scope.launch {
            val prepared = withContext(planningDispatcher) {
                val fallbackLast = linkedMapOf<String, Double>()
                plan.forEach { cue -> ensureActive(); cue.fallback?.let { fallbackLast[it] = maxOf(fallbackLast[it] ?: 0.0, cue.atMs) } }
                PreparedBattleBanks(if (values == null || runtime == null) emptyList()
                    else battleAudioWindows(plan, values, runtime) { ensureActive() }, fallbackLast)
            }
            ensureActive()
            if (!closed && generation == selectedGeneration && definitionsRevision == selectedRevision) ready(prepared)
        }
    }
    fun diagnostics() = SfxDiagnostics(budget?.usedBytes() ?: 0, activeLoads, mixer?.activeCount() ?: 0)
    override fun close() {
        if (closed) return
        stopPlayback(); closed = true; generation++; context = null
        cache?.close(); cache = null; budget?.reclaim = null
    }
}
