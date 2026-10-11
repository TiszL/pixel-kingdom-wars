package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.files.FileHandle
import java.io.Closeable

/** Called only by the bounded world worker. A group is complete and verified before delivery;
 * its lease must remain alive until both prepared pixels and graphics no longer use its files. */
interface GlobeAssetSource {
    fun acquire(group: String, checkpoint: () -> Unit): GlobeAssetLease
    /** Nonblocking: interrupt an obsolete network read without joining its worker. */
    fun cancelPending()
}

class GlobeAssetLease(val directory: FileHandle, private val release: () -> Unit = {}) : Closeable {
    private val closed = java.util.concurrent.atomic.AtomicBoolean()
    override fun close() { if (closed.compareAndSet(false, true)) release() }
}
