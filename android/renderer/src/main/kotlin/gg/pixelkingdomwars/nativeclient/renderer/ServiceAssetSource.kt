package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.files.FileHandle
import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean

/** Exact groups pinned by the admitted content generation. Called off Main/GL;
 * a returned lease owns complete verified files, never an incomplete download. */
interface ServiceAssetSource {
    /** Cheap current account/content ownership check, with no IO. Unknown sources
     * do not authorize drawing while UI/session disposal catches up. */
    fun isCurrent(): Boolean = false
    fun acquire(group: String, checkpoint: () -> Unit): ServiceAssetLease
    fun cancelPending()
}

class ServiceAssetLease(val directory: FileHandle, private val release: () -> Unit = {}) : Closeable {
    private val closed = AtomicBoolean()
    override fun close() { if (closed.compareAndSet(false, true)) release() }
}
