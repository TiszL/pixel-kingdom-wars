package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.RealmKitRules
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max

/**
 * The enter-base seam (D-162.3 "the deed is the ruler … at exactly in-game proportions, so Enter base is seamless";
 * GLOBE-PRODUCTION-PLAN F8: OPEN THIS BASE at TRUE is the "Enter base" hand-off). One realm-map deed IS one base world:
 * the realm-kit field the base scene draws with `RealmKitGround` (r5, e7ab4db; read-only here) is `fieldTiles` = 98
 * tiles from `fieldOriginTiles` = −34, and the legacy plot (0‥`plotTiles`) sits at its centre, so deed-local tile
 * `PLOT_CENTRE` (49) is the base scene's plot centre `plotTiles / 2` (15). The realm map draws a kingdom's plot moved by
 * its hashed `plotOffset` inside the deed (visual only, contracts.js); the base scene has no offset. The seam therefore
 * maps a deed-local point to base-world art px by removing that offset:
 *
 *   baseTile = deedLocalTile − plotOffset(deed, level) + fieldOriginTiles,  basePx = baseTile · tilePixels
 *
 * and scale by art px: the map shows `s / (fieldTiles · tilePixels)` CSS px per art px (= s / DEED_ART), the base scene
 * `1 / (zoom · density)` (libGDX zoom = world px per surface px; `BaseCameraView` y grows downward like the map's).
 * Every number comes from the catalogue (`REALM_KIT`, `GRID`, `CAMPAIGN`) and the pinned contracts; the constructor
 * refuses a catalogue in which the kit field and the deed disagree, so a drift fails loudly instead of opening the base
 * a few tiles off. Pure and allocation-free after construction.
 */
class RealmSeam(val kit: RealmKitRules, private val plots: RealmPlotRules) {
    /** DEED_ART: art px per deed (the kit field's width in art px). */
    val deedArt: Double = kit.fieldTiles.toDouble() * kit.tilePixels

    init {
        require(kit.fieldTiles == plots.tiles) { "the realm-kit field (${kit.fieldTiles} tiles) is not one deed (${plots.tiles} tiles)" }
        require(-kit.fieldOriginTiles * 2 + kit.plotTiles == plots.plotCentre * 2) {
            "the deed's plot centre (${plots.plotCentre}) is not the kit's plot centre (${-kit.fieldOriginTiles} + ${kit.plotTiles}/2)"
        }
    }

    /** The kingdom's plot offset in whole tiles (contracts.js `plotOffset`); an open deed ([level] < 1) has none. */
    fun offsetX(deedX: Int, deedY: Int, level: Int): Int = if (level < 1) 0 else plots.offsetX(deedX, deedY, level)
    fun offsetY(deedX: Int, deedY: Int, level: Int): Int = if (level < 1) 0 else plots.offsetY(deedX, deedY, level)

    /** Base-world art px of the realm point ([u], [v]) (fractional realm deeds) in deed ([deedX], [deedY]). */
    fun baseX(deedX: Int, deedY: Int, level: Int, u: Double): Double =
        ((u - deedX) * kit.fieldTiles - offsetX(deedX, deedY, level) + kit.fieldOriginTiles) * kit.tilePixels
    fun baseY(deedX: Int, deedY: Int, level: Int, v: Double): Double =
        ((v - deedY) * kit.fieldTiles - offsetY(deedX, deedY, level) + kit.fieldOriginTiles) * kit.tilePixels

    /** The realm point (fractional deeds) of base-world art px, the inverse of [baseX] / [baseY]. */
    fun realmU(deedX: Int, deedY: Int, level: Int, baseX: Double): Double =
        deedX + (baseX / kit.tilePixels - kit.fieldOriginTiles + offsetX(deedX, deedY, level)) / kit.fieldTiles
    fun realmV(deedX: Int, deedY: Int, level: Int, baseY: Double): Double =
        deedY + (baseY / kit.tilePixels - kit.fieldOriginTiles + offsetY(deedX, deedY, level)) / kit.fieldTiles

    /** The base scene's libGDX zoom (world px per surface px) that shows the map's [s] (CSS px per deed) at the same
     *  size on a surface of [surfacePxPerDp] px per dp. */
    fun baseZoom(s: Double, surfacePxPerDp: Double): Double = deedArt / (s * surfacePxPerDp)

    /** The map's s (CSS px per deed) that shows the base scene's [zoom] at the same size. */
    fun realmS(zoom: Double, surfacePxPerDp: Double): Double = deedArt / (zoom * surfacePxPerDp)

    /** Base-scene world px per kit art px: the base scene's world tile [worldTilePixels] (`presentation.tilePixels`, 64 on
     *  every client) over the kit's art tile (`REALM_KIT.tilePixels`, 32). Every number above is kit art px, like the
     *  kit's own field; the base scene draws that field at this scale (`RealmKitManifest.floorBounds`), so its camera
     *  ([gg.pixelkingdomwars.nativeclient.renderer.BaseCameraView], `SceneCameraControls.enterAt`) takes the point AND
     *  the zoom times this factor. Handed over unscaled, the base would open twice as close, half-way to its origin. */
    fun worldPerArt(worldTilePixels: Double): Double {
        require(worldTilePixels.isFinite() && worldTilePixels > 0)
        return worldTilePixels / kit.tilePixels
    }

    /**
     * Enter base's landing d (device px per deed on a buffer of [dpr] px per dp): the base scene's zoom floor, so the base
     * keeps the zoom it is handed instead of clamping it. Backend D-185 (owner 2026-09-27: "they should be able to see full
     * base art but they should not be able to zoom out in a way to see past it"; `CameraFraming.drawnWorldFrame`): zoomed
     * fully out, the base scene shows its whole drawn world and nothing past it, so its floor is the widest zoom at which the
     * realm-kit field (one deed, [RealmKitRules.fieldTiles] a side) COVERS the whole [surfaceWDp] × [surfaceHDp] surface
     * (the full screen, not the inset rect): max(W, H) / fieldTiles dp per base tile, i.e. max(W, H) · [dpr] device px per
     * deed. The kingdom's claim no longer enters it (D-183's floor, the claim plus its edge ring covering the surface, is
     * superseded), so the parameter is gone. Never below TRUE's full weight [trueFull]: the seam is seamless only there.
     * From the camera's pixel snap [snap] on, a resting d is a whole number of device px per art px (`snapD`), so the
     * landing takes the next one up: the nearest rest that is still inside the base's zoom band. The map never passes
     * [sMax] · dpr (`RealmCamera.restS` steps a snapped d down under it), so where that rest lies past the reach the
     * landing is the closest reachable rest, and there the base clamps the handed zoom once, a small inward step (none of
     * the phones and tablets RealmSeamBaseSceneTest pins: their field cover is under [snap]).
     */
    fun landingD(surfaceWDp: Double, surfaceHDp: Double, dpr: Double, trueFull: Double, snap: Double, sMax: Double): Double {
        require(surfaceWDp > 0 && surfaceHDp > 0 && dpr > 0 && trueFull > 0 && snap > 0 && sMax > 0)
        val cover = max(max(surfaceWDp, surfaceHDp) * dpr, trueFull)
        val rest = if (cover < snap) cover else ceil(cover / deedArt - 1e-9) * deedArt
        val reach = sMax * dpr
        return if (rest <= reach + 1e-6) rest else if (reach < snap) reach else floor(reach / deedArt + 1e-9) * deedArt
    }

    /** Is the base-world art px inside the drawable kit field (the base scene's own world)? */
    fun inField(baseX: Double, baseY: Double): Boolean {
        val lo = kit.fieldOriginTiles.toDouble() * kit.tilePixels; val hi = kit.fieldEndTile.toDouble() * kit.tilePixels
        return baseX >= lo && baseX < hi && baseY >= lo && baseY < hi
    }
}

/** A base-scene camera the seam hands over (Enter base) or takes back (the return to the realm map at TRUE). */
class RealmSeamCamera {
    /** The catalog deed (the server's address: tileId = y · 720 + x). */
    var catalogX = -1; var catalogY = -1
    /** Base-world art px at the screen centre (x right, y down) and the libGDX zoom (world px per surface px). */
    var baseX = 0.0; var baseY = 0.0; var zoom = 1.0
    /** The realm map's own view at the hand-off: centre (fractional deeds of this realm) and d (device px per deed). */
    var realmX = 0.0; var realmY = 0.0; var d = 0.0
    /** The map was at TRUE (full weight, d ≥ BANDS.trueFull): the base scene continues the same picture. */
    var seamless = false
}
