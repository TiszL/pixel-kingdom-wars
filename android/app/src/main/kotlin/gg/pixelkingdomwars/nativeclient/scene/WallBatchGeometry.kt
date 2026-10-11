package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.PlotGeometry
import gg.pixelkingdomwars.nativeclient.model.WallBatchTerms
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeMode
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeTile
import kotlinx.serialization.json.JsonObject

/** The shared stroke envelope: sample anchors in the half-open claim, retaining the whole plot's
 * origin and extent for renderer rounding. The caller supplies live or draft collision admission. */
fun wallStrokeGeometry(token: String, baseId: String, plot: PlotGeometry, claimMin: Int, claimMax: Int,
    footprintWidth: Int, footprintHeight: Int, validAt: (Int, Int) -> Boolean): WallStrokeMode {
    require(claimMin >= plot.min && claimMax <= plot.max && claimMin < claimMax)
    require(footprintWidth in 1..plot.size && footprintHeight in 1..plot.size)
    val valid = linkedSetOf<WallStrokeTile>()
    for (ty in claimMin..claimMax - footprintHeight) for (tx in claimMin..claimMax - footprintWidth) {
        if (validAt(tx, ty)) valid.add(WallStrokeTile(tx, ty))
    }
    return WallStrokeMode(token, baseId, plot.size, plot.size, footprintWidth, footprintHeight, valid, plot.min, plot.min)
}

/** BaseScene.isValidSpot uses the half-open claim and every current footprint, including
 * unfinished buildings and obstacles. Wall strokes never relocate identities from the layout tray. */
fun wallStrokeMode(token: String, base: BaseSnapshot, terms: WallBatchTerms,
    catalogue: JsonObject, renderCatalogue: JsonObject?): WallStrokeMode {
    val geometry = BaseGeometry(catalogue, renderCatalogue); val claim = requireNotNull(base.claim)
    val plot = PlotGeometry.from(catalogue, base.plotVersion)
    require(terms.plotTiles == plot.size && terms.plotGeometry == plot.takeIf { it.version != 1 })
    require(claim.min >= plot.min && claim.max <= plot.max && claim.min < claim.max)
    val (fw, fh) = geometry.footprint("wall", 1)
    fun overlaps(tx: Int, ty: Int, x: Int, y: Int, width: Int, height: Int) =
        tx < x + width && x < tx + fw && ty < y + height && y < ty + fh
    return wallStrokeGeometry(token, requireNotNull(base.baseId), plot, claim.min, claim.max, fw, fh) { tx, ty ->
        base.buildings.none { b -> val fp = geometry.footprint(b); overlaps(tx, ty, b.tx, b.ty, fp.first, fp.second) } &&
            base.obstacles.none { o -> val size = geometry.obstacleFootprint(o); overlaps(tx, ty, o.tx, o.ty, size, size) }
    }
}

/** Only layout/collision changes revoke a prepared drawing; balance/timer HUD refreshes
 * do not invent a new touch gesture. The final POST preflight rereads all current server terms. */
fun sameWallGeometry(a: BaseSnapshot?, b: BaseSnapshot?): Boolean = a != null && b != null && a.baseId == b.baseId
    && a.plotVersion == b.plotVersion && a.claim == b.claim && a.buildings == b.buildings && a.obstacles == b.obstacles && a.player.keepLevel == b.player.keepLevel
