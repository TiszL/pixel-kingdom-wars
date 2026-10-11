package gg.pixelkingdomwars.nativeclient.audio

import android.media.*
import kotlinx.coroutines.*
import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer

fun interface SfxDecoder { suspend fun decode(file: File, budget: PcmBudget): PcmClip }
interface SfxOutput : Closeable { fun wake() }
fun interface SfxOutputFactory { fun create(mixer: SfxMixer, failed: () -> Unit): SfxOutput }

/** Full-file decode from an authenticated local descriptor. Android's codec output applies
 * extractor gapless metadata; retain the original format rather than trim the stream twice.
 * Float pages share the bank's global reservation ceiling even across concurrent decoders. */
class AndroidSfxDecoder : SfxDecoder {
    override suspend fun decode(file: File, budget: PcmBudget): PcmClip {
        var delivered: PcmClip? = null
        try {
            val result = withContext(Dispatchers.IO) {
                val extractor = MediaExtractor()
                var codec: MediaCodec? = null
                var builder: PcmBuilder? = null
                try {
                    FileInputStream(file).use { extractor.setDataSource(it.fd) }
                    val track = (0 until extractor.trackCount).firstOrNull {
                        extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
                    } ?: error("Optional sound has no audio track")
                    extractor.selectTrack(track)
                    val inputFormat = extractor.getTrackFormat(track)
                    val mime = requireNotNull(inputFormat.getString(MediaFormat.KEY_MIME))
                    var rate = 0; var channels = 0; var floating = false
                    fun configure(format: MediaFormat) {
                        val nextRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                        val nextChannels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                        val encoding = if (format.containsKey(MediaFormat.KEY_PCM_ENCODING))
                            format.getInteger(MediaFormat.KEY_PCM_ENCODING) else AudioFormat.ENCODING_PCM_16BIT
                        require(encoding == AudioFormat.ENCODING_PCM_16BIT || encoding == AudioFormat.ENCODING_PCM_FLOAT)
                        require(nextRate > 0 && nextChannels in 1..2)
                        if (builder != null) check(rate == nextRate && channels == nextChannels && floating == (encoding == AudioFormat.ENCODING_PCM_FLOAT))
                        else { rate = nextRate; channels = nextChannels; floating = encoding == AudioFormat.ENCODING_PCM_FLOAT
                            builder = PcmBuilder(budget, rate, channels) }
                    }
                    if (mime == MediaFormat.MIMETYPE_AUDIO_RAW) {
                        configure(inputFormat)
                        // Technical bounded extractor scratch, not a decoded cache or game value.
                        val scratch = ByteBuffer.allocate(64 * 1024)
                        while (true) {
                            ensureActive(); scratch.clear()
                            check(extractor.sampleSize <= scratch.capacity())
                            val size = extractor.readSampleData(scratch, 0)
                            if (size < 0) break
                            scratch.position(0); scratch.limit(size); builder!!.append(scratch, floating)
                            extractor.advance()
                        }
                    } else {
                        val decoder = MediaCodec.createDecoderByType(mime); codec = decoder
                        decoder.configure(inputFormat, null, null, 0); decoder.start()
                        var inputEnded = false; var outputEnded = false
                        val info = MediaCodec.BufferInfo()
                        while (!outputEnded) {
                            ensureActive()
                            if (!inputEnded) {
                                val index = decoder.dequeueInputBuffer(0)
                                if (index >= 0) {
                                    val input = requireNotNull(decoder.getInputBuffer(index)); input.clear()
                                    check(extractor.sampleSize <= input.capacity())
                                    val size = extractor.readSampleData(input, 0)
                                    if (size < 0) { decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputEnded = true }
                                    else { decoder.queueInputBuffer(index, 0, size, extractor.sampleTime.coerceAtLeast(0), 0); extractor.advance() }
                                }
                            }
                            // A short codec poll makes coroutine cancellation responsive without a spin loop.
                            when (val index = decoder.dequeueOutputBuffer(info, 10_000)) {
                                MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> configure(decoder.outputFormat)
                                else -> if (index >= 0) {
                                    try {
                                        if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                                            if (builder == null) configure(decoder.outputFormat)
                                            val output = requireNotNull(decoder.getOutputBuffer(index))
                                            output.position(info.offset); output.limit(info.offset + info.size)
                                            builder!!.append(output, floating)
                                        }
                                        outputEnded = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                                    } finally { decoder.releaseOutputBuffer(index, false) }
                                }
                            }
                        }
                    }
                    ensureActive()
                    requireNotNull(builder).finish().also { delivered = it }
                } finally { builder?.close(); runCatching { codec?.stop() }; runCatching { codec?.release() }; extractor.release() }
            }
            delivered = null
            return result
        } finally { delivered?.close() }
    }
}

/** Android driver. Every method is called only by the IO owner in QueuedSfxOutput. */
class AndroidSfxOutputFactory(private val scope: CoroutineScope) : SfxOutputFactory {
    override fun create(mixer: SfxMixer, failed: () -> Unit): SfxOutput = QueuedSfxOutput(scope, mixer, {
        val rate = AudioTrack.getNativeOutputSampleRate(AudioManager.STREAM_MUSIC)
        require(rate > 0)
        val minimum = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_FLOAT)
        check(minimum > 0)
        // Exactly one platform minimum buffer and one equally bounded staging block.
        val floats = ((minimum + Float.SIZE_BYTES * 2 - 1) / (Float.SIZE_BYTES * 2)) * 2
        val track = AudioTrack.Builder().setAudioAttributes(AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).setSampleRate(rate).build())
            .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(floats * Float.SIZE_BYTES).build()
        object : PcmOutputDevice {
            override val sampleRate = rate
            override val bufferSamples = floats
            override fun play() { track.play() }
            override fun write(output: FloatArray, offset: Int, count: Int) =
                track.write(output, offset, count, AudioTrack.WRITE_NON_BLOCKING)
            override fun drain() { track.stop() }
            override fun close() {
                try { runCatching { track.pause() }; runCatching { track.flush() } }
                finally { track.release() }
            }
        }
    }, failed)
}
