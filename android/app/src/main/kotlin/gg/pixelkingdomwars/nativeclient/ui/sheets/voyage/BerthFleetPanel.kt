package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Berth › FLEET (design/final/voyage/berth-fleet.png, SPEC §7): one row per vehicle family (fixed
 * order, starter first) showing what is in each berth and in what condition, the craft link for an empty family, and the
 * contextual pinned primary (INSTALL <FAMILY> / SEND FROM LODGE / SERVICE / none while away). Rows and quay slots select
 * each other (the quay lives in [BerthSheet]'s header).
 *
 * States: loading (rows show the last snapshot; unknown counts "…"), wallet not linked (INSTALL LOCKED "Link a wallet in
 * Profile"), feature off (INSTALL LOCKED), install in flight (the row shows dots "Installing · checking wallet", the
 * primary is stone CHECK, never a second INSTALL), error (the caller's toast + Report).
 *
 * Pointer rule: only the rows, the craft GO and the primary take touches.
 */

/** Everything FLEET draws (SPEC §7 Data `BerthFleetUi`; added fields after `ordersAllowed`). */
@Immutable data class BerthFleetUi(
    /** The Berth level tag ("LV 5"); also on the sheet title. */
    val level: String,
    /** Exactly one per family, starter first (EMPTY when the berth has no vehicle). */
    val berths: List<VehicleUi>,
    /** The selected family (row gold rim + quay dashed frame). */
    val selectedFamily: VehicleFamily?,
    /** Crafted vehicles in the wallet per family (the craft link shows when the selected empty family has none); null = unknown. */
    val walletAssetsByFamily: Map<VehicleFamily, Int>?,
    /** False on a read-only base. */
    val ordersAllowed: Boolean,
    /** Added: a wallet is linked (INSTALL needs one). */
    val walletLinked: Boolean = true,
    /** Added: vehicles are off on this server ("Vehicles are not open on this server yet"). */
    val featureOffReason: String? = null,
    /** Added: a family whose install is in flight (pending reservation). */
    val pendingInstallFamily: VehicleFamily? = null,
    /** Added (owner 2026-10-06, free placement): the vacant Berth an INSTALL goes into; null when there is none. */
    val installBerthId: String? = null,
    /** Added: no vacant Berth, and a new one can be placed: INSTALL starts the building placement for it. */
    val placeBerth: Boolean = false,
    /** Added: neither, and why ("Your new Berth is still being built", "Berth limit reached · max 5"). */
    val installBlockedReason: String? = null,
)

/** INSTALL's sub-line while the tap places a new Berth on the base (owner 2026-10-06, free placement). */
const val PLACE_BERTH_SUB: String = "place its Berth where you want"

/**
 * Owner 2026-10-06, free placement: INSTALL on an empty crafted family with no vacant Berth places a new Berth (its sub-line
 * says so); with nowhere to go it is DISABLED with the reason, and the tap still explains. A wallet known to hold none of
 * the family keeps the picker look (its craft link leads on). Every other look is unchanged.
 */
fun berthInstallLook(look: PrimaryLook, ui: BerthFleetUi, family: VehicleFamily): PrimaryLook = when {
    look.state != CommandState.ENABLED || family == VehicleFamily.STARTER || ui.walletAssetsByFamily?.get(family) == 0 -> look
    ui.installBlockedReason != null -> look.copy(sub = null, state = CommandState.DISABLED, reason = ui.installBlockedReason)
    ui.placeBerth -> look.copy(sub = PLACE_BERTH_SUB)
    else -> look
}

/** FLEET's callbacks (SPEC §7 Callbacks; tab / History / close live on [BerthSheetActions]). */
@Immutable data class BerthFleetActions(
    val onSelect: (VehicleFamily) -> Unit = {},
    /** INSTALL <FAMILY>: opens the wallet picker (and LOCKED / DISABLED taps, so the caller can say why). */
    val onInstall: (VehicleFamily) -> Unit = {},
    /** The craft link → World › Solana Island › Public Workshop spot. */
    val onCraftLink: () -> Unit = {},
    /** SEND FROM LODGE: the camera flies to the Lodge, SEND with this vehicle. */
    val onSendFromLodge: (installationId: String) -> Unit = {},
    /** SERVICE on a worn-out vehicle → the SERVICE tab with it selected. */
    val onService: (installationId: String) -> Unit = {},
    /** CHECK on an install in flight (the by-key recovery read). */
    val onCheckInstall: (VehicleFamily) -> Unit = {},
)

/** The FLEET body. */
@Composable fun ColumnScope.BerthFleetBody(ui: BerthFleetUi, on: BerthFleetActions) {
    // berth-fleet.html: the label sits 6 dp above the first row; rows are 72 tall with a 5 dp gap (the sheet's 8 dp rhythm
    // resumes before the craft link).
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        // Owner 2026-10-06: no pre-chosen spots. Each vehicle docks in its own Berth, placed on the base like any building.
        VoyageLabel("YOUR FLEET", "each docks in its own Berth", Modifier.padding(bottom = 1.dp))
        ui.berths.forEach { v -> BerthRow(v, v.family == ui.selectedFamily, v.family == ui.pendingInstallFamily) { on.onSelect(v.family) } }
    }
    val selected = ui.berths.firstOrNull { it.family == ui.selectedFamily }
    val owned = selected?.let { ui.walletAssetsByFamily?.get(it.family) }
    if (selected != null && selected.status == VehicleStatus.EMPTY && selected.family != VehicleFamily.STARTER && (owned == null || owned == 0)) {
        val name = familyShortName(selected.family).lowercase()
        GoRow("ui:solana-navigation", "No $name to install?", "Craft one at Solana Island", "GO", on.onCraftLink, "Go to Solana Island to craft a $name")
    }
}

/** FLEET's pinned primary (SPEC §7 item 7). */
@Composable fun ColumnScope.BerthFleetFooter(ui: BerthFleetUi, on: BerthFleetActions) {
    val selected = ui.berths.firstOrNull { it.family == ui.selectedFamily }
    val primary = fleetPrimary(selected, selected != null && selected.family == ui.pendingInstallFamily, ui.featureOffReason, ui.walletLinked, ui.ordersAllowed)
    val look = primary.look?.let { base ->
        if (primary.action == FleetAction.INSTALL && selected != null && selected.status == VehicleStatus.EMPTY)
            berthInstallLook(base, ui, selected.family) else base
    }
    if (look == null) {
        val line = when (selected?.status) {
            VehicleStatus.AWAY -> "Back in ${selected?.returnsAt ?: UNKNOWN}"
            VehicleStatus.BUSY_SERVICE -> "Service is being checked"
            null -> "Tap a berth"
            else -> ""
        }
        if (line.isNotEmpty()) PkwText(line, PkwTokens.Type.body, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center)
        return
    }
    val sel = selected ?: return
    val family = sel.family
    val id = sel.installationId
    PrimaryButton(look.label, {
        when (primary.action) {
            FleetAction.INSTALL -> on.onInstall(family)
            FleetAction.SEND_FROM_LODGE -> id?.let(on.onSendFromLodge)
            FleetAction.SERVICE -> id?.let(on.onService)
            FleetAction.CHECK -> on.onCheckInstall(family)
            FleetAction.NONE -> Unit
        }
    }, Modifier.fillMaxWidth(), verb = look.verb, sub = look.sub, state = look.state, reason = look.reason)
}

/**
 * One berth row (CreamCard 72): the sea well with the idle sprite (balloon k 1 so it fits; starter k 3) and a blue Tn tag,
 * the PS family name, the VT state line, a 10 dp trips meter (gold at ≤ 2), and the DOCKED / AWAY / EMPTY / SERVICE tag.
 * Selected: gold 3 dp rim on #FFF3C8.
 */
@Composable fun BerthRow(v: VehicleUi, selected: Boolean, installing: Boolean, onClick: () -> Unit) {
    val c = PkwTokens.Colors
    val (tag, tagVerb) = berthRowTag(v)
    val line = if (installing) "Installing · checking wallet" else berthRowLine(v)
    VoyageRow(minHeight = 72.dp, rim = if (selected) c.gold.face else null, tint = if (selected) c.selectedTint else null,
        description = "${familyName(v.family)}. $line. $tag", onClick = onClick, selected = selected) {
        Box(Modifier.padding(start = 4.dp).size(64.dp, 60.dp)) {
            SeaWell(Modifier.fillMaxSize(), grey = v.status == VehicleStatus.EMPTY) {
                VehicleSprite(v.family, v.tier, wellScale(v.family, tallWell = false), Modifier.fillMaxSize(),
                    dim = if (v.status == VehicleStatus.EMPTY) EMPTY_ROW_DIM else null)
            }
            if (v.tier != null && v.family != VehicleFamily.STARTER && v.status != VehicleStatus.EMPTY) Tag(tierTag(v.tier), Verb.BLUE, Modifier.align(Alignment.BottomStart))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            PkwText(familyName(v.family).uppercase(), PkwTokens.Type.label, color = c.textOnParch)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (installing) BusyDots()
                PkwText(line, PkwTokens.Type.small, color = c.textOnParch2)
            }
            // berth-fleet.html: the meter sits 3 dp under the line (2 dp column gap + 1).
            if (v.family != VehicleFamily.STARTER && v.status != VehicleStatus.EMPTY)
                TripsMeter(v.tripsLeft, v.tripsMax, Modifier.padding(top = 1.dp).width(150.dp))
        }
        Tag(tag, tagVerb, Modifier.padding(end = 6.dp))
    }
}

/** An empty berth row's idle (berth-fleet.html: `grayscale(1) brightness(.5)`; the quay slots keep [EMPTY_SLOT_DIM]). */
private val EMPTY_ROW_DIM: FloatArray = dimMatrix(1f, 0.5f)

/**
 * A first-load berth row (SPEC §0.5 "skeleton cards (cream with a parch-2 band)", §7 loading "tags …"): the CreamCard 72
 * of [BerthRow] with an empty sea well, a parch-2 band where the name goes and a stone "…" tag. No family, sprite, count or
 * EMPTY claim is drawn, because nothing is known yet. Paint only.
 */
@Composable fun BerthSkeletonRow() {
    VoyageRow(Modifier.clearAndSetSemantics { contentDescription = "Loading" }, minHeight = 72.dp) {
        SeaWell(Modifier.padding(start = 4.dp).size(64.dp, 60.dp))
        Box(Modifier.weight(1f)) { Box(Modifier.fillMaxWidth(0.7f).height(12.dp).background(PkwTokens.Colors.creamLo)) }
        Tag(UNKNOWN, Verb.STONE, Modifier.padding(end = 6.dp))
    }
}
