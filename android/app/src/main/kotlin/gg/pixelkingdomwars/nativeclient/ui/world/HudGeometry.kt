package gg.pixelkingdomwars.nativeclient.ui.world

/** A HUD rectangle in dp (x, y = top-left). Pure data: the planners compute them, Compose places controls at them, and
 *  the same rects feed the label layers and the engine's `SetUiRects` (after the view-px conversion). */
data class HudRect(val x: Float, val y: Float, val w: Float, val h: Float) {
    val right: Float get() = x + w
    val bottom: Float get() = y + h
    val empty: Boolean get() = w <= 0f || h <= 0f
    fun intersects(o: HudRect): Boolean = !empty && !o.empty && x < o.right && right > o.x && y < o.bottom && bottom > o.y
    /** Containment to 0.01 dp: planner rects are float sums of dp values. */
    fun contains(o: HudRect): Boolean = o.x >= x - EPS && o.y >= y - EPS && o.right <= right + EPS && o.bottom <= bottom + EPS
    /** (l, t, r, b) grown by [pad] on every side: the web's padded chrome rect. */
    fun ltrb(pad: Float = 0f): DoubleArray = doubleArrayOf((x - pad).toDouble(), (y - pad).toDouble(), (right + pad).toDouble(), (bottom + pad).toDouble())
    fun clipX(l: Float, r: Float): HudRect { val a = maxOf(x, l); val b = minOf(right, r); return HudRect(a, y, maxOf(0f, b - a), h) }
    companion object { const val EPS = 0.01f; fun ltrb(l: Float, t: Float, r: Float, b: Float) = HudRect(l, t, r - l, b - t) }
}

/** Safe-area insets in dp (status bar, navigation bar, display cutout). */
data class HudInsets(val top: Float = 0f, val right: Float = 0f, val bottom: Float = 0f, val left: Float = 0f)

/** A named control rect; [overlay] marks popovers that deliberately sit over other controls (search results, the level
 *  panel), as the web stacks them above the bar they drop from. */
data class HudControl(val id: String, val rect: HudRect, val overlay: Boolean = false)

/** The Seeker rows every HUD test runs (GLOBE-NATIVE-PLAN §5.5): a 1200×2670 panel whose logical density is not yet
 *  recorded (2.625, 2.75 or 3.0), portrait and landscape. The navigation-bar and status-bar insets are the Android
 *  defaults at that density (24 dp status bar, 48 dp gesture/nav area in the worst case). */
object SeekerRows {
    const val PANEL_W = 1200; const val PANEL_H = 2670
    val DENSITIES = floatArrayOf(2.625f, 2.75f, 3.0f)
    fun portrait(density: Float) = PANEL_W / density to PANEL_H / density
    fun landscape(density: Float) = PANEL_H / density to PANEL_W / density
    val PORTRAIT_INSETS = HudInsets(top = 24f, bottom = 48f)
    val LANDSCAPE_INSETS = HudInsets(top = 24f, left = 48f, right = 48f)
}
