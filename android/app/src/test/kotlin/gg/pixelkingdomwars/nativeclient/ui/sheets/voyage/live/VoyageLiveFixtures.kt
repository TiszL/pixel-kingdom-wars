package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionState
import gg.pixelkingdomwars.nativeclient.data.StarterFleetState
import gg.pixelkingdomwars.nativeclient.data.VehicleJournal
import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.data.VehicleState
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionFeature
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionFeatures
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionFlight
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionHome
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionJournal
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionRoute
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionView
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetBerth
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetFeature
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetFeatures
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetInstallation
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetJournal
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetView
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.vehicle.OrdinaryRoute
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** Server-shaped snapshots for the voyage live mapper tests (the shapes VehicleProtocol / the starter protocol accept). */
internal object VoyageFx {
    const val BASE = "b1"
    const val WALLET = "W1"
    val NOW: Long = Instant.parse("2030-01-01T18:20:00Z").toEpochMilli()
    val identity = StarterIdentity("https://api.example", "devnet", WALLET)

    fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    val buildings = listOf(Building("lodge-1", "lodge", 4, 0, 0), Building("berth-1", "berth", 5, 4, 0))
    val buildingsNoBerth = listOf(Building("lodge-1", "lodge", 4, 0, 0))

    /** Two islands: a HOME Grade I island in Elderwood and a Grade II island in Cinderfall (a permit realm). */
    val catalogue = listOf(
        OrdinaryRoute("glasswake-1", "glasswake", 0, "elderwood", 1),
        OrdinaryRoute("ashreef-2", "ashreef", 1, "cinderfall", 2),
    )
    val policy = VoyagePolicyFacts(tiers = listOf(1L, 2L, 3L, 4L), tripsPerInstall = 10L, routes = catalogue)

    fun starterRoute(id: String, seconds: Long = 12_000, net: String = "108") = StarterExpeditionRoute(1, 1, id, "elderwood",
        "heartwood_logs", "starter", seconds, "120", net, "12")

    val starterInstallation = StarterFleetInstallation("inst-starter", BASE, "berth-1", "starter", "job-1",
        "2030-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z")

    fun starterView(installation: StarterFleetInstallation? = starterInstallation, flight: StarterExpeditionFlight? = null,
        accepting: Boolean = true, home: String? = "elderwood", thorn: String = "2") = StarterExpeditionView(WALLET, BASE,
        "2030-01-01T18:20:00.000Z", StarterExpeditionFeatures(StarterExpeditionFeature(1, 1)), accepting,
        home?.let { StarterExpeditionHome("free_assignment", 1, it) },
        listOf(starterRoute("introduction", 600), starterRoute("long_survey", 30_000), starterRoute("coastal_survey")),
        installation, flight, "2030-01-01T00:00:00.000Z",
        listOf(OrdinaryRawStock("thorn_fibre", thorn, "0", thorn), OrdinaryRawStock("heartwood_logs", "40", "0", "40")))

    fun starter(view: StarterExpeditionView? = starterView(), busy: Boolean = false) =
        StarterExpeditionState(StarterExpeditionJournal(1, identity, 0, null, emptyList()), view, busy = busy, advertised = true)

    fun starterFleet(installation: StarterFleetInstallation? = starterInstallation, accepting: Boolean = true, berths: Boolean = true) =
        StarterFleetState(StarterFleetJournal(1, identity, 0, null, emptyList()), StarterFleetView(WALLET, BASE,
            "2030-01-01T18:20:00.000Z", StarterFleetFeatures(StarterFleetFeature(1, 1)), accepting, installation,
            if (berths) listOf(StarterFleetBerth("berth-1", "job-1", "2030-01-01T00:00:00.000Z")) else emptyList()), advertised = true)

    /** One fleet row (the `/vehicles/fleet` vehicle shape); [berth] is the Berth building it docks in. */
    fun row(id: String, family: String, tier: Int, left: Int, away: Boolean = false, pendingService: Boolean = false, berth: String = "berth-1") =
        """{"installationId":"$id","berthId":"$berth","family":"$family","tier":$tier,"revision":1,"completedTotal":"${10 - left}",
           "allowanceStart":"0","remainingUses":$left,"away":$away,"pendingService":$pendingService}"""

    fun fleet(vararg rows: String, accepting: Boolean = true) =
        obj("""{"version":1,"wallet":"$WALLET","baseId":"$BASE","serverNow":"2030-01-01T18:20:00.000Z","acceptingNewActions":$accepting,
            "vehicles":[${rows.joinToString(",")}]}""")

    /** A `/vehicles/client/routes` preview for (installation, route). */
    fun preview(routeId: String, realm: String, resource: String, access: String, tier: Int = 2) =
        """{"policyVersion":2,"family":"cargo_cutter","tier":$tier,"homeRealmId":"elderwood","routeId":"$routeId","realmId":"$realm",
            "resourceId":"$resource","accessRequirement":"$access","durationSec":12000,"grossQuantity":"120","netQuantity":"108",
            "islandPoolQuantity":"12","supplies":[{"resourceId":"thorn_fibre","quantity":"6"}]}"""

    fun routes(installationId: String, vararg previews: String) =
        obj("""{"version":1,"wallet":"$WALLET","baseId":"$BASE","items":[{"installationId":"$installationId","previews":[${previews.joinToString(",")}]}]}""")

    fun assets(vararg identities: Pair<String, Pair<String, Int>>, nextCursor: String? = null) = obj(
        """{"version":2,"wallet":"$WALLET","items":[${identities.joinToString(",") { (asset, ft) ->
            """{"identity":{"assetId":"$asset","collection":"C1","family":"${ft.first}","tier":${ft.second}},"observedSlot":1,"provenance":{"kind":"owner_attested"}}"""
        }}],"nextCursor":${nextCursor?.let { "\"$it\"" } ?: "null"}}""")

    /** An accepted crafted expedition record; [returned] adds the server `return`. */
    fun expedition(id: String, installationId: String, routeId: String, departed: String, returns: String, returned: Boolean = false,
        net: String = "108") = VehicleRecord(id, "expedition", "key-$id", obj("""{"idempotencyKey":"key-$id","baseId":"$BASE",
            "installationId":"$installationId","routeId":"$routeId","policyVersion":2}"""), JsonObject(emptyMap()),
        response = obj("""{"wallet":"$WALLET","idempotencyKey":"key-$id","serverNow":"2030-01-01T18:20:00.000Z","status":"accepted",
            "receipt":{"expeditionId":"$id","installationId":"$installationId","departedAt":"$departed","returnsAt":"$returns",
              "route":{"routeId":"$routeId","family":"cargo_cutter","tier":2,"resourceId":"heartwood_logs","netQuantity":"$net"}},
            "return":${if (returned) """{"returnId":"ret-$id","returnedAt":"$returns","completedTotal":"4"}""" else "null"}}"""))

    fun vehicles(fleet: JsonObject? = null, routes: JsonObject? = null, assets: JsonObject? = null,
        pending: List<VehicleRecord> = emptyList(), busy: Boolean = false) =
        VehicleState(loaded = true, busy = busy, journal = VehicleJournal(identity = identity, pending = pending),
            assets = assets, fleet = fleet, routes = routes)

    fun inputs(starter: StarterExpeditionState? = null, starterFleet: StarterFleetState? = null, vehicles: VehicleState? = null,
        buildings: List<Building>? = this.buildings, walletLinked: Boolean = true, policy: VoyagePolicyFacts = this.policy,
        orders: String? = null) = VoyageLiveInputs(buildings, BASE, starter, starterFleet, vehicles, policy,
        ordersBlockedReason = orders, walletLinked = walletLinked, nowMs = NOW, zone = ZoneOffset.UTC)
}

/** Records every callback a live Actions stub makes, so a test can assert what was (and was NOT) called. */
internal class Calls {
    val log = mutableListOf<String>()
    val toasts get() = log.filter { it.startsWith("toast:") }.map { it.removePrefix("toast:") }
    fun lodge(local: LodgeLocalState = LodgeLocalState(), onLocal: (LodgeLocalState) -> Unit = {}) = LodgeLiveCallbacks(
        update = { f -> onLocal(f(local)); log += "update" },
        toast = { log += "toast:$it" },
        reviewStarterDeparture = { log += "starter:$it" },
        dispatchCrafted = { inst, route -> log += "dispatch:$inst:$route" },
        checkPending = { log += "check" },
        collectAll = { log += "collect" },
        retryPreview = { log += "retry" },
        go = { door, arg -> log += "go:$door:$arg" },
        close = { log += "close" },
    )
    fun berth(local: BerthLocalState = BerthLocalState(), onLocal: (BerthLocalState) -> Unit = {}) = BerthLiveCallbacks(
        update = { f -> onLocal(f(local)); log += "update" },
        toast = { log += "toast:$it" },
        reviewStarterInstall = { log += "starterInstall" },
        loadAssets = { log += "assets:$it" },
        checkPending = { log += "check" },
        go = { door, arg -> log += "go:$door:$arg" },
        close = { log += "close" },
    )
}
