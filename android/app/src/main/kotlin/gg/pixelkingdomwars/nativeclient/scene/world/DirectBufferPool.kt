package gg.pixelkingdomwars.nativeclient.scene.world

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.IdentityHashMap

/**
 * Pooled direct buffers for decoded pixels (GLOBE-NATIVE-PLAN §5.7 "decode off the GL thread, into pooled buffers";
 * §5.8 "Java heap: pooled decode buffers, ≤ 64 MB transient"; the world host runs at [WORLD_MAX_OUTSTANDING_BYTES]).
 *
 * - [acquire] runs on decode threads only and BLOCKS while [maxOutstandingBytes] are out, so a slow upload worker
 *   throttles decoding instead of letting decoded layers pile up. A single request larger than the cap is still
 *   served when nothing else is out (otherwise it could never proceed).
 * - [release] (worker thread, or whoever drops a task) returns a buffer; idle buffers are kept up to [maxIdleBytes]
 *   for reuse and the rest are left to the GC.
 */
class DirectBufferPool(private val maxOutstandingBytes: Long, private val maxIdleBytes: Long) {
    private val lock = Object()
    private val idle = ArrayList<ByteBuffer>()
    private val out = IdentityHashMap<ByteBuffer, Int>()
    private var idleBytes = 0L
    var outstandingBytes = 0L; private set
    /** Decode threads that had to wait for the cap (for the probe and tests). */
    var waits = 0L; private set
    /** Buffers handed out so far (for tests: each is a wait at the cap when the pool is full). */
    var acquires = 0L; private set

    init { require(maxOutstandingBytes > 0 && maxIdleBytes >= 0) }

    /** A native-order buffer with position 0 and limit [bytes]. Blocks the calling (decode) thread at the cap. */
    @Throws(InterruptedException::class)
    fun acquire(bytes: Int): ByteBuffer {
        require(bytes > 0) { "Empty buffer" }
        synchronized(lock) {
            var waited = false
            while (outstandingBytes > 0 && outstandingBytes + bytes > maxOutstandingBytes) {
                if (!waited) { waits++; waited = true }
                lock.wait()
            }
            var best = -1
            for (i in idle.indices) if (idle[i].capacity() >= bytes && (best < 0 || idle[i].capacity() < idle[best].capacity())) best = i
            val buffer = if (best >= 0) idle.removeAt(best).also { idleBytes -= it.capacity() } else null
            outstandingBytes += bytes; acquires++
            val given = buffer ?: ByteBuffer.allocateDirect(bytes).order(ByteOrder.nativeOrder())
            given.clear(); given.limit(bytes)
            out[given] = bytes
            return given
        }
    }

    /** Returns [buffer]; a buffer this pool did not hand out (or one released twice) is ignored. */
    fun release(buffer: ByteBuffer) {
        synchronized(lock) {
            val bytes = out.remove(buffer) ?: return
            outstandingBytes -= bytes
            if (idleBytes + buffer.capacity() <= maxIdleBytes) { idle += buffer; idleBytes += buffer.capacity() }
            lock.notifyAll()
        }
    }

    companion object {
        /**
         * The world host's staging caps (P0, the 2026-09-26 Seeker OutOfMemoryError). On ART a direct buffer is a
         * non-movable `byte[]` on the Java heap, counted against the app's 256 MB heap growth limit like the decoders'
         * own arrays (a desktop JVM keeps it off heap, so no JVM test sees the pressure). The old 64 MB out + 16 MB idle
         * could hold 80 MB of that limit beside a realm load's decode peak. 24 MB out still keeps the one upload worker
         * fed (six 1024² RGBA8 layers, or a 2048² near-art level plus two); 4 MB idle keeps the small reused layers. One
         * fill larger than the cap still runs when nothing else is out (the [acquire] rule).
         */
        const val WORLD_MAX_OUTSTANDING_BYTES = 24L shl 20
        const val WORLD_MAX_IDLE_BYTES = 4L shl 20

        /** The pool the world host stages its uploads through, at the caps above. */
        fun world(): DirectBufferPool = DirectBufferPool(WORLD_MAX_OUTSTANDING_BYTES, WORLD_MAX_IDLE_BYTES)
    }
}
