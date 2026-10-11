package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PixelShapes
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Berth › SERVICE (design/final/voyage/berth-service.png, SPEC §9): keep a worn vehicle sailing (RESTORE
 * trips) or move it up a tier (UPGRADE). Both use up one matching vehicle from the wallet (server `restore_uses` /
 * `upgrade`: "burn one owned asset matching this vehicle's current family and tier"; the UI says "used up"). Vehicle chips,
 * the hero card with the trips meter, two service option cards, the hand-in row, and the pinned RESTORE TRIPS / UPGRADE TO
 * Tn with the network fee; the tap raises [VoyageSeal].
 *
 * States: nothing to service (empty state + blue FLEET), hand-in missing (primary off "You need a Cargo Cutter T2 in your
 * wallet" + the GO row), busy (the money sequence on the primary), success (moss SENT; the host animates the meter or the
 * tier swap and toasts), errors (design correction 7: only an authoritative refusal says "Nothing was sent"; an uncertain
 * result says it is being checked and keeps CHECK).
 *
 * Pointer rule: only the chips, option cards, the hand-in GO and the primary take touches.
 */

/** One service option (SPEC §9 `ServiceOptionUi`). */
@Immutable data class ServiceOptionUi(
    val op: ServiceOp,
    /** False draws the card LOCKED with [reason] ("Max tier"). */
    val available: Boolean,
    val reason: String?,
    /** UPGRADE: the tier it becomes. */
    val resultTier: Int?,
    /** RESTORE: the trips it restores to (server `completedUsesPerInstall`). */
    val resultTrips: Int?,
)

/** Everything SERVICE draws (SPEC §9 Data `BerthServiceUi`; added fields after `sealState`). */
@Immutable data class BerthServiceUi(
    /** Installed advanced vehicles (the starter is never serviced). */
    val installed: List<VehicleUi>,
    val selectedInstallationId: String?,
    /** RESTORE then UPGRADE for the selected vehicle. */
    val options: List<ServiceOptionUi>,
    val selectedOp: ServiceOp?,
    /** The wallet vehicle that would be handed in (same family and tier); null = none found. */
    val handIn: OwnedVehicleUi?,
    /** How many matching vehicles the wallet holds; null = unknown. */
    val walletCount: Int?,
    /** SPEC `feeLamportsEstimate`, formatted in SOL ("0.00002"); null = not reviewed yet ("…"). */
    val feeSol: String?,
    /** Where the service request stands. */
    val sealState: VoyageSealState,
    /** Added: the failed or uncertain step, when [sealState] is ERROR. */
    val error: VoyageMoneyErrorUi? = null,
)

/** SERVICE callbacks (SPEC §9 Callbacks). */
@Immutable data class BerthServiceActions(
    val onPickVehicle: (installationId: String) -> Unit = {},
    /** An away chip → toast "Service when it is docked · back 1h 12m". */
    val onAwayVehicle: (installationId: String) -> Unit = {},
    val onPickOp: (ServiceOp) -> Unit = {},
    /** GO on a missing hand-in → Solana Island Public Workshop. */
    val onHandInGo: () -> Unit = {},
    /** The primary: raise the service Seal (and refused taps, so the caller can say why). */
    val onServiceConfirm: () -> Unit = {},
    /** CHECK after an uncertain result (the by-key read). */
    val onRecover: () -> Unit = {},
    /** The empty state's FLEET. */
    val onGoFleet: () -> Unit = {},
)

/** The SERVICE body. */
@Composable fun ColumnScope.BerthServiceBody(ui: BerthServiceUi, on: BerthServiceActions) {
    val c = PkwTokens.Colors
    if (ui.installed.isEmpty()) {
        EmptyState(EmptyStateUi("ui:exhausted-status", "Nothing to service yet", "Install a crafted vehicle first; its trips run down as it sails.",
            "FLEET", FeatureId("berth.fleet")), onGo = { on.onGoFleet() })
        return
    }
    val v = ui.installed.firstOrNull { it.installationId == ui.selectedInstallationId } ?: ui.installed.first()
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        PkwText("VEHICLE", PkwTokens.Type.caption, color = c.textOnParch2)
        ui.installed.forEach { x ->
            val id = x.installationId.orEmpty()
            val away = x.status == VehicleStatus.AWAY
            ChoiceChip("${familyShortName(x.family).uppercase()} ${tierTag(x.tier)}", x.installationId == v.installationId,
                { if (away) on.onAwayVehicle(id) else on.onPickVehicle(id) }, dimmed = away,
                description = "${vehicleTitle(x)}${if (away) ", at sea, back in ${x.returnsAt ?: UNKNOWN}" else ""}")
        }
    }
    // The hero card: the vehicle, its trips meter (gold ≤ 2, danger count) and a one-line verdict.
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 92.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SeaWell(Modifier.size(96.dp, 80.dp), waves = v.family.ordinal) { VehicleSprite(v.family, v.tier, 2, Modifier.fillMaxSize()) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                PkwText(vehicleTitle(v).uppercase(), PkwTokens.Type.label, color = c.textOnParch)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ProgressBar(tripsFraction(v.tripsLeft, v.tripsMax), tripsLeftLong(v.tripsLeft, v.tripsMax), Modifier.weight(1f),
                        verb = tripsMeterVerb(v.tripsLeft), height = 14.dp)
                    PkwText("${v.tripsLeft ?: UNKNOWN}/${v.tripsMax ?: UNKNOWN}", PkwTokens.Type.caption,
                        color = if (v.tripsLeft != null && v.tripsLeft <= 2) c.danger else c.textOnParch)
                }
                PkwText(serviceVerdict(v), PkwTokens.Type.small, color = c.textOnParch2)
            }
        }
    }
    VoyageLabel("CHOOSE A SERVICE")
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ui.options.forEach { opt -> ServiceOptionCard(v, opt, opt.op == ui.selectedOp, { on.onPickOp(opt.op) }, Modifier.weight(1f)) }
    }
    VoyageLabel("YOU HAND IN")
    val handInName = vehicleTitle(v)
    VoyageRow(rim = if (ui.handIn == null) c.blood else null) {
        SeaWell(Modifier.padding(start = 4.dp).size(40.dp)) { VehicleSprite(v.family, v.tier, 1, Modifier.fillMaxSize()) }
        Column(Modifier.weight(1f)) {
            PkwText(handInName, PkwTokens.Type.body, color = c.textOnParch)
            PkwText("in your wallet: ${ui.walletCount ?: UNKNOWN}", PkwTokens.Type.small, color = if (ui.handIn == null) c.danger else c.textOnParch2)
        }
        if (ui.handIn != null) Tag("OK", Verb.GREEN, Modifier.padding(end = 6.dp))
        else GoButton(on.onHandInGo, "Craft a $handInName at Solana Island", Modifier.padding(end = 2.dp))
    }
    PkwText("The one you hand in is used up. This ${familyShortName(v.family)} keeps its berth.", PkwTokens.Type.small,
        color = c.textOnParch2, maxLines = 2)
}

/** "1 trip left · service it soon" / "7 of 10 trips left" / "No trips left · service it". */
private fun serviceVerdict(v: VehicleUi): String {
    val left = v.tripsLeft ?: return tripsLeftLong(null, v.tripsMax)
    return when {
        left == 0 -> "No trips left · service it"
        left <= 2 -> "$left trip${if (left == 1) "" else "s"} left · service it soon"
        else -> tripsLeftLong(left, v.tripsMax)
    }
}

/** One option card (flex × 150): RESTORE (fastener-set 64, "Trips 1 → 10") or UPGRADE (Tn → Tn+1 wells, "Grade III islands"). */
@Composable private fun ServiceOptionCard(v: VehicleUi, opt: ServiceOptionUi, selected: Boolean, onTap: () -> Unit, modifier: Modifier) {
    val c = PkwTokens.Colors
    val restore = opt.op == ServiceOp.RESTORE_USES
    val title = if (restore) "RESTORE" else "UPGRADE ${tierTag(opt.resultTier)}"
    val line = when {
        !opt.available -> opt.reason ?: "Not available"
        restore -> "Trips ${v.tripsLeft ?: UNKNOWN} → ${opt.resultTrips ?: UNKNOWN}"
        else -> "Grade ${gradeNumeral(opt.resultTier)} islands"
    }
    Box(modifier) {
        Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 150.dp)
            .then(if (selected) Modifier.border(3.dp, c.gold.face, PixelShapes.M) else Modifier)
            .clearAndSetSemantics { contentDescription = "$title. $line"; role = Role.Button; this.selected = selected
                onClick(label = null, action = { onTap(); true }) }
            .clickable(role = Role.Button, onClick = onTap), tint = if (selected) c.selectedTint else null) {
            Column(Modifier.fillMaxWidth().alpha(if (opt.available) 1f else 0.6f), horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (restore) VoyageIcon("voyage:fastener-set", 64.dp)
                else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    SeaWell(Modifier.size(56.dp, 64.dp)) { VehicleSprite(v.family, v.tier, 2, Modifier.fillMaxSize()) }
                    PkwIcon("shape:go", 16.dp, tint = c.textOnParch)
                    SeaWell(Modifier.size(56.dp, 64.dp)) { VehicleSprite(v.family, opt.resultTier ?: v.tier, 2, Modifier.fillMaxSize()) }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (!opt.available) PkwIcon("shape:lock", 16.dp, tint = c.gold.lo)
                    PkwText(title, PkwTokens.Type.label, color = c.textOnParch)
                }
                PkwText(line, PkwTokens.Type.small, color = if (opt.available) c.textOnParch2 else c.danger, textAlign = TextAlign.Center, maxLines = 2)
            }
        }
        if (selected) CheckBadge(Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp))
    }
}

/** The pinned RESTORE TRIPS / UPGRADE TO Tn, the money sequence while it runs, or CHECK after an uncertain result. */
@Composable fun ColumnScope.BerthServiceFooter(ui: BerthServiceUi, on: BerthServiceActions) {
    val c = PkwTokens.Colors
    val v = ui.installed.firstOrNull { it.installationId == ui.selectedInstallationId } ?: ui.installed.firstOrNull() ?: return
    val opt = ui.options.firstOrNull { it.op == ui.selectedOp }
    val look = servicePrimary(ui.selectedOp, opt?.available ?: false, opt?.reason, opt?.resultTier, ui.handIn != null, vehicleTitle(v), ui.feeSol,
        v.status == VehicleStatus.AWAY, v.returnsAt?.let { "Service when it is docked · back $it" }) ?: return
    val error = ui.error
    when (ui.sealState) {
        VoyageSealState.CHECK_WALLET, VoyageSealState.SENDING, VoyageSealState.SENT ->
            MoneyButton(moneyStage(ui.sealState), look.label, {}, Modifier.fillMaxWidth())
        VoyageSealState.ERROR -> {
            // No error detail = not known to be an authoritative refusal: CHECK (by-key read), never a fresh request.
            if (error == null || error.recoverable) SecondaryButton("CHECK", on.onRecover, Modifier.fillMaxWidth(), contentDescription = "Check the service request")
            else MoneyButton(moneyStage(ui.sealState), look.label, on.onServiceConfirm, Modifier.fillMaxWidth())
            if (error != null) PkwText(moneyErrorLine(error), PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.danger, textAlign = TextAlign.Center, maxLines = 2)
        }
        VoyageSealState.IDLE, VoyageSealState.ARMED ->
            PrimaryButton(look.label, on.onServiceConfirm, Modifier.fillMaxWidth(), verb = look.verb, sub = look.sub, state = look.state, reason = look.reason)
    }
}
