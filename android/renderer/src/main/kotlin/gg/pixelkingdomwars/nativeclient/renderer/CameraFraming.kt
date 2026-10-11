package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.math.max
import kotlin.math.min

/** Server claim and generated BASE_CAMERA values; no local game-size defaults. */
data class BaseCameraSpec(val claimMin: Float, val claimMax: Float, val padTiles: Float,
                          val absoluteMinZoom: Float, val maxZoom: Float, val skirtTiles: Float = 0f,
                          val extendedPlot: Boolean = false) {
    init {
        require(listOf(claimMin,claimMax,padTiles,absoluteMinZoom,maxZoom,skirtTiles).all { it.isFinite() })
        require(claimMax > claimMin && padTiles >= 0 && absoluteMinZoom > 0 && maxZoom >= absoluteMinZoom && skirtTiles >= 0)
    }
}
data class CameraFrame(val zoom: Float, val minZoom: Float, val maxZoom: Float, val center: Float, val centerY: Float = center)

data class BattleCameraSpec(val minScale: Float, val maxScale: Float, val fitMaxScale: Float,
    val fitPadTiles: Float, val entryMarginTiles: Float, val northHeadroomWorldPx: Float = 0f) {
    init { require(minScale > 0 && maxScale >= minScale && fitMaxScale > 0 && fitPadTiles >= 0 && entryMarginTiles >= 0 && northHeadroomWorldPx.isFinite() && northHeadroomWorldPx >= 0) }
}

/** Entry stays close to the defender; zoom-out and panning cover the entire versioned field. */
fun fitExpandedBattleFrame(policy: BattlefieldInputPolicy, spec: BattleCameraSpec, width: Int, height: Int,
    density: Float, tilePx: Float, insets: CameraInsets, defenderBounds: BaseWorldBounds? = null): CameraFrame {
    val visible = requireNotNull(insets.visible(width, height))
    val field = (policy.maximum - policy.minimum) * tilePx
    val fitField = min(visible.width, visible.height) / density / field
    val floor = fitField.coerceIn(min(spec.minScale, fitField), spec.maxScale)
    // Snapshot footprints are frozen: an expanded empty claim or destroyed wall must
    // not shrink the defender into the distance or move the entry camera mid-raid.
    val defender = defenderBounds?.takeIf { policy.version != policy.legacyVersion }
    val span = max(1f, defender?.let { max(it.width, it.height) } ?: (policy.claimMax - policy.claimMin).toFloat()) * tilePx
    val shortAxis = min(visible.width, visible.height) / density
    val entry = span + (spec.entryMarginTiles + spec.fitPadTiles) * 2 * tilePx
    val fitRing = shortAxis / entry
    val noWaste = max(width, height) / density / field
    val deployFits = shortAxis / (span + 2 * tilePx + 2 * spec.northHeadroomWorldPx)
    val scale = min(max(fitRing, noWaste), deployFits).coerceIn(floor, min(spec.fitMaxScale, spec.maxScale))
    return CameraFrame(1 / (scale * density), 1 / (spec.maxScale * density), 1 / (floor * density),
        (defender?.let { it.left + it.right } ?: (policy.claimMin + policy.claimMax).toFloat()) * tilePx / 2,
        (defender?.let { it.top + it.bottom } ?: (policy.claimMin + policy.claimMax).toFloat()) * tilePx / 2)
}

fun clampBattleCameraAxis(center: Float, visibleSize: Float, minimum: Float, maximum: Float): Float =
    if (visibleSize >= maximum - minimum) (minimum + maximum) / 2
    else center.coerceIn(minimum + visibleSize / 2, maximum - visibleSize / 2)

/** Backend D-185, superseding D-183. Owner, 0.6.0 / code 26 on his Seeker (2026-09-27): "users are not able to see new realm
 *  base themes normally, they are limited, they should be able to see full base art but they should not be able to zoom out
 *  in a way to see past it"; "player should be able to inspect full realm base". In his words the "base" / "realm base" /
 *  "base art" is the whole DRAWN WORLD: the realm kit's 98-tile field (the claim plus the themed rings, forest, coast and
 *  shipyard; `RealmKitManifest.floorBounds`, never the `REALM_KIT.edgeExtendTiles` margin edge-clamped beyond it) or a
 *  layered painting. D-183 read "base" as the claim plus its one-tile ring and bounded the camera by that covering the
 *  surface, which hid most of the art; that bound is superseded. The widest view is now the scale at which [world] covers
 *  the WHOLE GL surface: the view stays inside the drawn world on both axes and spans it exactly on the constraining one (a
 *  20:9 portrait phone sees the field's full height and about 44 of its 98 tiles across; landscape its full width). Units
 *  are [fitBaseFrame]'s: dp per world px. */
fun drawnWorldCoverScale(world: BaseWorldBounds, width: Int, height: Int, density: Float): Float {
    require(width > 0 && height > 0 && density.isFinite() && density > 0 && world.width > 0 && world.height > 0)
    return max(width / density / world.width, height / density / world.height)
}

/** A scene's zoom band under D-185 (libGDX zoom: world px per device px, larger = wider), in home, scout, campaign preview,
 *  battle and replay alike. The widest zoom is exactly [drawnWorldCoverScale], whatever the authored band's own floor would
 *  allow: an authored pull-back past the drawn world (an extended plot's claim fit, a battle's whole-field fit on the short
 *  axis) stops at the cover, and one that stops short of it (`BaseCameraSpec.absoluteMinZoom`) opens up to it, so the
 *  whole art can always be seen and nothing past it. The authored close-up ceiling is kept; it rises only where a world
 *  must come closer than it to fill the surface at all (never a 98-tile field). The authored entry zoom is kept when it
 *  is inside the band, otherwise clamped into it; the authored centre is kept for the pan clamp to settle. The realm
 *  map's Enter-base seam (`RealmSeam.landingD`) lands on this same floor. A revision-4 layered painting is bounded at its
 *  98-tile field too, although its centre painting draws to about 110 tiles: by design (D-185 item 3, recorded at its
 *  review; every realm is revision 5 now, and r4 reaches this client only on frozen raid contexts). */
fun drawnWorldFrame(frame: CameraFrame, world: BaseWorldBounds, width: Int, height: Int, density: Float): CameraFrame {
    val widest = 1 / (drawnWorldCoverScale(world, width, height, density) * density)
    val closest = min(frame.minZoom, widest)
    return frame.copy(zoom = frame.zoom.coerceIn(closest, widest), minZoom = closest, maxZoom = widest)
}

/** The drawn world a scene's camera is bounded by under D-185 ([drawnWorldFrame], [clampDrawnWorldAxis]), chosen when the
 *  scene activates: a realm kit's field ([kitField], `RealmKitSurface.worldBounds` = `RealmKitManifest.floorBounds`, never
 *  the `REALM_KIT.edgeExtendTiles` margin) wins, then a layered painting's ([paintingBounds]). Null when neither is drawn
 *  (a legacy v1 ground, a fixture, a ground not loaded yet): such a scene keeps the pre-D-183 framing (D-185 item 3). */
fun drawnWorldBounds(kitField: BaseWorldBounds?, paintingBounds: BaseWorldBounds?): BaseWorldBounds? = kitField ?: paintingBounds

/** HOME pan under D-185, on one axis: the pan rectangle's centre ([panCameraInsets]) is kept so that rectangle stays inside
 *  the drawn world and reaches each of its edges. Art along an edge can therefore be brought out from under floating HUD
 *  chrome; only the band that chrome covers may show the edge-clamped margin past the world. An axis on which the world fits
 *  inside the rectangle is centred. [minimum]..[maximum] is the drawn world on this axis. */
fun clampDrawnWorldAxis(visibleCenter: Float, visibleSize: Float, minimum: Float, maximum: Float): Float {
    require(listOf(visibleCenter, visibleSize, minimum, maximum).all { it.isFinite() } && visibleSize > 0 && maximum > minimum)
    return clampBattleCameraAxis(visibleCenter, visibleSize, minimum, maximum)
}

/** The pan rectangle for the drawn-world rule (D-185; the mechanism is D-183's). The HOME fit insets ([homeCameraInsets])
 *  count only the chrome that crosses the fitted square, so in portrait the resource bar, builder button and bottom dock are
 *  outside them, and a row of the drawn world under them could never be panned clear. Here every measured chrome rectangle
 *  widens its side: one centred in the top third pushes the top edge down to its bottom, the bottom third pushes the bottom
 *  edge up to its top, and a rectangle in the middle band centred in the left or right third pushes that side in (tall side
 *  panels). Each side is capped at a third of the surface; a stale measurement (another surface size) or none adds nothing
 *  to [fit]. */
fun panCameraInsets(fit: CameraInsets, width: Int, height: Int, geometry: SceneInputGeometry?): CameraInsets {
    require(width > 0 && height > 0)
    if (geometry == null || geometry.width != width || geometry.height != height) return fit
    var (left, top, right, bottom) = fit
    val capH = height / 3; val capW = width / 3
    for (r in geometry.regions) {
        if (r.right <= r.left || r.bottom <= r.top) continue
        val cy = (r.top + r.bottom) / 2; val cx = (r.left + r.right) / 2
        when {
            cy < height / 3 -> top = max(top, min(capH, r.bottom))
            cy >= height - height / 3 -> bottom = max(bottom, min(capH, height - r.top))
            cx < width / 3 -> left = max(left, min(capW, r.right))
            cx >= width - width / 3 -> right = max(right, min(capW, width - r.left))
        }
    }
    return CameraInsets(left, top, right, bottom)
}

/** Canonical world/camera.ts fitBaseCamera/baseZoomBand: claim fit uses unobscured dimensions,
 * Historical plots keep the painted world under the complete canvas. Explicit
 * extended plots fit their complete claim; revisioned scenery covers overflow.
 * libGDX zoom is inverse scale; density keeps the authored close-up limit identical
 * across Android resolutions. CameraInsets separately aligns the full surface camera. */
fun fitBaseFrame(spec: BaseCameraSpec, width: Int, height: Int, density: Float, worldPx: Float, tilePx: Float,
                 insets: CameraInsets = CameraInsets()): CameraFrame {
    require(width > 0 && height > 0 && density.isFinite() && density > 0 && worldPx > 0 && tilePx > 0)
    val visible = requireNotNull(insets.visible(width,height)) { "The camera has no unobscured viewport" }
    val viewW = width/density; val viewH = height/density
    val padded = max(1f,spec.claimMax-spec.claimMin+spec.padTiles*2)*tilePx
    val fitsClaim = min(visible.width/density,visible.height/density)/padded
    val floor = if(spec.extendedPlot) min(fitsClaim,spec.maxZoom)
        else max(max(viewW,viewH)/max(1f,worldPx),fitsClaim).coerceIn(spec.absoluteMinZoom,spec.maxZoom)
    val scale = fitsClaim.coerceIn(floor,spec.maxZoom)
    return CameraFrame(1/(scale*density),1/(spec.maxZoom*density),1/(floor*density),
        (spec.claimMin+spec.claimMax)/2*tilePx)
}

/** BaseScene's canonical fixed plot plus generated grass skirt on every side. */
data class BaseWorldBounds(val left: Float,val top: Float,val right: Float,val bottom: Float) {
    val width: Float get()=right-left
    val height: Float get()=bottom-top
}

/** Source world/camera.ts baseRenderBounds: contain the authored field and
 * inset-adjusted fitted viewport. Bounds depend on the zoom floor, never the
 * current user pan, so closer exploration cannot grow its own movement limits. */
fun extendedBaseRenderBounds(bounds: BaseWorldBounds, width: Int, height: Int, maxInverseZoom: Float,
    insets: CameraInsets = CameraInsets()): BaseWorldBounds {
    require(width>0 && height>0 && maxInverseZoom.isFinite() && maxInverseZoom>0)
    require(listOf(bounds.left,bounds.top,bounds.right,bounds.bottom).all { it.isFinite() } && bounds.width>0 && bounds.height>0)
    val visible=requireNotNull(insets.visible(width,height))
    val x=visible.cameraX((bounds.left+bounds.right)/2,maxInverseZoom)
    val y=visible.cameraY((bounds.top+bounds.bottom)/2,maxInverseZoom)
    return BaseWorldBounds(min(bounds.left,x-width*maxInverseZoom/2),min(bounds.top,y-height*maxInverseZoom/2),
        max(bounds.right,x+width*maxInverseZoom/2),max(bounds.bottom,y+height*maxInverseZoom/2))
}

/** Floating controls constrain HOME fitting only where their painted rectangles
 * cross the intended fitted square. Top rows precede lower tools; after a header
 * reduces the square, corner docks can remain outside it. Exact touch exclusions
 * are owned separately by SceneInputGeometry and are never narrowed here. */
fun homeCameraInsets(width: Int, height: Int, safe: CameraInsets,
    topChrome: List<SceneInputRegion>, bottomChrome: List<SceneInputRegion>): CameraInsets {
    var result=safe
    val cap=max(0,(height-safe.top-safe.bottom)/3)
    fun intersects(rect: SceneInputRegion): Boolean {
        val visible=result.visible(width,height) ?: return false
        val side=min(visible.width,visible.height)
        val left=visible.left+(visible.width-side)/2f
        val top=visible.top+(visible.height-side)/2f
        return rect.right>rect.left && rect.bottom>rect.top && rect.left<left+side && rect.right>left && rect.top<top+side && rect.bottom>top
    }
    // Bottom chrome can shift the square into a previously clear top row.
    // Every growth ends at one of these measured edges; there is no oscillation.
    repeat(topChrome.size+bottomChrome.size+1) {
        val previous=result
        for(rect in topChrome) if(intersects(rect)) result=result.copy(top=max(result.top,min(safe.top+cap,rect.bottom)))
        for(rect in bottomChrome) if(intersects(rect)) result=result.copy(bottom=max(result.bottom,min(safe.bottom+cap,height-rect.top)))
        if(result==previous) return result
    }
    return result
}

fun baseWorldBounds(columns: Int,rows: Int,tilePixels: Float,skirtTiles: Float,minimumTileX: Int = 0,minimumTileY: Int = 0): BaseWorldBounds {
    require(columns>0 && rows>0 && tilePixels.isFinite() && tilePixels>0 && skirtTiles.isFinite() && skirtTiles>=0)
    val skirt=skirtTiles*tilePixels
    return BaseWorldBounds(minimumTileX*tilePixels-skirt,minimumTileY*tilePixels-skirt,
        (minimumTileX.toLong()+columns)*tilePixels+skirt,(minimumTileY.toLong()+rows)*tilePixels+skirt)
}

/** Phaser BaseCamera.clampX/clampY expressed as a libGDX look-at centre.
 * Clamp the viewport edges, not just its centre, so panning cannot reveal the
 * unpainted area beyond the canonical skirt. Oversize views pin their near edge. */
fun clampBaseCameraAxis(center: Float,viewportWorldSize: Float,minimum: Float,maximum: Float): Float {
    require(listOf(center,viewportWorldSize,minimum,maximum).all { it.isFinite() } && viewportWorldSize>0 && maximum>minimum)
    val lower=minimum+viewportWorldSize/2
    val upper=max(lower,maximum-viewportWorldSize/2)
    return center.coerceIn(lower,upper)
}

/** User framing belongs to a destination and viewport, not one event revision. Fresh server
 * state in the same raid must not undo a pinch; another raid or a rotated surface must fit. */
internal class SceneCameraFraming {
    private data class Destination(val baseId: String?,val raidId: String?,val visual: RealmVisual?,
        val columns: Int,val rows: Int,val tilePixels: Float,val claimMin: Float?,val claimMax: Float?,val minimumTileX: Int,val minimumTileY: Int)
    private var destination: Destination? = null
    private var width = 0
    private var height = 0
    var moved = false
    fun activate(scene: BaseScene,raidId: String?): Boolean {
        val next=Destination(scene.baseId,raidId,scene.visual,scene.columns,scene.rows,scene.tilePixels,
            scene.camera?.claimMin,scene.camera?.claimMax,scene.minimumTileX,scene.minimumTileY)
        val changed=destination!=next
        if(changed) moved=false
        destination=next
        return changed
    }
    fun resize(nextWidth: Int,nextHeight: Int): Boolean {
        if(nextWidth<=0 || nextHeight<=0) return false
        val changed=width!=nextWidth || height!=nextHeight
        if(changed) moved=false
        width=nextWidth;height=nextHeight
        return changed
    }
}
