package gg.pixelkingdomwars.nativeclient.renderer

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicReference

/** UI-only commands, consumed by the owning scene's GL thread; the step comes from RAID_CAMERA. */
class SceneCameraControls(val zoomStep: Float?) {
    init { require(zoomStep == null || zoomStep.isFinite() && zoomStep > 1f) }
    internal enum class Command { IN, OUT, FIT }
    private val commands = ConcurrentLinkedQueue<Command>()
    fun zoomIn() { if (zoomStep != null) commands.add(Command.IN) }
    fun zoomOut() { if (zoomStep != null) commands.add(Command.OUT) }
    fun fit() { commands.add(Command.FIT) }
    internal fun take(): Command? = commands.poll()

    /** A base camera to open on: world px at the surface centre (y down) and libGDX zoom (world px per surface px), the
     *  [BaseCameraView] convention. */
    class Entry(val baseId: String, val worldX: Float, val worldY: Float, val zoom: Float) {
        init { require(worldX.isFinite() && worldY.isFinite() && zoom.isFinite() && zoom > 0) }
    }
    private val entry = AtomicReference<Entry?>(null)

    /** The realm map's Enter-base seam (D-162.3): [baseId]'s scene opens on this camera instead of its fit, once, on the
     *  first frame of that base. The Kingdom tab can still show the previous selection while the new one loads, so
     *  another base's frames leave it waiting; a newer entry replaces it. */
    fun enterAt(baseId: String, worldX: Float, worldY: Float, zoom: Float) = entry.set(Entry(baseId, worldX, worldY, zoom))
    fun cancelEntry() = entry.set(null)
    /** An entry is waiting for its base's first frame (a reopening Home never overrides the World seam's). */
    val entryPending: Boolean get() = entry.get() != null

    /** GL thread, on a destination's first frame: the entry for [baseId] when that is the base scene (a raid, a replay or
     *  a preview of the same base is not), consumed; else null and the entry keeps waiting. */
    internal fun entryFor(baseId: String?, battle: Boolean): Entry? {
        val pending = entry.get() ?: return null
        if (battle || pending.baseId != baseId) return null
        return if (entry.compareAndSet(pending, null)) pending else null
    }
}
