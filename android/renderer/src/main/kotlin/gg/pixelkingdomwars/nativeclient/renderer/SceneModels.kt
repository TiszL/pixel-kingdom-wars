package gg.pixelkingdomwars.nativeclient.renderer

data class RenderBuilding(
    val id: String,
    val frameKey: String,
    val tileX: Float,
    val tileY: Float,
    val footprintWidth: Float,
    val footprintHeight: Float,
    val initialHp: Long? = null,
    val maxHp: Long? = null,
    val type: String? = null,
    val level: Int? = null,
    val underConstruction: Boolean = false,
    val trapSpent: Boolean = false,
    /** Explicit renderer15 service entry; [frameKey] is then a logical identity, never a texture. */
    val service: RenderServiceIdentity? = null,
)

data class RenderJob(val id: String,val kind: String,val targetX: Float,val targetY: Float,
    val footprintWidth: Float,val footprintHeight: Float,val startedAtMs: Long,val finishesAtMs: Long,
    val buildingId: String? = null)
/** [spriteKey] is the server row's key (`OBSTACLES.tiers[*].kinds`), the join to a revision-5 kit's
 * `obstacleSprites` (E-11); null keeps the catalogue `dec_` frame, as fixtures without a row do. */
data class RenderObstacle(val id: String,val frameKey: String,val tileX: Float,val tileY: Float,
    val footprintWidth: Float,val footprintHeight: Float, val spriteKey: String? = null)
/** E-11 remnant (`GET /base` `clearedObstacles[]`): the stump/rubble twin of a row the player felled within
 * OBSTACLE_REMNANT_DAYS, keyed by the row's original [spriteKey] at its old seat and footprint. Presentation only,
 * as web BaseScene.syncRemnants: no id, no `dec_` frame (the frozen masters have no stump), never selectable
 * or a clear target. Only a revision-5 kit has remnant twins; without one the tile simply stays bare. */
data class RenderRemnant(val spriteKey: String, val tileX: Float, val tileY: Float, val footprintWidth: Float, val footprintHeight: Float)

/** Validated server facts only; these fields do not admit textures or change rendering.
 * Null is unknown. A known berth with null installation is explicitly uninstalled. */
enum class RenderStarterPresence { OCCUPIED, AWAY }
data class RenderStarterInstallation(val family: String, val presence: RenderStarterPresence)
data class RenderBerthPresentation(val buildingId: String, val installation: RenderStarterInstallation?)
enum class RenderServiceState { IDLE, WORKING, READY }
data class RenderServiceActivity(val buildingId: String, val state: RenderServiceState)
/** One Market's applied Awning from the server's current or frozen projection: the
 *  output and the exact binding hashes the packed extension must equal. */
data class RenderMarketAwning(val buildingId: String, val outputId: String, val bindingSha256: String,
    val sourceManifestSha256: String, val sourceIndexSha256: String)
/** N-C5-FACTS: the already-typed CURRENT advanced fleet projection, kept DISTINCT from the starter sibling.
 *  [family] is the exact wire vocabulary (`survey_balloon`, …; dashes appear only at the art lookup boundary,
 *  journeyFamilyKey) and [tier] the exact typed integer. The three presences are facts, carried as given; none
 *  of them creates, schedules or gates a journey by itself. This projection carries NO installation, expedition
 *  or receipt identity: building id + family + tier + presence are the only supplied facts. */
enum class RenderAdvancedPresence { OCCUPIED, AWAY, EXHAUSTED }
data class RenderAdvancedInstallation(val family: String, val tier: Int, val presence: RenderAdvancedPresence)
/** A known berth row; null installation = no advanced craft on it (says nothing about a starter). */
data class RenderAdvancedBerth(val buildingId: String, val installation: RenderAdvancedInstallation?)
/** CONTINUITY: the current installed identity of a berth — the real installed reservation id, the wire family and the exact tier
 *  (null = starter). Populated ONLY by the current Home entry from the same response's validated identity; distinct from the frozen
 *  appearance contract; never from battle facts, events or another endpoint. */
data class RenderFleetInstallationIdentity(val berthId: String, val installationId: String, val family: String, val tier: Int?)
data class RenderServiceFacts(
    val phaseEArtEnabled: Boolean? = null,
    val berths: List<RenderBerthPresentation>? = null,
    /** Only a current home may carry activity. Frozen battles never do. */
    val activity: List<RenderServiceActivity>? = null,
    /** Applied Awnings (renderer16). Null = legacy absence or an unavailable/refused
     *  projection: ordinary Market art, never a claimed "off". */
    val awnings: List<RenderMarketAwning>? = null,
    /** CURRENT-ONLY advanced berth rows, populated exclusively by the current Home entry (SceneMapper.baseScene)
     *  from the typed BaseServiceFacts.current(...).advancedPresentation. Null = unknown/refused/absent — and
     *  ALWAYS null for live/preview/scout/replay battle scenes even when their frozen advanced facts are valid.
     *  A known empty list is a known empty closure. Separate from [berths]: an absent sibling never erases the
     *  other's positive; two explicit installed siblings on one berth are contradictory facts (journey selection
     *  refuses them rather than choosing a precedence). */
    val currentAdvancedBerths: List<RenderAdvancedBerth>? = null,
    /** CONTINUITY: current installed identities (starter + advanced) of this Home snapshot, or null = unknown/refused/absent/frozen.
     *  An already running original keeps playing across a refresh only when the next snapshot's row proves the SAME installation. */
    val currentFleetIdentity: List<RenderFleetInstallationIdentity>? = null,
)

/** Authoritative ready-army seats; home scenery never invents troops or levels. */
data class RenderCampTroop(val campId: String, val slot: Int, val troop: String, val level: Int, val frameKey: String) {
    val identity: String get() = "$campId:$slot:$troop:$level:$frameKey"
}
/** Numeric patrol policy copied from the admitted source catalogue. */
data class CampPatrolRules(val maxPerCamp: Int, val speedPxPerSec: Float, val wanderPadTiles: Float,
    val pauseMinMs: Float, val pauseMaxMs: Float, val detourSearchTiles: Int, val routeRetries: Int,
    val scaleRatio: Float, val sourceTilePixels: Float) {
    init {
        require(maxPerCamp > 0 && detourSearchTiles >= 0 && routeRetries > 0)
        require(listOf(speedPxPerSec, wanderPadTiles, pauseMinMs, pauseMaxMs, scaleRatio, sourceTilePixels).all { it.isFinite() && it >= 0 })
        require(speedPxPerSec > 0 && pauseMaxMs >= pauseMinMs && scaleRatio > 0 && sourceTilePixels > 0)
    }
}

/** Coordinates and footprint dimensions come from the server and generated catalogue. */
data class BaseScene(
    val buildings: List<RenderBuilding>,
    val columns: Int,
    val rows: Int,
    val tilePixels: Float,
    val terrainFrameKey: String = "tile_grass_1",
    val camera: BaseCameraSpec? = null,
    val baseId: String? = null,
    val jobs: List<RenderJob> = emptyList(),
    val keepLevel: Int? = null,
    val obstacles: List<RenderObstacle> = emptyList(),
    val remnants: List<RenderRemnant> = emptyList(),
    /** Server `visualContext` (realm + art generation); null keeps the pack's declared default. */
    val visual: RealmVisual? = null,
    val battlefield: BattlefieldInputPolicy? = null,
    val battleCamera: BattleCameraSpec? = null,
    /** Frozen occupied defender footprint bounds, in tiles; independent of health. */
    val defenderBounds: BaseWorldBounds? = null,
    val campTroops: List<RenderCampTroop> = emptyList(),
    val campRules: CampPatrolRules? = null,
    val minimumTileX: Int = 0,
    val minimumTileY: Int = 0,
    val services: RenderServiceFacts = RenderServiceFacts(),
) {
    init {
        require(columns > 0 && rows > 0 && tilePixels.isFinite() && tilePixels > 0)
        require(buildings.map { it.id }.distinct().size == buildings.size)
        require(buildings.all { it.tileX.isFinite() && it.tileY.isFinite() &&
            it.footprintWidth.isFinite() && it.footprintWidth > 0 &&
            it.footprintHeight.isFinite() && it.footprintHeight > 0 })
    }
}

/** Web `syncRemnants`: a remnant hides the moment any tile of its footprint is under a building (at its held
 * tile while a drop awaits the server, web `reseatSettlingMoves`) or a standing obstacle — a stump you built
 * over is gone. The server already lists the tile as buildable, so this is the only thing that hides one. */
fun BaseScene.remnantCovered(remnant: RenderRemnant, held: Map<String, CarryTile> = emptyMap()): Boolean {
    fun overlaps(tx: Float, ty: Float, w: Float, h: Float) = tx < remnant.tileX + remnant.footprintWidth && remnant.tileX < tx + w &&
        ty < remnant.tileY + remnant.footprintHeight && remnant.tileY < ty + h
    return buildings.any { b -> val seat = held[b.id]; overlaps(seat?.tx?.toFloat() ?: b.tileX, seat?.ty?.toFloat() ?: b.tileY, b.footprintWidth, b.footprintHeight) } ||
        obstacles.any { overlaps(it.tileX, it.tileY, it.footprintWidth, it.footprintHeight) }
}

data class SpritePlacement(val left: Float, val top: Float, val width: Float, val height: Float, val depth: Float)

/** The source's south-edge seating contract: the anchor locates the horizontal pivot,
 * while the visible cell bottom, not the authored anchor, meets the footprint bottom. */
fun placeBuilding(building: RenderBuilding, tile: Float, sourceWidth: Float, sourceHeight: Float,
                  scale: Float, anchorX: Float, offsetX: Float = 0f, offsetY: Float = 0f): SpritePlacement {
    val width = sourceWidth * scale
    val height = sourceHeight * scale
    val south = (building.tileY + building.footprintHeight) * tile
    return SpritePlacement((building.tileX + building.footprintWidth / 2) * tile + offsetX - width * anchorX,
        south + offsetY - height, width, height, south)
}

/** Separates a tap from a pan or pinch; a released pointer must never select after a gesture. */
class TouchIntent(private val slopPixels: Float) {
    private var startX = 0f
    private var startY = 0f
    private var gesture = false
    private var pressed = false
    fun down(x: Float, y: Float) { startX = x; startY = y; gesture = false; pressed = true }
    fun move(x: Float, y: Float) {
        val dx = x - startX; val dy = y - startY
        if (dx * dx + dy * dy > slopPixels * slopPixels) gesture = true
    }
    fun pinch() { gesture = true }
    fun cancel() { gesture = true; pressed = false }
    fun up(x: Float, y: Float): Boolean { move(x, y); val tap = pressed && !gesture; pressed = false; return tap }
}

/** Placement and deployment both receive valid ground taps. Home also retains its
 * independent building selection; the app decides whether placement mode consumes it. */
internal fun dispatchSceneTap(tileX: Float,tileY: Float,columns: Int,rows: Int,battle: Boolean,
    onGround: (Float,Float)->Unit,minimumTileX: Int = 0,minimumTileY: Int = 0,onHomeSelection: ()->Unit) {
    // Battle legality belongs to its versioned snapshot, not the home building frame.
    if(tileX.isFinite() && tileY.isFinite() && (battle || tileX>=minimumTileX && tileX<minimumTileX.toLong()+columns && tileY>=minimumTileY && tileY<minimumTileY.toLong()+rows)) onGround(tileX,tileY)
    if(!battle) onHomeSelection()
}

/** Scenery shares drawable geometry, but only current server buildings may emit
 * the building-selection callback. Obstacle interactions have a separate domain. */
internal fun selectableBuildingHit(building: RenderBuilding,tileX: Float,tileY: Float,buildingIds: Set<String>): Boolean =
    building.id in buildingIds && tileX>=building.tileX && tileX<building.tileX+building.footprintWidth &&
        tileY>=building.tileY && tileY<building.tileY+building.footprintHeight

/** How the renderer draws a [SceneHighlight]; the kind decides the pass, never the colour alone. */
enum class SceneHighlightKind {
    /** A translucent fill above the sprites (wall-stroke tiles). */
    FILL,
    /** The selected building: the designed stepped footprint frame under the sprite (soft gold-hi fill, ink and
     * gold-hi strokes, inner dashed ring; [SelectionChrome]) that scales in and cross-moves ([SelectionMotion]),
     * plus a 2 dp gold-hi outline on the sprite of [SceneHighlight.targetId] (design-beacon `selected.png`). */
    SELECTION,
    /** A footprint being placed or moved: `color` fills the tiles under the sprite and outlines them above
     * it (web `showFootprintTint`). */
    FOOTPRINT,
    /** The buildable plot: one faint line every tile across the rectangle, under the sprites
     * (web `drawPlacementGrid`). `width`/`height` are whole tile counts. */
    GRID,
    /** Layout occupancy grid above art, after its tile fills and below the selected footprint. */
    GRID_OVERLAY,
    /** Layout selection fill and outline above the occupancy grid (web overlayDepth 2350). */
    FOOTPRINT_OVERLAY,
    /** One piece of a selected group (each wall of the row a purchase prices): the soft fill under it and the 2 dp
     * gold-hi outline on the sprite of [SceneHighlight.targetId], no frame of its own. `buildings/wall-row.png`
     * outlines the row; a frame on every wall would chain into a row of boxes. */
    OUTLINE,
}

/** A tile-space rectangle the app paints on the base (a selected building, the wall row a purchase
 * prices, a layout draft's footprint, the plot grid). Presentation only: it never changes scene geometry
 * or the composited art beneath it. [targetId] names the building or obstacle a [SceneHighlightKind.SELECTION]
 * or [SceneHighlightKind.OUTLINE] marks, so the renderer can outline its sprite; null outlines nothing. */
data class SceneHighlight(val tileX: Float, val tileY: Float, val width: Float, val height: Float, val color: Int, val alpha: Float,
                          val kind: SceneHighlightKind = SceneHighlightKind.FILL, val targetId: String? = null) {
    init { require(width > 0 && height > 0 && alpha in 0f..1f) }
}
