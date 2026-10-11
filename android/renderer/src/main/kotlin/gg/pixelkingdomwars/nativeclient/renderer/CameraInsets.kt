package gg.pixelkingdomwars.nativeclient.renderer

/** Camera-fitting margins in physical pixels. These do not define the touchable scene. */
data class CameraInsets(val left: Int = 0, val top: Int = 0, val right: Int = 0, val bottom: Int = 0) {
    init { require(left >= 0 && top >= 0 && right >= 0 && bottom >= 0) }
    operator fun plus(other: CameraInsets) = CameraInsets(
        Math.addExact(left,other.left),Math.addExact(top,other.top),Math.addExact(right,other.right),Math.addExact(bottom,other.bottom))
    fun visible(width: Int, height: Int): CameraVisibleRect? {
        if (width <= 0 || height <= 0) return null
        val l = left.coerceAtMost(width); val t = top.coerceAtMost(height)
        val r = width - right.coerceAtMost(width); val b = height - bottom.coerceAtMost(height)
        return if (r <= l || b <= t) null else CameraVisibleRect(width, height, l, t, r, b)
    }
}

/** libGDX inverse zoom must fit the whole physical surface on the admitted painting. Floating
 * controls leave visible gaps, so using only the smaller camera-fit rectangle stretches edge texels. */
internal fun paintedViewportZoom(zoom: Float, width: Int, height: Int, bounds: BaseWorldBounds): Float {
    require(zoom.isFinite() && zoom>0 && width>0 && height>0 && bounds.width.isFinite() && bounds.width>0 && bounds.height.isFinite() && bounds.height>0)
    return minOf(zoom,bounds.width/width,bounds.height/height)
}

/** libGDX's y-down camera projects this world's look-at point into the visible rectangle centre. */
data class CameraVisibleRect(val viewportWidth: Int, val viewportHeight: Int, val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
    val offsetX: Float get() = viewportWidth / 2f - (left.toFloat() + right) / 2f
    val offsetY: Float get() = viewportHeight / 2f - (top.toFloat() + bottom) / 2f
    fun cameraX(visibleCenter: Float, zoom: Float): Float = visibleCenter + offsetX * zoom
    fun cameraY(visibleCenter: Float, zoom: Float): Float = visibleCenter + offsetY * zoom
    fun visibleX(cameraCenter: Float, zoom: Float): Float = cameraCenter - offsetX * zoom
    fun visibleY(cameraCenter: Float, zoom: Float): Float = cameraCenter - offsetY * zoom
    fun contains(x: Int, y: Int): Boolean = x >= left && x < right && y >= top && y < bottom
    fun clampX(center: Float, zoom: Float, minimum: Float, maximum: Float): Float =
        cameraX(clampBaseCameraAxis(visibleX(center, zoom), width * zoom, minimum, maximum), zoom)
    fun clampY(center: Float, zoom: Float, minimum: Float, maximum: Float): Float =
        cameraY(clampBaseCameraAxis(visibleY(center, zoom), height * zoom, minimum, maximum), zoom)
}

/** Measured painted chrome, in physical surface-local pixels; right/bottom edges are exclusive. */
data class SceneInputRegion(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    fun contains(x: Int, y: Int) = x >= left && x < right && y >= top && y < bottom
}

/** A stale rotation/layout measurement refuses input until its surface dimensions match again.
 * A null geometry (legacy/offline host) admits the physical viewport without any chrome. */
data class SceneInputGeometry(val width: Int, val height: Int, val regions: List<SceneInputRegion>, val cancellation: SceneInputCancellation? = null) {
    fun accepts(x: Int, y: Int, surfaceWidth: Int, surfaceHeight: Int): Boolean =
        cancellation?.blocked != true && width == surfaceWidth && height == surfaceHeight && physicalSceneContains(x, y, width, height) &&
            regions.none { it.contains(x, y) }
}
internal fun physicalSceneContains(x: Int, y: Int, width: Int, height: Int) =
    width > 0 && height > 0 && x >= 0 && y >= 0 && x < width && y < height

/** Shared with Compose so a HUD pointer-down poisons GL input immediately, without waiting for
 * a layout/recomposition/frame. No coordinates or gameplay state cross this cancellation signal. */
class SceneInputCancellation {
    private val epoch = java.util.concurrent.atomic.AtomicLong(0)
    private val contacts = java.util.concurrent.atomic.AtomicInteger(0)
    val blocked: Boolean get() = contacts.get() > 0
    val revision: Long get() = epoch.get()
    fun beginContact() { contacts.incrementAndGet(); epoch.incrementAndGet() }
    fun endContact() { check(contacts.decrementAndGet() >= 0); epoch.incrementAndGet() }
}
