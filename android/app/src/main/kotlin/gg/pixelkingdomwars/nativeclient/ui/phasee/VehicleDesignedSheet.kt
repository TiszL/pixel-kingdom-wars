package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.charter.CharterGrammar
import gg.pixelkingdomwars.nativeclient.charter.charterObject
import gg.pixelkingdomwars.nativeclient.charter.charterOptional
import gg.pixelkingdomwars.nativeclient.charter.charterText
import gg.pixelkingdomwars.nativeclient.data.VehicleCraftSelection
import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PixelShapes
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.BackTitleRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.CheckBadge
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.ChoiceChip
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.GoRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RefreshLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.SERVICE_TAB_ICON
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.SeaWell
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripsMeter
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleSprite
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageIcon
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageLabel
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.berthArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.familyName
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.familyShortName
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.vehicleIdleArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.wellScale
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.vehicleFamilyOf
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.voyageIcon
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleCraftProtocol
import gg.pixelkingdomwars.nativeclient.vehicle.VehiclePolicy
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleProtocol
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

/*
 * The vehicle owner's body on the designed set (owner 2026-10-06, screenshot 1: the old dark "VEHICLES & EXPEDITIONS"
 * page opened over Home). It replaces VehicleScreen on the player path and keeps EVERYTHING that page owned: the same
 * VehicleViewModel, the same explicit original-request steps (reserve, prepare, review, approve, save approval, deliver,
 * recover, archive) and the same wallet MFA dialog. No signing, submission or payment code lives here; every button calls
 * the existing model method the old page called, under the same `vehicleControls` gates. Numbers come from the server.
 *
 * Look (voyage/berth-install.png, voyage/berth-service.png, map/solana-island.png): a TALL wood sheet, title plate,
 * FLEET · INSTALL · SERVICE tabs (the Public Workshop entry is its own untabbed page), History in the header, parchment
 * body with cream rows, sea wells with the vehicle sprites, and ONE gold primary per page in the footer.
 * A refresh never blanks what is shown: it only draws the 2 dp refresh line.
 */

internal const val VEHICLE_PAGE_FLEET = "fleet"
internal const val VEHICLE_PAGE_INSTALL = "install"
internal const val VEHICLE_PAGE_SERVICE = "service"
internal const val VEHICLE_PAGE_CRAFT = "craft"
internal const val VEHICLE_PAGE_HISTORY = "history"
private val VEHICLE_PAGES = setOf(VEHICLE_PAGE_FLEET, VEHICLE_PAGE_INSTALL, VEHICLE_PAGE_SERVICE, VEHICLE_PAGE_CRAFT, VEHICLE_PAGE_HISTORY)

/** The Berth tabs of the designed vehicle sheet; the craft entry ("PUBLIC WORKSHOP") draws no strip. */
internal fun vehicleSheetTabs(craftEntry: Boolean): List<TabUi> = if (craftEntry) emptyList() else listOf(
    TabUi(VEHICLE_PAGE_FLEET, "ui:lodge-menu", "FLEET", null, false),
    TabUi(VEHICLE_PAGE_INSTALL, "shape:anchor", "INSTALL", null, false),
    TabUi(VEHICLE_PAGE_SERVICE, SERVICE_TAB_ICON, "SERVICE", null, false),
)

/** The page a sheet opens on: a known entry page, else FLEET. */
internal fun vehicleSheetStartPage(initialPage: String): String = initialPage.takeIf { it in VEHICLE_PAGES } ?: VEHICLE_PAGE_FLEET

/** One installed vehicle of the selected kingdom (server fleet read). */
internal data class VehicleInstalledRow(val id: String, val family: String, val tier: Long, val remainingUses: Long, val berthId: String,
    val away: Boolean, val pendingService: Boolean, val accepting: Boolean, val raw: JsonObject) {
    val available: Boolean get() = accepting && !away && !pendingService
}

/** Null while the selected kingdom's fleet is not loaded (or was read for another kingdom); an unreadable read is null too. */
internal fun vehicleInstalledRows(fleet: JsonObject?, baseId: String?): List<VehicleInstalledRow>? {
    if (fleet == null || baseId == null) return null
    return runCatching {
        if (fleet.charterText("baseId") != baseId) return null
        val accepting = CharterGrammar.bool(fleet.getValue("acceptingNewActions"))
        fleet.getValue("vehicles").jsonArray.map { raw ->
            val row = raw.jsonObject
            VehicleInstalledRow(row.charterText("installationId"), row.charterText("family"), CharterGrammar.number(row.getValue("tier")),
                CharterGrammar.number(row.getValue("remainingUses")), row.charterText("berthId"), CharterGrammar.bool(row.getValue("away")),
                CharterGrammar.bool(row.getValue("pendingService")), accepting, row)
        }
    }.getOrNull()
}

/** One owned wallet vehicle asset (server discovery page). */
internal data class VehicleOwnedAsset(val id: String, val family: String, val tier: Long, val collection: String, val identity: JsonObject, val item: JsonObject)

/** Null until owned assets were checked; an unreadable page is null too. */
internal fun vehicleOwnedAssets(assets: JsonObject?): List<VehicleOwnedAsset>? = assets?.let { page ->
    runCatching {
        page.getValue("items").jsonArray.map { raw ->
            val item = raw.jsonObject; val identity = item.charterObject("identity")
            VehicleOwnedAsset(identity.charterText("assetId"), identity.charterText("family"), CharterGrammar.number(identity.getValue("tier")),
                identity.charterText("collection"), identity, item)
        }
    }.getOrNull()
}

/** The server route previews of one installed vehicle (empty when none or unreadable). */
internal fun vehicleRoutePreviews(routes: JsonObject?, baseId: String?, installationId: String): List<JsonObject> = runCatching {
    routes?.takeIf { it.charterText("baseId") == baseId }?.getValue("items")?.jsonArray?.map { it.jsonObject }
        ?.singleOrNull { it.charterText("installationId") == installationId }?.getValue("previews")?.jsonArray?.map { it.jsonObject }.orEmpty()
}.getOrDefault(emptyList())

/** "Survey Balloon" for a known family, else the server id in words. */
internal fun vehicleFamilyLabel(server: String): String = vehicleFamilyOf(server)?.let(::familyName) ?: islandShareResource(server)

/** One line of the sheet: [strong] lines are the headline facts, the rest the quiet explanation. */
internal data class VehicleLine(val text: String, val strong: Boolean = false)

/** The same facts the old page printed for a route: duration, net cargo and island share, provisions. */
internal fun vehicleRouteLines(route: JsonObject): List<VehicleLine> = runCatching {
    listOf(VehicleLine("Duration: ${fmtDur(CharterGrammar.number(route.getValue("durationSec")))}", true)) +
        vehicleCargoRows(route).map { VehicleLine("${it.label}: ${it.value}") } +
        VehicleLine("Provisions: " + route.getValue("supplies").jsonArray.joinToString {
            val s = it.jsonObject; "${fmtN(s.charterText("quantity"))} ${islandShareResource(s.charterText("resourceId"))}"
        })
}.getOrDefault(emptyList())

/** The selected original's facts, in the old page's words. Each section is read on its own, so a malformed one drops only itself. */
internal fun vehicleOriginalLines(r: VehicleRecord, selectedBase: String?, review: JsonObject?): List<VehicleLine> {
    val lines = mutableListOf<VehicleLine>()
    if (r.closedUnknown != null) lines += VehicleLine("Closed on this device: the server had no record of this request.")
    if (r.held) lines += VehicleLine("An original response needs verification. Keep this request and check its outcome.", true)
    if ("wallet" in r.attempts && r.signed == null && vehicleRecordPill(r).tone != PaymentTone.DONE)
        lines += VehicleLine("Wallet approval may have completed. Another prompt is blocked; recover this original.", true)
    runCatching { vehicleOriginalBase(r) }.getOrNull()?.let { base ->
        lines += VehicleLine(if (base == selectedBase) "Saved destination: currently selected kingdom."
            else "Saved destination: an earlier kingdom. Current selection does not move this operation.")
    }
    val v = r.response ?: return lines
    runCatching {
        when (r.kind) {
            "installation", "service" -> {
                val original = VehicleProtocol.original(v); val identity = original.charterObject("identity")
                val terminal = VehicleProtocol.terminal(v)
                lines += VehicleLine("${islandShareResource(identity.charterText("family"))} · tier ${identity["tier"]}", true)
                lines += VehicleLine("Status: ${v.charterObject("record").charterText("status").replace('_', ' ')}")
                lines += VehicleLine(if (terminal == null) "Approval permanently burns this original asset. Its committed kingdom and berth stay fixed, including after a kingdom sale."
                    else "The original burn and destination are confirmed by the saved receipt.")
                if (r.kind == "service") {
                    val effect = VehiclePolicy.from(r.policy).serviceEffect(original.charterObject("state"))
                    lines += VehicleLine("${if (terminal == null) "On completion" else "Applied result"}: ${if (effect.charterText("operation") == "upgrade") "tier upgrade" else "use restoration"} · tier ${effect["tierAfter"]} · ${effect["remainingUses"]} uses remaining", true)
                }
                if (terminal == null) lines += review?.charterOptional("observation")?.let { VehicleLine("${marketSol(it.charterText("networkFeeLamports"))} SOL · reviewed network fee", true) }
                    ?: VehicleLine("Review this original burn to obtain its exact current network fee before approval.")
                vehicleFinalFee(r)?.let { lines += VehicleLine("$it · finalized network fee", true) }
                v.charterOptional("burnReceipt")?.let { lines += VehicleLine("${marketSol(it.charterText("assetRefundLamports"))} SOL · asset rent returned") }
            }
            "expedition" -> {
                v.charterOptional("receipt")?.let { lines += VehicleLine("Scheduled return: ${islandShareTime(it.charterText("returnsAt"))}", true) }
                val returned = v.charterOptional("return")
                lines += if (returned != null) VehicleLine("Returned ${islandShareTime(returned.charterText("returnedAt"))} · ${returned["completedTotal"]} completed uses", true)
                    else VehicleLine("A scheduled return time is not a completed delivery. Check the original or collect completed expeditions.")
                (v.charterOptional("receipt")?.charterObject("route") ?: r.preview)?.let { route ->
                    lines += VehicleLine("ORIGINAL CARGO & PROVISIONS", true)
                    lines += vehicleRouteLines(route)
                }
            }
            "collect" -> lines += VehicleLine("Collected ${v["returned"]} completed returns. Individual expedition receipts preserve each original result.")
        }
        Unit
    }
    return lines
}

/** One explicit step of a saved original; [forward] steps move the money sequence on (the first one is the gold primary). */
private class VehicleStep(val label: String, val forward: Boolean, val enabled: Boolean = true, val run: () -> Unit)

/**
 * The designed vehicle sheet. Same parameters and owners as the retired VehicleScreen (minus the route art, which the
 * Lodge's designed SEND draws now), so VehicleRegistration swaps one call.
 */
@Composable internal fun VehicleDesignedSheet(model: VehicleViewModel, allowed: Boolean, configured: Boolean, selectedBase: String?,
    berths: List<String>, back: () -> Unit, policy: VehiclePolicy? = null, initialPage: String = VEHICLE_PAGE_FLEET) {
    val state by model.state.collectAsState(); val running by model.busy.collectAsState(); val notice by model.notice.collectAsState()
    val idle = !state.busy && !running
    val controls = vehicleControls(state, allowed, configured, running)
    val wallet = model.wallet; val mfa = wallet?.mfa?.collectAsState()?.value
    val craftEntry = initialPage == VEHICLE_PAGE_CRAFT
    var page by rememberSaveable(initialPage) { mutableStateOf(vehicleSheetStartPage(initialPage)) }
    var tabPage by rememberSaveable(initialPage) { mutableStateOf(vehicleSheetStartPage(initialPage).takeIf { it != VEHICLE_PAGE_HISTORY } ?: VEHICLE_PAGE_FLEET) }
    var asset by rememberSaveable(selectedBase) { mutableStateOf<String?>(null) }
    var berth by rememberSaveable(selectedBase) { mutableStateOf<String?>(null) }
    var serviceOn by rememberSaveable(selectedBase) { mutableStateOf<String?>(null) }
    var serviceOp by rememberSaveable(selectedBase) { mutableStateOf("restore_uses") }
    var fleetTried by remember(selectedBase) { mutableStateOf(false) }
    var assetsTried by remember(selectedBase) { mutableStateOf(false) }
    val scroll = rememberScrollState()
    BackHandlerAt(BackPriority.SCREEN) { model.dismiss(); back() }
    BackHandlerAt(BackPriority.CONFIRM, mfa != null) { mfa?.let { wallet?.cancelMfa(it) } }
    LaunchedEffect(allowed, configured, selectedBase) { model.dismiss() }
    // A saved original or an error opens at the top of the body, where its card and line are drawn.
    LaunchedEffect(state.selectedId) { if (state.selectedId != null) scroll.animateScrollTo(0) }
    LaunchedEffect(notice, state.error) { if (notice?.error == true || state.error != null) scroll.animateScrollTo(0) }

    val fleetRows = vehicleInstalledRows(state.fleet, selectedBase)
    val fleetUnreadable = state.fleet != null && selectedBase != null && fleetRows == null &&
        runCatching { state.fleet?.charterText("baseId") == selectedBase }.getOrDefault(false)
    val owned = vehicleOwnedAssets(state.assets)
    val chosen = owned?.singleOrNull { it.id == asset }
    val serviced = fleetRows?.singleOrNull { it.id == serviceOn } ?: fleetRows?.firstOrNull()
    // Reads only (GET): the fleet when the Berth opens, the wallet assets when INSTALL or SERVICE is shown. Each runs once
    // per kingdom; the player's REFRESH taps re-read on demand.
    LaunchedEffect(selectedBase, idle, page) {
        if (!idle || selectedBase == null) return@LaunchedEffect
        if (!fleetTried && fleetRows == null && page != VEHICLE_PAGE_CRAFT && page != VEHICLE_PAGE_HISTORY) { fleetTried = true; model.fleet(selectedBase) }
        else if (!assetsTried && state.assets == null && (page == VEHICLE_PAGE_INSTALL || page == VEHICLE_PAGE_SERVICE)) { assetsTried = true; model.assets() }
    }
    LaunchedEffect(berths) { if (berth !in berths) berth = berths.singleOrNull() }

    val gates = listOfNotNull(
        "Select a kingdom to view its berths and fleet.".takeIf { selectedBase == null && page != VEHICLE_PAGE_HISTORY },
        "Vehicle burn approval is unavailable. Existing fleet and saved operations remain accessible.".takeIf { !configured && page != VEHICLE_PAGE_CRAFT },
        "New actions are paused. Check saved originals to recover their outcomes.".takeIf { !allowed },
    )
    val selectedRecord = state.selected
    val originalLines = remember(selectedRecord, selectedBase, state.review) { selectedRecord?.let { vehicleOriginalLines(it, selectedBase, state.review) }.orEmpty() }
    val steps = selectedRecord?.let { r -> buildList {
        if (vehicleRetryable(r))
            add(VehicleStep("RETRY SAME ORIGINAL REQUEST", false, idle && (allowed || r.kind == "collect") && !r.held) { model.retry(r.id) })
        if (vehicleClosableUnknown(r))
            add(VehicleStep("CLOSE IF THE SERVER HAS NO RECORD", false, idle && !r.held) { model.closeUnknown() })
        if (controls.deliver) add(VehicleStep("DELIVER ORIGINAL SIGNED BURN", true) { model.deliver() })
        if (controls.approve) add(VehicleStep("APPROVE ORIGINAL BURN", true) { model.approve() })
        if (controls.upload) add(VehicleStep("SAVE EXISTING WALLET APPROVAL", true) { model.upload() })
        if (controls.prepare) add(VehicleStep("PREPARE ORIGINAL BURN", true) { model.command("prepare") })
        if (controls.review) add(VehicleStep("REVIEW ORIGINAL BURN & FEE", true) { model.review() })
        if (controls.recover) add(VehicleStep("RECOVER ORIGINAL BURN OUTCOME", false) { model.command("recover") })
        if (controls.archive) add(VehicleStep("ARCHIVE VERIFIED ORIGINAL", false) { model.archive() })
    } }.orEmpty()

    // Footer primaries (one per page). Every state still answers a tap: a refused one says why.
    val installReason = when {
        selectedBase == null -> "Select a kingdom to view its berths and fleet."
        !configured -> "Vehicle burn approval is unavailable. Existing fleet and saved operations remain accessible."
        !allowed -> "New actions are paused. Check saved originals to recover their outcomes."
        berths.isEmpty() -> "An empty Berth is required. Place a new Berth on your base, then reserve here."
        chosen == null -> "Choose an owned vehicle asset"
        berth == null -> "Choose a berth for this vehicle."
        else -> null
    }
    val serviceChoice = serviced?.let { vehicleServiceChoice(it.raw, chosen?.identity, policy, serviceOp) }
    val serviceReason = when {
        selectedBase == null -> "Select a kingdom to view its berths and fleet."
        serviced == null -> "No advanced vehicles are installed in this kingdom. Open Install to reserve one."
        !configured -> "Vehicle burn approval is unavailable. Existing fleet and saved operations remain accessible."
        !allowed -> "New actions are paused. Check saved originals to recover their outcomes."
        !serviced.accepting -> "This kingdom’s new vehicle actions are paused."
        serviced.away -> "Away on expedition"
        serviced.pendingService -> "Original service pending"
        serviceChoice?.allowed != true -> serviceChoice?.reason ?: "Service details are unavailable. Refresh the fleet and owned assets."
        else -> null
    }
    val footer: @Composable ColumnScope.() -> Unit = {
        when (page) {
            VEHICLE_PAGE_INSTALL -> PrimaryButton("RESERVE THIS INSTALLATION", onClick = {
                val base = selectedBase; val pick = chosen; val dock = berth
                if (installReason == null && base != null && pick != null && dock != null) model.reserve(base, dock, pick.id)
                else Toasts.post(installReason ?: "Choose an owned vehicle asset")
            }, modifier = Modifier.fillMaxWidth(), state = when { !idle -> CommandState.BUSY; installReason != null -> CommandState.DISABLED; else -> CommandState.ENABLED },
                reason = installReason)
            VEHICLE_PAGE_SERVICE -> PrimaryButton(if (serviceOp == "upgrade") "RESERVE TIER UPGRADE" else "RESERVE USE RESTORATION", onClick = {
                val base = selectedBase; val pick = chosen; val target = serviced
                if (serviceReason == null && base != null && pick != null && target != null) model.service(base, target.id, pick.id, serviceOp)
                else Toasts.post(serviceReason ?: "Choose an owned asset to burn for this service.")
            }, modifier = Modifier.fillMaxWidth(), state = when { !idle -> CommandState.BUSY; serviceReason != null -> CommandState.DISABLED; else -> CommandState.ENABLED },
                reason = serviceReason, sub = chosen?.let { "uses up 1 ${vehicleFamilyLabel(it.family)} T${it.tier}" })
            VEHICLE_PAGE_CRAFT -> CraftFooter(model, idle, selectedBase)
            else -> Unit
        }
    }
    val hasFooter = page == VEHICLE_PAGE_INSTALL || page == VEHICLE_PAGE_SERVICE || (page == VEHICLE_PAGE_CRAFT && model.craftState != null)

    // Owner 2026-10-06 ("every sheet is full screen"): the same full-screen card as the Berth that opens it, with the sea
    // header art band (PhaseEDesignedFrames.kt), never a dark page with a gutter.
    PhaseEFullScreenCard {
        SheetFrame(SheetFrameUi(if (craftEntry) "PUBLIC WORKSHOP" else "BERTH", null, SheetSize.TALL, vehicleSheetTabs(craftEntry),
            if (craftEntry || page == VEHICLE_PAGE_HISTORY) null else tabPage, history = page != VEHICLE_PAGE_HISTORY),
            onClose = { model.dismiss(); back() }, modifier = Modifier.fillMaxSize(), header = { PhaseESeaHeader() },
            onTab = { selected -> tabPage = selected; page = selected },
            onHistory = { page = VEHICLE_PAGE_HISTORY },
            footer = if (hasFooter) footer else null, scrollState = scroll) {
            RefreshLine(!idle)
            gates.forEach { GateRow(it) }
            if (!state.loaded) PkwText("Loading vehicle activity and saved originals…", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            Column(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                notice?.let { PkwText(it.message, PkwTokens.Type.body, color = if (it.error) PkwTokens.Colors.shortText else PkwTokens.Colors.textOnParch, maxLines = 5) }
                state.error?.let { PkwText(it, PkwTokens.Type.body, color = PkwTokens.Colors.shortText, maxLines = 5) }
            }
            selectedRecord?.let { r -> OriginalCard(r, originalLines, steps, idle) }
            when (page) {
                VEHICLE_PAGE_INSTALL -> InstallPage(model, idle, owned, chosen, berths, berth, state.assets, { asset = it }, { berth = it },
                    onCraft = { page = VEHICLE_PAGE_CRAFT })
                VEHICLE_PAGE_SERVICE -> ServicePage(model, idle, selectedBase, fleetRows, serviced, serviceOp, owned, state.assets, chosen, policy,
                    onVehicle = { serviceOn = it }, onOp = { serviceOp = it }, onAsset = { asset = it }, onInstall = { tabPage = VEHICLE_PAGE_INSTALL; page = VEHICLE_PAGE_INSTALL })
                VEHICLE_PAGE_CRAFT -> CraftPage(model, idle, selectedBase, policy?.tiers.orEmpty(),
                    onInstall = if (craftEntry) null else ({ tabPage = VEHICLE_PAGE_INSTALL; page = VEHICLE_PAGE_INSTALL }))
                VEHICLE_PAGE_HISTORY -> HistoryPage(model, idle, state.activity, state.loaded, state.journal?.records,
                    onBack = { page = if (craftEntry) VEHICLE_PAGE_CRAFT else tabPage })
                else -> FleetPage(model, idle, allowed, selectedBase, fleetRows, fleetUnreadable, state.routes, policy,
                    onService = { id -> serviceOn = id; tabPage = VEHICLE_PAGE_SERVICE; page = VEHICLE_PAGE_SERVICE },
                    onInstall = { tabPage = VEHICLE_PAGE_INSTALL; page = VEHICLE_PAGE_INSTALL },
                    onCraft = { page = VEHICLE_PAGE_CRAFT })
            }
        }
    }
    if (mfa != null && wallet != null) SensitiveMfaDialog(mfa, submit = { wallet.submitMfa(mfa, it) }, cancelRequest = { wallet.cancelMfa(mfa) })
}

/** A gate is not a failure: a cream row with the info mark and the old page's sentence. */
@Composable private fun GateRow(text: String) {
    VoyageRow(minHeight = 44.dp) {
        PkwIcon("shape:info", 24.dp, Modifier.padding(start = 6.dp), tint = PkwTokens.Colors.textOnParch2)
        PkwText(text, PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 3)
    }
}

/** The pill of a saved original (vehicleRecordPill), as a small tinted veil tag. */
@Composable private fun StatusTag(label: String, tone: PaymentTone) {
    val tint = when (tone) {
        PaymentTone.DONE -> PkwTokens.Colors.green.lo
        PaymentTone.SENT -> PkwTokens.Colors.blue.lo
        PaymentTone.TROUBLE -> PkwTokens.Colors.gold.lo
        PaymentTone.OPEN, PaymentTone.CLOSED -> PkwTokens.Colors.veil
    }
    Plate(PlateKind.VEIL, Modifier.heightIn(min = 28.dp), tint = tint, blocksScene = false) {
        PkwText(label, PkwTokens.Type.caption, Modifier.align(Alignment.Center).padding(horizontal = 4.dp), color = PkwTokens.Colors.label, outline = 1.dp)
    }
}

/** The saved original being recovered: its facts, its details on demand, and its explicit steps (first forward = gold). */
@Composable private fun OriginalCard(r: VehicleRecord, lines: List<VehicleLine>, steps: List<VehicleStep>, idle: Boolean) {
    var detailsOpen by rememberSaveable(r.id) { mutableStateOf(false) }
    val details = remember(r) { runCatching { vehicleOriginalDetails(r) }.getOrDefault(emptyList()) }
    val pill = remember(r) { vehicleRecordPill(r) }
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText("ORIGINAL ${r.kind.uppercase()}", PkwTokens.Type.label, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch)
                StatusTag(pill.label, pill.tone)
            }
            lines.forEach { line ->
                PkwText(line.text, if (line.strong) PkwTokens.Type.body else PkwTokens.Type.small, Modifier.fillMaxWidth(),
                    color = if (line.strong) PkwTokens.Colors.textOnParch else PkwTokens.Colors.textOnParch2, maxLines = 4)
            }
            if (details.isNotEmpty()) {
                QuietButton(if (detailsOpen) "Hide details" else "Details", { detailsOpen = !detailsOpen }, onParchment = true)
                if (detailsOpen) details.forEach { d ->
                    PkwText("${d.label}: ${d.value}", PkwTokens.Type.small, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch2, maxLines = 2)
                }
            }
            PkwText("Closing this page keeps your original request, destination and approvals.", PkwTokens.Type.small,
                color = PkwTokens.Colors.textOnParch2, maxLines = 2)
            val primary = steps.firstOrNull { it.forward }
            steps.forEach { step ->
                if (step === primary) PrimaryButton(step.label, { if (idle) step.run() }, Modifier.fillMaxWidth(),
                    state = if (idle) CommandState.ENABLED else CommandState.BUSY)
                else SecondaryButton(step.label, step.run, Modifier.fillMaxWidth(), enabled = idle && step.enabled)
            }
        }
    }
}

/** A vehicle in its sea well (the berth's art); an unknown family draws the Lodge mark. */
@Composable private fun VehicleWell(family: String, tier: Long?, modifier: Modifier) {
    val known = vehicleFamilyOf(family)
    SeaWell(modifier, waves = family.hashCode()) {
        if (known != null) VehicleSprite(known, tier?.toInt(), wellScale(known, tallWell = false), Modifier.fillMaxSize())
        else VoyageIcon("ui:lodge-menu", 32.dp)
    }
}

/** FLEET: every installed vehicle with its trips, its server-previewed routes (SEND) and its service door. */
@Composable private fun FleetPage(model: VehicleViewModel, idle: Boolean, allowed: Boolean, selectedBase: String?, rows: List<VehicleInstalledRow>?,
    unreadable: Boolean, routes: JsonObject?, policy: VehiclePolicy?, onService: (String) -> Unit, onInstall: () -> Unit, onCraft: () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        SecondaryButton("REFRESH", { selectedBase?.let { model.fleet(it) } }, Modifier.weight(1f), enabled = idle && selectedBase != null,
            contentDescription = "Check existing fleet and routes")
        SecondaryButton("COLLECT", { selectedBase?.let { model.collect(it) } }, Modifier.weight(1f), verb = Verb.GOLD, enabled = idle && selectedBase != null,
            contentDescription = "Collect completed expeditions")
    }
    when {
        unreadable -> EmptyState(EmptyStateUi("ui:lodge-menu", "FLEET", "Fleet details could not be refreshed. Original receipts remain available.", null, null), onGo = {})
        rows == null -> VoyageLabel("FLEET", if (idle) "Check the selected kingdom’s fleet to load installed vehicles and route previews."
            else "Loading vehicle activity and saved originals…")
        rows.isEmpty() -> EmptyState(EmptyStateUi("ui:lodge-menu", "No vehicle yet", "No advanced vehicles are installed in this kingdom. Open Install to reserve one.", null, null), onGo = {})
        else -> {
            VoyageLabel("INSTALLED FLEET", "${rows.size} in this kingdom")
            if (!rows.first().accepting) GateRow("This kingdom’s new vehicle actions are paused.")
            rows.forEach { row ->
                val previews = vehicleRoutePreviews(routes, selectedBase, row.id)
                val canSend = idle && allowed && row.available && row.remainingUses > 0
                Plate(PlateKind.CREAM, Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth().padding(4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            VehicleWell(row.family, row.tier, Modifier.size(72.dp, 64.dp))
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                PkwText("${vehicleFamilyLabel(row.family)} T${row.tier}", PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                                TripsMeter(row.remainingUses.toInt(), policy?.completedUses?.toInt(), Modifier.fillMaxWidth())
                                PkwText("${row.remainingUses} uses remaining · " + when {
                                    row.away -> "Away on expedition"; row.pendingService -> "Original service pending"; else -> "At berth"
                                }, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2)
                            }
                        }
                        previews.forEach { route ->
                            val routeId = runCatching { route.charterText("routeId") }.getOrNull()
                            val version = runCatching { CharterGrammar.number(route.getValue("policyVersion")) }.getOrNull()
                            val lines = vehicleRouteLines(route)
                            VoyageRow(minHeight = 52.dp) {
                                VoyageIcon(runCatching { voyageIcon(route.charterText("resourceId")) }.getOrDefault("ui:lodge-menu"), 32.dp, Modifier.padding(start = 6.dp))
                                Column(Modifier.weight(1f)) {
                                    PkwText(routeId?.let { islandShareResource(it.replace('-', '_')) } ?: "Route", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                                    lines.firstOrNull()?.let { PkwText(it.text, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
                                    lines.getOrNull(1)?.let { PkwText(it.text, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
                                }
                                SecondaryButton("SEND", {
                                    val base = selectedBase
                                    if (canSend && base != null && routeId != null) model.dispatch(base, row.id, routeId, version)
                                    else Toasts.post(if (!row.available) "This vehicle is not at its berth." else "New actions are paused. Check saved originals to recover their outcomes.")
                                }, Modifier.padding(end = 2.dp), verb = Verb.GOLD, enabled = canSend && routeId != null,
                                    contentDescription = "Dispatch this route")
                            }
                        }
                        if (previews.isEmpty()) PkwText("No route preview is available. Check fleet and routes again.", PkwTokens.Type.small,
                            color = PkwTokens.Colors.textOnParch2, maxLines = 2)
                        SecondaryButton("UPGRADE & RESTORE USES", { onService(row.id) }, Modifier.fillMaxWidth(), icon = SERVICE_TAB_ICON)
                    }
                }
            }
        }
    }
    GoRow("ui:lodge-menu", "Install a vehicle", "From your wallet into a finished berth", "GO", onInstall, "Open Install")
    GoRow("ui:solana-navigation", "Craft a vehicle", "Public Workshop on Solana Island", "GO", onCraft, "Open the Public Workshop")
}

/** A wallet vehicle tile (berth-install.png): the sprite in its sea well, "T2 Balloon", a gold rim and ✓ when chosen. */
@Composable private fun AssetTile(a: VehicleOwnedAsset, selected: Boolean, enabled: Boolean, onPick: () -> Unit, modifier: Modifier) {
    val known = vehicleFamilyOf(a.family)
    val label = "T${a.tier} ${known?.let(::familyShortName) ?: islandShareResource(a.family)}"
    Box(modifier) {
        Plate(PlateKind.CREAM, Modifier.fillMaxWidth()
            .then(if (selected) Modifier.border(3.dp, PkwTokens.Colors.gold.face, PixelShapes.M) else Modifier)
            .clearAndSetSemantics {
                contentDescription = "$label, ${vehicleFamilyLabel(a.family)}"; role = Role.Button; this.selected = selected
                this.onClick(label = null, action = { if (enabled) onPick(); true })
            }
            .clickable(enabled = enabled, role = Role.Button, onClick = onPick)) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                VehicleWell(a.family, a.tier, Modifier.fillMaxWidth().heightIn(min = 72.dp))
                PkwText(label, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center)
            }
        }
        if (selected) CheckBadge(Modifier.align(Alignment.TopEnd).padding(2.dp))
    }
}

/** The owned-asset picker shared by INSTALL and SERVICE; [filter] narrows it (SERVICE: same family and tier). */
@Composable private fun AssetPicker(model: VehicleViewModel, idle: Boolean, owned: List<VehicleOwnedAsset>?, assetsPage: JsonObject?, chosen: VehicleOwnedAsset?,
    onAsset: (String) -> Unit, filter: (VehicleOwnedAsset) -> Boolean, title: String, onCraft: (() -> Unit)?) {
    val shown = owned?.filter(filter)
    VoyageLabel(title, if (shown == null) "Check owned assets to load current choices." else "From your wallet · ${shown.size} found")
    when {
        owned == null && assetsPage != null -> PkwText("Wallet assets could not be read. Try again.", PkwTokens.Type.small, color = PkwTokens.Colors.shortText)
        shown == null -> Unit
        shown.isEmpty() -> EmptyState(EmptyStateUi("ui:lodge-menu", "No vehicle in your wallet", "No owned vehicle assets on this page.", null, null), onGo = {})
        else -> shown.chunked(3).forEach { rowAssets ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                rowAssets.forEach { a -> AssetTile(a, a.id == chosen?.id, idle, { onAsset(a.id) }, Modifier.weight(1f)) }
                repeat(3 - rowAssets.size) { Box(Modifier.weight(1f)) }
            }
        }
    }
    chosen?.let { pick -> runCatching { vehicleCandidateSource(pick.item) }.getOrNull()?.let {
        PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 3)
    } }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        SecondaryButton("CHECK WALLET", { model.assets() }, Modifier.weight(1f), enabled = idle, contentDescription = "Check owned vehicle assets")
        val cursor = assetsPage?.get("nextCursor")?.takeUnless { it == JsonNull }?.let { runCatching { CharterGrammar.text(it) }.getOrNull() }
        if (cursor != null) SecondaryButton("MORE", { model.assets(cursor) }, Modifier.weight(1f), enabled = idle, contentDescription = "More owned assets")
    }
    if (onCraft != null && shown?.isEmpty() == true) GoRow("ui:solana-navigation", "Craft a vehicle", "Public Workshop on Solana Island", "GO", onCraft, "Open the Public Workshop")
}

/** INSTALL (berth-install.png): choose a wallet vehicle, choose the berth, and the install card; the footer reserves. */
@Composable private fun InstallPage(model: VehicleViewModel, idle: Boolean, owned: List<VehicleOwnedAsset>?, chosen: VehicleOwnedAsset?, berths: List<String>,
    berth: String?, assetsPage: JsonObject?, onAsset: (String) -> Unit, onBerth: (String) -> Unit, onCraft: () -> Unit) {
    AssetPicker(model, idle, owned, assetsPage, chosen, onAsset, { true }, "CHOOSE A VEHICLE", onCraft)
    // night/fix-vehicles-placement: [berths] is the vacant list (vacantBerthsForInstall), so the copy says empty, not completed.
    VoyageLabel("BERTH", "${berths.size} empty berths in this kingdom")
    if (berths.isEmpty()) EmptyState(EmptyStateUi("ui:lodge-menu", "No empty berth", "An empty Berth is required. Place a new Berth on your base, then reserve here.", null, null), onGo = {})
    else berths.withIndex().toList().chunked(4).forEach { chunk ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            chunk.forEach { (index, id) -> ChoiceChip("BERTH ${index + 1}", berth == id, { if (idle) onBerth(id) }, Modifier.weight(1f)) }
            repeat(4 - chunk.size) { Box(Modifier.weight(1f)) }
        }
    }
    chosen?.let { pick ->
        val known = vehicleFamilyOf(pick.family)
        Plate(PlateKind.CREAM, Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth().padding(6.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText("INSTALL ${vehicleFamilyLabel(pick.family).uppercase()}", PkwTokens.Type.title, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    VehicleWell(pick.family, pick.tier, Modifier.size(72.dp, 64.dp))
                    PkwText("→", PkwTokens.Type.title, color = PkwTokens.Colors.textOnParch)
                    if (known != null) SeaWell(Modifier.size(88.dp, 96.dp)) { VoyageIcon(berthArt(known), 64.dp) }
                }
                PkwText("Installation permanently burns the selected vehicle asset. The server verifies ownership and an eligible vacant berth before accepting the reservation.",
                    PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center, maxLines = 4)
                PkwText("The accepted reservation fixes this kingdom, berth and asset. Network fees are reviewed separately before wallet approval.",
                    PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center, maxLines = 4)
            }
        }
    }
}

/** SERVICE (berth-service.png): the vehicle, RESTORE or UPGRADE, and what you hand in; the footer reserves. */
@Composable private fun ServicePage(model: VehicleViewModel, idle: Boolean, selectedBase: String?, fleetRows: List<VehicleInstalledRow>?, target: VehicleInstalledRow?,
    op: String, owned: List<VehicleOwnedAsset>?, assetsPage: JsonObject?, chosen: VehicleOwnedAsset?, policy: VehiclePolicy?, onVehicle: (String) -> Unit,
    onOp: (String) -> Unit, onAsset: (String) -> Unit, onInstall: () -> Unit) {
    val rows = fleetRows.orEmpty()
    val serviced = target
    if (rows.isEmpty() || serviced == null) {
        EmptyState(EmptyStateUi("ui:lodge-menu", "No vehicle yet", "No advanced vehicles are installed in this kingdom. Open Install to reserve one.", null, null), onGo = {})
        SecondaryButton("REFRESH", { selectedBase?.let { model.fleet(it) } }, Modifier.fillMaxWidth(), enabled = idle && selectedBase != null,
            contentDescription = "Check existing fleet and routes")
        GoRow("ui:lodge-menu", "Install a vehicle", "From your wallet into a finished berth", "GO", onInstall, "Open Install")
        return
    }
    VoyageLabel("VEHICLE")
    rows.chunked(3).forEach { chunk ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            chunk.forEach { row ->
                val short = vehicleFamilyOf(row.family)?.let(::familyShortName) ?: islandShareResource(row.family)
                ChoiceChip("${short.uppercase()} T${row.tier}", row.id == serviced.id, { onVehicle(row.id) }, Modifier.weight(1f))
            }
            repeat(3 - chunk.size) { Box(Modifier.weight(1f)) }
        }
    }
    VoyageRow(minHeight = 72.dp) {
        VehicleWell(serviced.family, serviced.tier, Modifier.size(72.dp, 64.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            PkwText("${vehicleFamilyLabel(serviced.family).uppercase()} T${serviced.tier}", PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
            TripsMeter(serviced.remainingUses.toInt(), policy?.completedUses?.toInt(), Modifier.fillMaxWidth())
            PkwText("Tier ${serviced.tier} · ${serviced.remainingUses} uses remaining", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
        }
    }
    VoyageLabel("CHOOSE A SERVICE")
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (operation in listOf("restore_uses", "upgrade")) {
            val choice = vehicleServiceChoice(serviced.raw, chosen?.identity, policy, operation)
            val on = op == operation
            Box(Modifier.weight(1f)) {
                Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 112.dp)
                    .then(if (on) Modifier.border(3.dp, PkwTokens.Colors.gold.face, PixelShapes.M) else Modifier)
                    .clearAndSetSemantics {
                        contentDescription = (if (operation == "upgrade") "Upgrade" else "Restore") + ". " + choice.reason
                        role = Role.Tab; selected = on; onClick(label = null, action = { onOp(operation); true })
                    }
                    .clickable(role = Role.Tab) { onOp(operation) }, tint = if (on) PkwTokens.Colors.selectedTint else null) {
                    Column(Modifier.fillMaxWidth().padding(4.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (operation == "upgrade") VehicleWell(serviced.family, serviced.tier, Modifier.size(56.dp, 48.dp))
                        else VoyageIcon("voyage:fastener-set", 48.dp)
                        PkwText(if (operation == "upgrade") "UPGRADE" else "RESTORE", PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                        PkwText(choice.reason, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center, maxLines = 4)
                    }
                }
                if (on) CheckBadge(Modifier.align(Alignment.TopEnd).padding(2.dp))
            }
        }
    }
    val family = serviced.family; val tier = serviced.tier
    AssetPicker(model, idle, owned, assetsPage, chosen, onAsset, { it.family == family && it.tier == tier }, "YOU HAND IN", null)
    PkwText("Burn one owned asset matching this vehicle’s current family and tier. Service keeps this installed vehicle and berth.",
        PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 3)
}

/** The Public Workshop footer: its one primary checks the recipe's ingredients (a preview holds or spends nothing). */
@Composable private fun CraftFooter(model: VehicleViewModel, idle: Boolean, selectedBase: String?) {
    val flow = model.craftState ?: return
    val craft by flow.collectAsState()
    val ready = idle && !craft.busy && selectedBase != null && craft.selection != null
    PrimaryButton("CHECK INGREDIENTS", { if (ready) model.craftQuote() else Toasts.post("Select an owned kingdom to check available ingredients.") },
        Modifier.fillMaxWidth(), state = when { !idle || craft.busy -> CommandState.BUSY; !ready -> CommandState.DISABLED; else -> CommandState.ENABLED },
        reason = if (selectedBase == null) "Select an owned kingdom to check available ingredients." else null,
        sub = "A preview does not hold or spend anything.")
}

/** The Public Workshop (map/solana-island.png panel): what you can craft, the tier, the ingredient check and the originals. */
@Composable private fun CraftPage(model: VehicleViewModel, idle: Boolean, selectedBase: String?, tiers: List<Long>, onInstall: (() -> Unit)?) {
    val flow = model.craftState
    if (flow == null) {
        EmptyState(EmptyStateUi("ui:solana-navigation", "Public Workshop", "Vehicle crafting history is unavailable.", null, null), onGo = {})
        return
    }
    val craft by flow.collectAsState()
    val busy = !idle || craft.busy
    var family by rememberSaveable { mutableStateOf(VehicleCraftProtocol.families.first()) }
    var tier by rememberSaveable { mutableStateOf<Long?>(null) }
    val selectedTier = tier?.takeIf { it in tiers } ?: tiers.firstOrNull()
    LaunchedEffect(selectedBase, family, selectedTier) {
        model.craftSelection(if (selectedBase != null && selectedTier != null) VehicleCraftSelection(selectedBase, family, selectedTier) else null)
    }
    LaunchedEffect(model) { model.craftForeground() }
    RefreshLine(craft.busy)
    PkwText("Choose a family and target tier to check the selected kingdom's ingredients. A preview does not hold or spend anything.",
        PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = 4)
    VoyageLabel("YOU CAN CRAFT")
    VehicleCraftProtocol.families.chunked(4).forEach { chunk ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            chunk.forEach { value ->
                val known = vehicleFamilyOf(value)
                val on = value == family
                VoyageRow(Modifier.weight(1f), minHeight = 84.dp, rim = if (on) PkwTokens.Colors.gold.face else null,
                    description = vehicleFamilyLabel(value), onClick = { if (!busy) family = value }, selected = on) {
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        if (known != null) VoyageIcon(vehicleIdleArt(known, selectedTier?.toInt()), 48.dp) else VoyageIcon("ui:lodge-menu", 32.dp)
                        PkwText(known?.let(::familyShortName) ?: islandShareResource(value), PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch)
                    }
                }
            }
        }
    }
    if (tiers.isEmpty()) GateRow("Vehicle recipe selection needs the current content catalogue.")
    else {
        VoyageLabel("TIER")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            tiers.forEach { value -> ChoiceChip("T$value", value == selectedTier, { if (!busy) tier = value }, Modifier.weight(1f), description = "Tier $value") }
        }
    }
    if (selectedBase == null) GateRow("Select an owned kingdom to check available ingredients.")
    GateRow("New vehicle crafting is unavailable. Original outcomes can still be checked below.")
    craft.error?.let { PkwText(it, PkwTokens.Type.body, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, color = PkwTokens.Colors.shortText, maxLines = 4) }
    craft.quote?.takeIf { quote -> runCatching {
        quote.charterText("baseId") == selectedBase && quote.charterObject("recipe").charterText("family") == family &&
            CharterGrammar.number(quote.charterObject("recipe").getValue("tier")) == selectedTier
    }.getOrDefault(false) }?.let { quote -> CraftQuote(quote, family, selectedTier) }
    VoyageLabel("ORIGINAL CRAFTING HISTORY")
    PkwText("Saved outcomes keep their original kingdom, materials and selected vehicle. Changing kingdoms cannot move them.",
        PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 3)
    if (!craft.loaded) PkwText("Loading saved originals…", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    else if (craft.records.isEmpty()) PkwText("No original crafting records have been loaded.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    craft.records.sortedByDescending { runCatching { it.charterText("reservedAt") }.getOrDefault("") }.forEach { record -> CraftRecord(model, record, busy) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        SecondaryButton("REFRESH", { model.craftHistory() }, Modifier.weight(1f), enabled = !busy, contentDescription = "Refresh original history")
        craft.nextCursor?.let { cursor -> SecondaryButton("MORE", { model.craftHistory(cursor) }, Modifier.weight(1f), enabled = !busy,
            contentDescription = "More original history") }
    }
    if (onInstall != null) GoRow("ui:lodge-menu", "Install a vehicle", "From your wallet into a finished berth", "GO", onInstall, "Open Install")
}

/** The server's recipe quote: odds, application fee and each ingredient against what this kingdom has. */
@Composable private fun CraftQuote(quote: JsonObject, family: String, tier: Long?) {
    val head = runCatching {
        val recipe = quote.charterObject("recipe")
        listOf(
            VehicleLine("Success chance: " + CharterGrammar.number(recipe.getValue("oddsBps")).toBigDecimal().movePointLeft(2).stripTrailingZeros().toPlainString() + "%", true),
            VehicleLine("Application fee: " + marketSol(quote.charterText("applicationFeeLamports")) + " SOL", true),
            VehicleLine("Oracle, account rent and network costs are not quoted. The application fee is not a complete total."),
            VehicleLine("Ingredients last checked ${islandShareTime(quote.charterText("serverNow"))}."),
            VehicleLine("An ordinary unsuccessful result consumes its original materials. A pending result stays held."),
        )
    }.getOrDefault(emptyList())
    val inputs = runCatching { quote.getValue("ingredients").jsonArray.map { it.jsonObject } }.getOrDefault(emptyList())
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            PkwText("${vehicleFamilyLabel(family).uppercase()} · TIER ${tier ?: "…"}", PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
            head.forEach { PkwText(it.text, if (it.strong) PkwTokens.Type.body else PkwTokens.Type.small,
                color = if (it.strong) PkwTokens.Colors.textOnParch else PkwTokens.Colors.textOnParch2, maxLines = 3) }
        }
    }
    inputs.forEach { input ->
        val row = runCatching {
            val missing = (CharterGrammar.amount(input.getValue("required")) - CharterGrammar.amount(input.getValue("available"))).max(java.math.BigInteger.ZERO)
            Triple(input.charterText("itemId"), "Need ${input.charterText("required")} · have ${input.charterText("available")} · held ${input.charterText("held")}", missing)
        }.getOrNull() ?: return@forEach
        val short = row.third.signum() > 0
        VoyageRow(minHeight = 52.dp, rim = if (short) PkwTokens.Colors.blood else null) {
            VoyageIcon(voyageIcon(row.first), 32.dp, Modifier.padding(start = 6.dp))
            Column(Modifier.weight(1f)) {
                PkwText(islandShareResource(row.first), PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                PkwText(row.second, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2)
            }
            PkwText(if (short) "Missing ${row.third}" else "Enough available", PkwTokens.Type.small, Modifier.padding(end = 6.dp),
                color = if (short) PkwTokens.Colors.shortText else PkwTokens.Colors.green.lo)
        }
    }
}

/** One original crafting record and its GET-only outcome check. */
@Composable private fun CraftRecord(model: VehicleViewModel, record: JsonObject, busy: Boolean) {
    val facts = runCatching {
        val identity = record.charterObject("identity")
        Triple(identity.charterText("family"), CharterGrammar.number(identity.getValue("tier")), listOf(
            vehicleCraftStatus(record.charterText("status")),
            "Original kingdom: ${record.charterText("baseId")}",
            "Reserved: ${islandShareTime(record.charterText("reservedAt"))}",
        ) + record.charterObject("recipe").getValue("inputs").jsonArray.map { v -> val input = v.jsonObject
            "${islandShareResource(input.charterText("itemId"))} · ${input.charterText("quantity")}" } +
            listOfNotNull("Check owned assets in INSTALL to verify current ownership and choose a berth.".takeIf { record.charterText("status") == "minted" }))
    }.getOrNull() ?: return
    val key = runCatching { record.charterText("idempotencyKey") }.getOrNull()
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                VehicleWell(facts.first, facts.second, Modifier.size(64.dp, 56.dp))
                Column(Modifier.weight(1f)) {
                    PkwText("${vehicleFamilyLabel(facts.first)} · tier ${facts.second}", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                    facts.third.forEachIndexed { i, line -> PkwText(line, PkwTokens.Type.small,
                        color = if (i == 0) PkwTokens.Colors.textOnParch else PkwTokens.Colors.textOnParch2, maxLines = 2) }
                }
            }
            if (key != null) SecondaryButton("CHECK ORIGINAL OUTCOME", { model.craftRecover(key) }, Modifier.fillMaxWidth(), enabled = !busy)
        }
    }
}

/** HISTORY: the server activity and the originals saved on this device; opening one shows its card at the top. */
@Composable private fun HistoryPage(model: VehicleViewModel, idle: Boolean, activity: JsonObject?, loaded: Boolean, records: List<VehicleRecord>?, onBack: () -> Unit) {
    BackTitleRow("SAVED OPERATIONS & ACTIVITY", "Open an original to recover its exact asset, destination, approval or expedition receipt.", onBack)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        SecondaryButton("REFRESH", { model.refresh() }, Modifier.weight(1f), enabled = idle, contentDescription = "Check vehicle history")
        SecondaryButton("RECOVER", { model.check() }, Modifier.weight(1f), enabled = idle, contentDescription = "Recover saved originals")
    }
    val items = runCatching { activity?.getValue("items")?.jsonArray?.map { it.jsonObject } }.getOrNull()
    if (activity == null && loaded) PkwText("Activity is unavailable. Saved records remain below.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    if (items?.isEmpty() == true) PkwText("No vehicle activity on this page.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    items?.forEach { item ->
        val label = runCatching { "${islandShareResource(item.charterText("kind"))} · ${item.charterText("status").replace('_', ' ')}" }.getOrDefault("Vehicle activity")
        VoyageRow(minHeight = 52.dp, description = label, onClick = { if (idle) model.history(item) }) {
            VoyageIcon("ui:queue-status", 32.dp, Modifier.padding(start = 6.dp))
            PkwText(label, PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 2)
        }
    }
    val cursor = activity?.get("nextCursor")?.takeUnless { it == JsonNull }?.let { runCatching { CharterGrammar.text(it) }.getOrNull() }
    if (cursor != null) SecondaryButton("MORE HISTORY", { model.refresh(cursor) }, Modifier.fillMaxWidth(), enabled = idle)
    VoyageLabel("SAVED ON THIS DEVICE")
    if (records?.isEmpty() == true) PkwText("No saved vehicle operations on this device.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    records?.forEach { r ->
        val pill = vehicleRecordPill(r)
        VoyageRow(minHeight = 52.dp, description = "${islandShareResource(r.kind)} · ${pill.label.lowercase()}", onClick = { if (idle) model.select(r.id) }) {
            VoyageIcon("ui:queue-status", 32.dp, Modifier.padding(start = 6.dp))
            PkwText(islandShareResource(r.kind), PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch)
            StatusTag(pill.label, pill.tone)
        }
    }
}
