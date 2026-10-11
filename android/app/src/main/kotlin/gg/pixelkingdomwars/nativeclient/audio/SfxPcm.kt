package gg.pixelkingdomwars.nativeclient.audio

import java.io.Closeable
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean

class PcmCapacityException : IllegalStateException("Optional audio PCM capacity exhausted")

/** One ceiling for every in-flight, cached and playing PCM allocation. Encoded content
 * stays file-backed. Reservation happens BEFORE allocating each float page. */
class PcmBudget(limit: Long) {
    @Volatile var limit: Long = limit; private set
    @Volatile internal var reclaim: ((Long) -> Unit)? = null
    init { require(limit > 0) }
    private var used = 0L
    @Synchronized fun usedBytes(): Long = used
    @Synchronized fun setLimit(value: Long) { require(value > 0); limit = value }
    @Synchronized private fun take(bytes: Long): Boolean {
        if (bytes > limit - used) return false
        used += bytes; return true
    }
    internal fun reserve(bytes: Long) {
        require(bytes > 0)
        if (take(bytes)) return
        reclaim?.invoke(bytes) // Never call the cache while holding the allocation lock.
        if (!take(bytes)) throw PcmCapacityException()
    }
    @Synchronized internal fun release(bytes: Long) { check(bytes <= used); used -= bytes }
}

/** Variable-size immutable pages avoid a second contiguous copy and account exact capacity. */
class PcmClip internal constructor(
    val sampleRate: Int, val channels: Int, private val pages: List<FloatArray>,
    private val budget: PcmBudget,
) : Closeable {
    private val ends = IntArray(pages.size)
    private var closing = false
    private var readers = 0
    private val released = AtomicBoolean(false)
    val sampleCount: Int
    val frames: Int
    val bytes: Long
    init {
        require(sampleRate > 0 && channels in 1..2 && pages.isNotEmpty())
        var size = 0
        pages.forEachIndexed { i, p -> size = Math.addExact(size, p.size); ends[i] = size }
        require(size > 0 && size % channels == 0)
        sampleCount = size; frames = size / channels; bytes = size.toLong() * Float.SIZE_BYTES
    }
    internal fun sample(frame: Int, channel: Int): Float {
        check(!released.get()); require(frame in 0 until frames)
        val index = frame * channels + if (channels == 1) 0 else channel
        val found = ends.binarySearch(index + 1)
        val page = if (found >= 0) found else -found - 1
        return pages[page][index - if (page == 0) 0 else ends[page - 1]]
    }
    /** A running mixer keeps the original PCM reservation until its block finishes,
     * even when an account change closes the cache without waiting for that worker. */
    @Synchronized internal fun retainForRender(): Boolean {
        if (closing) return false
        readers++; return true
    }
    @Synchronized internal fun releaseFromRender() { check(readers > 0); readers--; releaseIfUnused() }
    private fun releaseIfUnused() {
        if (closing && readers == 0 && released.compareAndSet(false, true)) budget.release(bytes)
    }
    @Synchronized override fun close() { closing = true; releaseIfUnused() }
}

class PcmBuilder(private val budget: PcmBudget, private val sampleRate: Int, private val channels: Int) : Closeable {
    private val pages = mutableListOf<FloatArray>()
    private var samples = 0
    private var transferred = false
    init { require(sampleRate > 0 && channels in 1..2) }
    /** MediaCodec specifies native-endian float or signed 16-bit PCM. Reject partial frames,
     * nonfinite data, capacity failure or unsupported format without publishing a prefix. */
    fun append(bytes: ByteBuffer, floatingPoint: Boolean) {
        check(!transferred)
        val width = if (floatingPoint) Float.SIZE_BYTES else Short.SIZE_BYTES
        require(bytes.remaining() % (width * channels) == 0)
        val count = bytes.remaining() / width
        if (count == 0) return
        val allocationBytes = count.toLong() * Float.SIZE_BYTES
        val nextSize = Math.addExact(samples, count)
        budget.reserve(allocationBytes)
        try {
            val page = FloatArray(count)
            val data = bytes.slice().order(ByteOrder.nativeOrder())
            for (i in page.indices) {
                val value = if (floatingPoint) data.float else data.short / 32768f
                require(value.isFinite())
                page[i] = value
            }
            pages += page; samples = nextSize
        } catch (error: Throwable) { budget.release(allocationBytes); throw error }
    }
    fun finish(): PcmClip {
        check(!transferred)
        val clip = PcmClip(sampleRate, channels, pages.toList(), budget)
        transferred = true; pages.clear()
        return clip
    }
    override fun close() {
        if (!transferred) { transferred = true; budget.release(samples.toLong() * Float.SIZE_BYTES); pages.clear() }
    }
}

/** Shared PCM is never copied per voice. Control calls only lock a voice snapshot and
 * reconciliation, never interpolation of a PCM block. Output teardown also runs off Main. */
class SfxMixer(private val runtime: AudioRuntime, private val renderStarted: () -> Unit = {}) {
    private data class Playback(val token: Long, val cue: String, val clip: PcmClip,
                                var gain: Float, var position: Double = 0.0,
                                val loopStart: Double? = null, val loopEnd: Double? = null)
    private data class Loop(val playback: Playback, val requests: MutableMap<Long, Float>)
    private val admission = AudioVoicePlan(runtime)
    private val voices = mutableMapOf<Long, Playback>()
    private val loops = mutableMapOf<String, Loop>()
    private var sequence = 0L
    private val ended = mutableListOf<String>()
    private val rendering = mutableMapOf<String, Int>()
    private val renderLock = Any() // Only output workers acquire this; control calls never do.

    @Synchronized fun oneShot(cue: String, clip: PcmClip, gain: Float, priority: AudioPriority, nowMs: Long): Boolean {
        require(gain.isFinite() && gain in 0f..1f)
        val result = admission.admit(cue, priority, nowMs)
        result.evicted.forEach { removeVoice(it.token) }
        val voice = result.voice ?: return false
        voices[voice.token] = Playback(voice.token, cue, clip, gain)
        return true
    }
    /** One source per cue, canonical maximum requested volume. A zero-to-one transition
     * owns one PCM retain; stopping another actor cannot terminate a shared loop. */
    @Synchronized fun loop(cue: String, clip: PcmClip, definition: AudioDefinition, gain: Float): Long {
        require(gain.isFinite() && gain in 0f..1f && definition.loopSafe)
        val start = (definition.loopStartSeconds ?: 0.0) * clip.sampleRate
        val end = (definition.loopEndSeconds ?: (clip.frames.toDouble() / clip.sampleRate)) * clip.sampleRate
        require(start.isFinite() && end.isFinite() && start >= 0 && start < end && end <= clip.frames)
        val token = ++sequence
        val existing = loops[cue]
        if (existing != null) {
            check(existing.playback.clip === clip)
            existing.requests[token] = gain; existing.playback.gain = existing.requests.values.max()
        } else loops[cue] = Loop(Playback(token, cue, clip, gain, loopStart = start, loopEnd = end), mutableMapOf(token to gain))
        return token
    }
    @Synchronized fun stopLoop(cue: String, token: Long) {
        val loop = loops[cue] ?: return
        loop.requests.remove(token)
        if (loop.requests.isEmpty()) { loops.remove(cue); ended += cue }
        else loop.playback.gain = loop.requests.values.max()
    }
    @Synchronized fun loopExists(cue: String) = cue in loops
    @Synchronized fun retained(cue: String) = voices.values.count { it.cue == cue } +
        (if (cue in loops) 1 else 0) + (rendering[cue] ?: 0)
    @Synchronized fun activeCount() = voices.size + loops.size
    @Synchronized fun drainEnded(): List<String> = ended.toList().also { ended.clear() }
    @Synchronized fun stopAll() {
        voices.values.forEach { ended += it.cue }; loops.keys.forEach { ended += it }
        voices.clear(); loops.clear(); admission.clear()
    }
    private fun removeVoice(token: Long) {
        voices.remove(token)?.let { ended += it.cue }; admission.ended(token)
    }
    /** Stereo float output at the device's native rate. Linear interpolation preserves the
     * entire source duration, source channels and fractional measured loop boundaries. */
    fun render(output: FloatArray, outputSampleRate: Int): Boolean = synchronized(renderLock) {
        require(output.size % 2 == 0 && outputSampleRate > 0)
        output.fill(0f)
        val snapshot = synchronized(this) {
            (voices.values.toList() + loops.values.map { it.playback }).mapNotNull { original ->
                if (!original.clip.retainForRender()) null else {
                    rendering[original.cue] = (rendering[original.cue] ?: 0) + 1
                    original to original.copy()
                }
            }
        }
        if (snapshot.isEmpty()) return@synchronized false
        val finished = HashSet<Long>()
        try {
            renderStarted()
            for ((_, voice) in snapshot) {
                val step = voice.clip.sampleRate.toDouble() / outputSampleRate
                for (frame in 0 until output.size / 2) {
                    val end = voice.loopEnd ?: voice.clip.frames.toDouble()
                    if (voice.position >= end) {
                        if (voice.loopStart == null) { finished += voice.token; break }
                        voice.position = voice.loopStart + (voice.position - end) % (end - voice.loopStart)
                    }
                    for (channel in 0..1) output[frame * 2 + channel] += signal(voice, channel) * voice.gain
                    voice.position += step
                }
            }
            output.indices.forEach { output[it] = output[it].coerceIn(-1f, 1f) }
        } finally {
            synchronized(this) {
                snapshot.forEach { (original, rendered) ->
                    // A stopped/evicted voice or a newly created loop cannot be resurrected.
                    if (voices[original.token] === original) {
                        if (original.token in finished) removeVoice(original.token) else original.position = rendered.position
                    } else if (loops[original.cue]?.playback === original) original.position = rendered.position
                    val retained = rendering.getValue(original.cue) - 1
                    if (retained == 0) rendering.remove(original.cue) else rendering[original.cue] = retained
                    original.clip.releaseFromRender()
                }
            }
        }
        true
    }
    private fun sourceSignal(clip: PcmClip, position: Double, channel: Int): Float {
        val low = position.toInt().coerceIn(0, clip.frames - 1)
        val high = (low + 1).coerceAtMost(clip.frames - 1)
        val fraction = (position - low).toFloat()
        val a = clip.sample(low, channel); val b = clip.sample(high, channel)
        return a + (b - a) * fraction
    }
    private fun signal(voice: Playback, channel: Int): Float {
        val start = voice.loopStart
        if (start == null || voice.position < start) return sourceSignal(voice.clip, voice.position, channel)
        val end = requireNotNull(voice.loopEnd)
        // Web Audio loop endpoints have subsample accuracy. The virtual frame at
        // the exclusive end is the interpolated loop start, never an out-of-loop
        // sample (and never a clamped final sample for whole-buffer loops).
        val left = maxOf(voice.position.toInt().toDouble(), start)
        val right = minOf(voice.position.toInt() + 1.0, end)
        val a = sourceSignal(voice.clip, left, channel)
        val b = sourceSignal(voice.clip, if (right == end) start else right, channel)
        val fraction = ((voice.position - left) / (right - left)).toFloat()
        return a + (b - a) * fraction
    }

}
