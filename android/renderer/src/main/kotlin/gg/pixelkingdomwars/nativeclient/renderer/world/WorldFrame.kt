package gg.pixelkingdomwars.nativeclient.renderer.world

import java.util.concurrent.atomic.AtomicInteger

enum class WorldEngine { LEGACY, GLOBE, REALM }

/**
 * What the GL thread publishes once per rendered frame for Compose (GLOBE-NATIVE-PLAN §3.4): the camera, the band and
 * the anchors of visible labels and tags, ALREADY IN VIEW PX (converted with [InputScale]). Compose reads it only in
 * `Modifier.layout` placement lambdas (the ArmyChipLayer pattern), so a pan costs no recomposition. Discrete events
 * (pick, band change, dive/leave, errors) go through the epoch-guarded `publish{}` instead.
 */
class WorldFrame(anchorCapacity: Int) {
    var sequence = 0L; internal set
    var engine = WorldEngine.GLOBE
    /** The realm band (FAR/MAP/TRUE as the realm engine numbers them) or 0 on the globe. */
    var band = 0
    var ladderLevel = 0
    var idlePhase = 0
    /** Globe: lon, lat (degrees) and altitude. Realm: deed-space x, y and device px per deed. */
    var cameraX = 0.0
    var cameraY = 0.0
    var cameraScale = 0.0
    val anchorIds = IntArray(anchorCapacity)
    /** x, y pairs in view px. */
    val anchorXY = FloatArray(anchorCapacity * 2)
    var anchorCount = 0

    /** Add one anchor in view px; false (and nothing written) when full. */
    fun addAnchor(id: Int, viewX: Float, viewY: Float): Boolean {
        if (anchorCount == anchorIds.size) return false
        anchorIds[anchorCount] = id; anchorXY[anchorCount * 2] = viewX; anchorXY[anchorCount * 2 + 1] = viewY
        anchorCount++
        return true
    }
}

/**
 * Lock-free triple buffer between one writer (the GL thread) and one reader thread (the UI thread). The writer fills
 * [back] and [publish]es it; the reader's [latest] returns the newest published frame and that object is never written
 * until the reader calls [latest] again, so a layout pass never sees a torn frame. No allocation on either side.
 */
class WorldFrameExchange(anchorCapacity: Int) {
    private val frames = Array(3) { WorldFrame(anchorCapacity) }
    /** (middle index shl 1) or fresh-bit. */
    private val state = AtomicInteger(1 shl 1)
    private var backIndex = 0
    private var frontIndex = 2
    private var sequence = 0L

    /** GL thread: the frame to fill (reset its anchors first). */
    fun back(): WorldFrame = frames[backIndex]

    /** GL thread: publish the filled back frame. */
    fun publish() {
        frames[backIndex].sequence = ++sequence
        backIndex = state.getAndSet((backIndex shl 1) or 1) shr 1
    }

    /** Reader thread: the newest published frame (sequence 0 = nothing published yet). */
    fun latest(): WorldFrame {
        if (state.get() and 1 != 0) frontIndex = state.getAndSet(frontIndex shl 1) shr 1
        return frames[frontIndex]
    }
}
