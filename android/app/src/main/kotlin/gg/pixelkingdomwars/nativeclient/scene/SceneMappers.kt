package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.model.CurrentFleetIdentity
import gg.pixelkingdomwars.nativeclient.model.VisualContext
import gg.pixelkingdomwars.nativeclient.model.PlotGeometry
import gg.pixelkingdomwars.nativeclient.model.AdvancedPresence
import gg.pixelkingdomwars.nativeclient.model.AdvancedServicePresentation
import gg.pixelkingdomwars.nativeclient.model.BaseServiceFacts
import gg.pixelkingdomwars.nativeclient.model.ServiceActivityState
import gg.pixelkingdomwars.nativeclient.model.StarterPresence
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.renderer.RenderFleetInstallationIdentity
import gg.pixelkingdomwars.nativeclient.renderer.*
import java.time.Instant
import java.util.Collections
import kotlinx.serialization.json.*

/** Converts server state plus the admitted catalogues into renderer scenes. Every coordinate,
 * footprint and camera rule comes from the server or the generated catalogue; the `visualContext`
 * (realm + art generation) reaches the renderer as [BaseScene.visual], never guessed: an absent or
 * unknown context lets the renderer draw the pack's declared default exactly like the web. */
class SceneMapper(private val catalogue: JsonObject, private val renderCatalogue: JsonObject, private val log: (String) -> Unit = {}) {

    /** [context] defaults to the base's own `visualContext`; battle scenes pass the raid/replay root's.
     * [decorObstacles]: the snapshot's obstacles are another base's frozen decor (a raid, replay, scout or stronghold
     * preview), which nothing selects, clears or — during a battle — even draws. One such row whose art this pack
     * does not know is skipped, so it can never stop a battlefield from opening inside the first-deploy window. The
     * player's own base keeps failing closed: there an obstacle is a clearable thing the pack must be able to show. */
    fun baseScene(base: JsonObject, buildingHealth: List<JsonObject> = emptyList(), context: VisualContext? = VisualContext.of(base),
        checkpoint: () -> Unit = {}, decorObstacles: Boolean = false): BaseScene {
        // The CURRENT Home entry alone hands the typed advanced sibling on; battle callers never do (frozen
        // advanced facts stay in the network model and do not populate the current-only journey field).
        val facts = BaseServiceFacts.current(base, completedMarketOutput())
        // CONTINUITY: the current-only identity parsed from THIS body against its own visual facts (null = unknown → continuity refused).
        val identity = CurrentFleetIdentity.current(base, base.string("baseId"), facts.presentation, facts.advancedPresentation)
        return mapBaseScene(base, buildingHealth, context, checkpoint, decorObstacles, facts, currentAdvanced = facts.advancedPresentation, identity = identity)
    }

    /** The exported catalogue's own tier boundary for a COMPLETED Market level
     *  (shared boundCosmeticAwningForCompletedLevel: ceil(level / (maxLevel / visualTiers))),
     *  handed to the network matcher so it owns no tier table. Throws when the pack
     *  predates Phase E buildings, which the matcher reports as unavailable. */
    fun completedMarketOutput(): (Long) -> String = { level ->
        val constants = requireNotNull(catalogue["constants"] as? JsonObject)
        val market = requireNotNull((constants["STRUCTURES"] as? JsonObject)?.get("market") as? JsonObject)
        val maxLevel = positiveServiceInteger(market["maxLevel"])
        val tiers = positiveServiceInteger((constants["PHASE_E_BUILDINGS"] as? JsonObject)?.get("visualTiers"))
        require(level in 1..maxLevel && maxLevel % tiers == 0) { "Market completed level is invalid" }
        "artisan_market_awning_t${(level - 1) / (maxLevel / tiers) + 1}"
    }

    private fun mapBaseScene(base: JsonObject, buildingHealth: List<JsonObject>, context: VisualContext?,
        checkpoint: () -> Unit, decorObstacles: Boolean, services: BaseServiceFacts,
        /** Only the current entry passes this (N-C5-FACTS); battle/scout/replay leave it null by construction. */
        currentAdvanced: AdvancedServicePresentation? = null,
        identity: CurrentFleetIdentity? = null): BaseScene {
        VisualContext.of(base)?.let { log("base ${base.string("baseId")} ${it.describe()}") }
        val health = buildingHealth.associateBy { requireNotNull(it.string("id")) }
        require(health.size == buildingHealth.size) { "Duplicate building health identity" }
        val grid = requireNotNull(catalogue["constants"]?.jsonObject?.get("GRID")?.jsonObject) { "The content pack has no grid contract" }
        val entries = renderCatalogue.objects("entries")
        val buildings = base.objects("buildings").map { building ->
            checkpoint()
            val type = building.string("type"); val level = building.string("level")
            val entry = entries.firstOrNull { it.string("type") == type && it.string("level") == level }
                ?: error("Artwork is unavailable for $type level $level; update the native content pack")
            val service = if (entry.containsKey("phaseE")) {
                val version = renderCatalogue["rendererContractVersion"] as? JsonPrimitive
                require(version != null && !version.isString && version.intOrNull in 15..17)
                PhaseEServiceArt.entry(com.badlogic.gdx.utils.JsonReader().parse(entry.toString())).also { identity ->
                    // Game bounds and level-to-art mapping remain owned by the exported
                    // shared constants. Marker-only renderer admission does not prove them.
                    val constants = requireNotNull(catalogue["constants"] as? JsonObject)
                    val structure = requireNotNull((constants["STRUCTURES"] as? JsonObject)?.get(type) as? JsonObject)
                    val maxLevel = positiveServiceInteger(structure["maxLevel"])
                    val actualLevel = positiveServiceInteger(building["level"])
                    require(actualLevel <= maxLevel)
                    val footprint = requireNotNull(structure["footprint"] as? JsonArray)
                    require(footprint.size == 2 && footprint.all { positiveServiceInteger(it) == 2 })
                    for (name in listOf("fw", "fh")) if (building.containsKey(name))
                        require(positiveServiceInteger(building[name]) == 2) { "Service footprint differs from admitted geometry" }
                    if (identity.facility != "berth") {
                        val art = requireNotNull(constants["ART_V2"] as? JsonObject)
                        val tiers = positiveServiceInteger(art["tiers"])
                        val levelsPerTier = positiveServiceInteger(art["levelsPerTier"])
                        val expectedTier = minOf(tiers, (actualLevel - 1) / levelsPerTier + 1)
                        require(identity.tier == expectedTier) { "Service art tier differs from exported level mapping" }
                    }
                }
            } else null
            RenderBuilding(
                id = requireNotNull(building.string("id")), frameKey = if (service == null) requireNotNull(entry.string("frameKey")) else "service:$type:$level",
                tileX = requireNotNull(building.string("tx")).toFloat(), tileY = requireNotNull(building.string("ty")).toFloat(),
                footprintWidth = if (service != null) 2f else requireNotNull(building.string("fw") ?: entry.string("footprintWidth")).toFloat(),
                footprintHeight = if (service != null) 2f else requireNotNull(building.string("fh") ?: entry.string("footprintHeight")).toFloat(),
                initialHp = health[building.string("id")]?.getValue("initialHp")?.jsonPrimitive?.long,
                maxHp = health[building.string("id")]?.getValue("maxHp")?.jsonPrimitive?.long,
                type = type, level = requireNotNull(level).toInt(), underConstruction = building.flag("underConstruction"),
                trapSpent = building["trapSpentAt"]?.let { it != JsonNull } == true, service = service)
        }
        val baseMetadata = renderCatalogue["basePresentation"] as? JsonObject
        val obstacleMetadata = baseMetadata?.get("obstacles") as? JsonObject
        val obstacles = if (obstacleMetadata == null) emptyList() else base.objects("obstacles").mapNotNull { obstacle ->
            checkpoint()
            try {
                val spriteKey = requireNotNull(obstacle.string("spriteKey"))
                val entry = obstacleMetadata[spriteKey] as? JsonObject
                    ?: error("Obstacle artwork is unavailable; update the native content pack")
                val tx = requireNotNull(obstacle.string("tx")); val ty = requireNotNull(obstacle.string("ty"))
                // `/base` and `/map/scout` rows carry the obstacle id that clear jobs and selection resolve. A raid
                // snapshot freezes the defender's uncleared obstacles as decor only (shared `BaseSnapshot.obstacles`
                // = spriteKey/tx/ty, no row id), and nothing in a battle selects or clears one, so the placement
                // is its identity there. Requiring a row id turned every PvP raid against a real base into
                // "Couldn't open the battlefield" while campaign strongholds (no obstacles) kept opening.
                RenderObstacle(obstacle.string("id") ?: "obstacle:$spriteKey@$tx,$ty", requireNotNull(entry.string("frameKey")),
                    tx.toFloat(), ty.toFloat(),
                    requireNotNull(entry.string("footprintWidth")).toFloat(), requireNotNull(entry.string("footprintHeight")).toFloat(),
                    spriteKey = spriteKey)
            } catch (error: Exception) {
                if (!decorObstacles) throw error
                log("skipped decor obstacle ${obstacle.string("spriteKey")}: ${error.message}")
                null
            }
        }
        // E-11 remnants (`clearedObstacles[]`, D-153): the seat and `dec_` footprint of every row the player
        // felled within OBSTACLE_REMNANT_DAYS, so the renderer can stand the kit's stump/rubble twin where the
        // tree stood (web BaseScene.syncRemnants). Presentation only — a key this pack's `dec_` catalogue does
        // not know keeps web's 1×1 fallback rather than failing the base, and the kit decides whether it draws.
        val remnants = if (obstacleMetadata == null) emptyList() else base.objects("clearedObstacles").map { cleared ->
            checkpoint()
            val spriteKey = requireNotNull(cleared.string("spriteKey"))
            val entry = obstacleMetadata[spriteKey] as? JsonObject
            RenderRemnant(spriteKey, requireNotNull(cleared.string("tx")).toFloat(), requireNotNull(cleared.string("ty")).toFloat(),
                entry?.string("footprintWidth")?.toFloat() ?: 1f, entry?.string("footprintHeight")?.toFloat() ?: 1f)
        }
        // Resolve the server's job target, never infer a new site or deadline. Older packs have no
        // base presentation contract and retain their static preview.
        val jobs = if (baseMetadata == null) emptyList() else base.objects("jobs").mapNotNull { job ->
            checkpoint()
            val buildingId = job.string("buildingId")
            val building = buildingId?.let { id -> buildings.firstOrNull { it.id == id } }
            val obstacle = job.string("obstacleId")?.let { id -> obstacles.firstOrNull { it.id == id } }
            if (building == null && obstacle == null) return@mapNotNull null // Same stale-target policy as JobLayer.
            RenderJob(requireNotNull(job.string("id")), requireNotNull(job.string("kind")),
                building?.tileX ?: requireNotNull(obstacle).tileX, building?.tileY ?: requireNotNull(obstacle).tileY,
                building?.footprintWidth ?: requireNotNull(obstacle).footprintWidth,
                building?.footprintHeight ?: requireNotNull(obstacle).footprintHeight,
                Instant.parse(requireNotNull(job.string("startedAt"))).toEpochMilli(),
                Instant.parse(requireNotNull(job.string("finishesAt"))).toEpochMilli(), buildingId)
        }
        val plot = PlotGeometry.from(catalogue, base["plotVersion"]?.jsonPrimitive?.int)
        val cameraRules = catalogue["constants"]?.jsonObject?.get("BASE_CAMERA") as? JsonObject
        val claim = base["claim"] as? JsonObject
        // Simulator fixtures/legacy battle snapshots have no playable-base claim. Frame their whole
        // plot rather than inventing a claim that hides their walls.
        val camera = cameraRules?.takeIf { claim != null }?.let { rules ->
            BaseCameraSpec(requireNotNull(claim?.string("min")?.toFloatOrNull()), requireNotNull(claim?.string("max")?.toFloatOrNull()),
                requireNotNull(rules.string("fitPadTiles")).toFloat(), requireNotNull(rules.string("absoluteMinZoom")).toFloat(),
                requireNotNull(rules.string("maxZoom")).toFloat(), skirtTiles = requireNotNull(rules.string("skirtTiles")).toFloat(),
                extendedPlot = plot.version != 1)
        }
        val camps = mapCampTroops(base, buildings, catalogue, renderCatalogue, checkpoint)
        return BaseScene(buildings, columns = plot.size, rows = plot.size, minimumTileX = plot.min, minimumTileY = plot.min, tilePixels = requireNotNull(catalogue["presentation"]?.jsonObject?.string("tilePixels")).toFloat(),
            camera = camera, terrainFrameKey = renderCatalogue["terrain"]?.jsonObject?.string("frameKey") ?: error("Missing terrain contract"),
            baseId = base.string("baseId"), jobs = jobs, obstacles = obstacles, remnants = remnants, campTroops = camps.first, campRules = camps.second,
            keepLevel = (base["player"] as? JsonObject)?.string("keepLevel")?.toInt(),
            services = RenderServiceFacts(services.phaseEArt?.enabled,
                services.presentation?.berths?.map { berth -> RenderBerthPresentation(berth.buildingId,
                    berth.installation?.let { installation -> RenderStarterInstallation(installation.family, when (installation.presence) {
                        StarterPresence.OCCUPIED -> RenderStarterPresence.OCCUPIED
                        StarterPresence.AWAY -> RenderStarterPresence.AWAY
                    }) }) }?.let { Collections.unmodifiableList(it) },
                services.activity?.services?.map { row -> RenderServiceActivity(row.buildingId, when (row.state) {
                    ServiceActivityState.IDLE -> RenderServiceState.IDLE
                    ServiceActivityState.WORKING -> RenderServiceState.WORKING
                    ServiceActivityState.READY -> RenderServiceState.READY
                }) }?.let { Collections.unmodifiableList(it) },
                // Renderer16: only an AVAILABLE projection names Awnings; legacy absence and
                // an unavailable/refused read both leave ordinary Market art (null).
                services.boundCosmetics?.takeIf { it.state == "available" }?.visual?.marketAwnings?.map { row ->
                    RenderMarketAwning(row.buildingId, row.appearance.outputId, row.appearance.bindingSha256,
                        row.appearance.sourceManifestSha256, row.appearance.sourceIndexSha256)
                }?.let { Collections.unmodifiableList(it) },
                // N-C5-FACTS: the typed current advanced rows, wire family and exact tier preserved, presence carried as given.
                currentAdvanced?.berths?.map { berth -> RenderAdvancedBerth(berth.buildingId,
                    berth.installation?.let { installation -> RenderAdvancedInstallation(installation.family, installation.tier, when (installation.presence) {
                        AdvancedPresence.OCCUPIED -> RenderAdvancedPresence.OCCUPIED
                        AdvancedPresence.AWAY -> RenderAdvancedPresence.AWAY
                        AdvancedPresence.EXHAUSTED -> RenderAdvancedPresence.EXHAUSTED
                    }) }) }?.let { Collections.unmodifiableList(it) },
                currentFleetIdentity = renderFleetIdentity(identity)),
            visual = context?.takeIf { it.version == 1 }?.let { RealmVisual(it.realmId, it.artVersion, it.groundRevision) })
    }

    /** A live presentation revision (protocol 2 pages already assembled) as a battle scene. */
    fun liveScene(data: JsonObject, checkpoint: () -> Unit = {}): BattleScene {
        VisualContext.of(data)?.let { log("raid ${data.string("raidId")} ${it.describe()}") }
        return battleScene(requireNotNull(data["snapshot"] as? JsonObject), data.objects("buildingHealth"), data,
            PresentationRevision(requireNotNull(data.string("raidId")), requireNotNull(data.string("revision")),
                requireNotNull(data.string("simVersion")).toInt(), requireNotNull(data.string("lastSequence")).toLong(), 0,
                data.objects("events").map { checkpoint(); PresentationEvent.fromJson(it.toString()) }), playing = false, checkpoint = checkpoint)
    }

    /** A campaign stronghold preview (`/campaign/:stage/preview`): the snapshot only, no actors, paused. */
    fun previewScene(preview: JsonObject, simVersion: Int): BattleScene {
        val stage = requireNotNull(preview.string("stage")) { "Campaign preview has no stage" }
        VisualContext.of(preview)?.let { log("preview stage $stage ${it.describe()}") }
        return battleScene(requireNotNull(preview["snapshot"] as? JsonObject), emptyList(), preview,
            PresentationRevision("campaign-preview-$stage", "preview", simVersion, 0, 0, emptyList()), playing = false)
    }

    /** A scouted player's deed (`/map/scout/:target`): the report IS the snapshot (buildings, obstacles, centred
     * claim bounds), no actors, paused — the same read-only renderer the web routes to the 'scout' screen. */
    fun scoutScene(report: JsonObject, target: String, simVersion: Int): BattleScene {
        VisualContext.of(report)?.let { log("scout $target ${it.describe()}") }
        return battleScene(report, emptyList(), report, PresentationRevision("scout-$target", "preview", simVersion, 0, 0, emptyList()), playing = false)
    }

    /** An archived replay (`/battles/participated/:id/replay`). */
    fun replayScene(replay: JsonObject, checkpoint: () -> Unit = {}): BattleScene {
        val archiveSim=requireNotNull(replay.string("simVersion")).toInt()
        require(archivedReplaySupported(archiveSim,catalogue["simVersion"]?.jsonPrimitive?.intOrNull,renderCatalogue)) {
            "This archive requires a compatible native presentation update"
        }
        VisualContext.of(replay)?.let { log("replay ${replay.string("id")} ${it.describe()}") }
        val events = replay.objects("events").map { checkpoint(); PresentationEvent.fromJson(it.toString()) }
        require(events.isNotEmpty()) { "This replay contains no combat events" }
        val revision = PresentationRevision(requireNotNull(replay.string("id")), replay["timeline"]?.jsonObject?.string("sha256") ?: "archive",
            archiveSim, 0, 0, events)
        return battleScene(requireNotNull(replay["snapshot"]?.jsonObject), replay.objects("buildingHealth"), replay, revision, playing = true, checkpoint = checkpoint)
    }

    private fun battleScene(snapshot: JsonObject, health: List<JsonObject>, source: JsonObject, revision: PresentationRevision, playing: Boolean,
        checkpoint: () -> Unit = {}): BattleScene {
        val presentation = requireNotNull(catalogue["presentation"] as? JsonObject)
        val constants = requireNotNull(catalogue["constants"] as? JsonObject)
        checkpoint()
        val frames = actorArtwork(source, renderCatalogue)
        checkpoint()
        val base = mapBaseScene(snapshot, health, VisualContext.of(source), checkpoint, true,
            BaseServiceFacts.frozen(source, snapshot, completedMarketOutput()))
        val camera = constants.getValue("RAID_CAMERA").jsonObject
        val cameraSpec = BattleCameraSpec(camera.getValue("minZoom").jsonPrimitive.float, camera.getValue("maxZoom").jsonPrimitive.float,
            camera.getValue("fitMaxZoom").jsonPrimitive.float, camera.getValue("fitPadTiles").jsonPrimitive.float,
            constants.getValue("RAID_RULES").jsonObject.getValue("deployMarginTiles").jsonPrimitive.float,
            camera.getValue("northHeadroomWorldPx").jsonPrimitive.float)
        val policy = battlefieldPolicy(snapshot, base, constants)
        val defender = base.buildings.takeIf { policy.version != policy.legacyVersion && it.isNotEmpty() }?.let { buildings ->
            BaseWorldBounds(buildings.minOf { it.tileX }, buildings.minOf { it.tileY },
                buildings.maxOf { it.tileX + it.footprintWidth }, buildings.maxOf { it.tileY + it.footprintHeight })
        }
        return BattleScene(base.copy(battlefield = policy, battleCamera = cameraSpec, defenderBounds = defender), revision, frames,
            requireNotNull(presentation.string("unitsPerTile")).toFloat(), requireNotNull(presentation.string("tickMs")).toFloat(),
            requireNotNull((constants["RAID_RULES"] as? JsonObject)?.string("troopFireVisualTicks")).toInt(),
            requireNotNull(constants["TROOP_ABILITIES"]?.jsonObject?.get("hexbarrow")?.jsonObject?.get("brood")?.jsonObject?.string("positionKeyframeTicks")).toInt(),
            playing = playing, deploymentFrames = if((renderCatalogue["sensoryPolicy"] as? JsonObject)?.containsKey("deploymentPreview")==true)
                deploymentArtwork(source, renderCatalogue) else emptyMap(),
            actorMaxHp = actorDisplayMaxHp(source,renderCatalogue,catalogue,frames))
    }
}

/** Strict service-only scalar boundary; legacy scene parsing remains unchanged. */
private fun positiveServiceInteger(value: JsonElement?): Int {
    val scalar = requireNotNull(value as? JsonPrimitive)
    require(!scalar.isString)
    return requireNotNull(scalar.intOrNull).also { require(it > 0) }
}

/** CONTINUITY: the typed renderer identity rows for the current Home entry only (null stays null; frozen entries never call this). */
internal fun renderFleetIdentity(identity: CurrentFleetIdentity?): List<RenderFleetInstallationIdentity>? =
    identity?.installations?.map { RenderFleetInstallationIdentity(it.berthId, it.installationId, it.family, it.tier) }?.let { Collections.unmodifiableList(it) }
