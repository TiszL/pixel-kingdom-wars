package gg.pixelkingdomwars.nativeclient.renderer

/** The Home camera exactly as the last base frame was drawn, published from the GL thread so app chrome
 * can sit on a building (the army chips above camps and barracks). The renderer draws no text; the app
 * projects world pixels with the same y-down orthographic mapping. GL and Compose are separate surfaces, so
 * overlays yield during camera motion and return only at a settled projection. No gameplay value crosses here. */
data class BaseCameraView(val baseId: String?, val cameraX: Float, val cameraY: Float, val zoom: Float,
    val width: Int, val height: Int, val overlayVisible: Boolean = true,
    /** The player framed this camera (pan, pinch, a seam entry); false while it is the scene's own fit. A reopening Home hands
     *  a moved camera to its new renderer (SceneCameraControls.enterAt) so the last frame and the live one line up. */
    val moved: Boolean = false) {
    init { require(zoom.isFinite() && zoom > 0 && width > 0 && height > 0 && cameraX.isFinite() && cameraY.isFinite()) }
    /** Surface pixels per world pixel (libGDX zoom is the inverse). */
    val scale: Float get() = 1f / zoom
    /** Surface-local pixels from the top-left corner, like Compose and the touch coordinates. */
    fun screenX(worldX: Float): Float = width / 2f + (worldX - cameraX) / zoom
    fun screenY(worldY: Float): Float = height / 2f + (worldY - cameraY) / zoom
    internal fun matches(baseId: String?, x: Float, y: Float, zoom: Float, width: Int, height: Int, moved: Boolean = this.moved) =
        this.baseId == baseId && cameraX == x && cameraY == y && this.zoom == zoom && this.width == width && this.height == height &&
            this.moved == moved
}

/** Compose cannot atomically present a camera change with the independently swapped GL surface. Hide world
 * chrome from pointer down, through the whole pan/pinch, then wait for two unchanged post-contact frames.
 * The app captures visible chip targets before hiding; only renderer-confirmed taps may use that target.
 * Cancellation ends contacts just like release. */
internal class BaseCameraOverlay {
    private var previous: BaseCameraView? = null
    private var hidden = false
    private var settledFrame = false
    fun frame(view: BaseCameraView?, contacts: Boolean): BaseCameraView? {
        if (view == null) { previous = null; hidden = false; settledFrame = false; return null }
        val changed = previous != null && previous != view
        previous = view
        if (changed || contacts) { hidden = true; settledFrame = false }
        else if (hidden && !contacts) {
            if (settledFrame) hidden = false else settledFrame = true
        }
        return if (hidden) view.copy(overlayVisible = false) else view
    }
}
