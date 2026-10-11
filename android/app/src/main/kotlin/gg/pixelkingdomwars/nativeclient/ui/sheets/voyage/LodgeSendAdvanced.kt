package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import java.util.Locale

/*
 * Design component: Lodge › SEND, CRAFTED mode (design/final/voyage/send-advanced.png; SPEC "E1.3 Send a crafted
 * vehicle", registry row 67 `Lodge(SEND, mode = "advanced")`). Vehicle-first sending: the STARTER · CRAFTED mode chips
 * ([LodgeModeChips], drawn by [LodgeSheetR2] while `SF(phaseE.advancedDispatch)` and a Berth exist), the 100 dp vehicle
 * card (sea well with the idle, family + blue tier tag, "Solana Island craft", trips meter 120, "4/10 trips left", blue
 * CHANGE 84 × 48), "WHERE IT CAN SAIL · Grade III or lower" with one 58 dp RouteRow per server preview route (route art
 * 44, name + HOME tag, realm · grade; right: resource 24 + "+140" over the duration, or a gold PERMIT tag + "0.01 SOL ·
 * 7d", or "Needs T4" in #A3261A on a dimmed cream.lo row), the fitting row, and the gold "SEND AIRSHIP" ("uses 1 trip ·
 * back at 03:20") + "Can't be called back once it sails." `send.png` stays the route-first view.
 *
 * Pointer rule: drawn inside the Lodge sheet's painted panel; only the chips, CHANGE, the route rows and the footer
 * buttons take touches (each ≥ 48 dp, a scene-input region). No scrim.
 */

/** One route of "WHERE IT CAN SAIL" (SPEC `RouteRowUi(route, yieldIcon, yield, duration, needsPermit, blockedReason)`;
 *  `permitLine` was added). */
@Immutable data class RouteRowUi(
    val route: RouteUi,
    /** The realm resource icon at 24 (`voyage:<resource>`). */
    val yieldIcon: String,
    /** The server preview's net ("140"); null = unknown ("…"). Drawn "+140". */
    val yield: String?,
    /** The server preview's duration ("5h 40m"); null = unknown. */
    val duration: String?,
    /** PAID_REALM without a permit: gold PERMIT tag; SEND opens the permit Seal. */
    val needsPermit: Boolean,
    /** Grade above the vehicle tier: "Needs T4" (dimmed row); null = can sail. */
    val blockedReason: String?,
    /** Added: the permit's price and length under the tag ("0.01 SOL · 7d"); null draws none. */
    val permitLine: String? = null,
)

/** Lodge › SEND (CRAFTED) state (SPEC `AdvancedSendUi(vehicle, routes, selectedRouteId, preview, fitting)`; the
 *  vehicle is nullable for the no-crafted-vehicle state; fields after `fitting` were added). */
@Immutable data class AdvancedSendUi(
    /** The chosen crafted vehicle; null = none installed (the empty state shows). */
    val vehicle: VehicleUi?,
    /** Every route it can see, from the server preview list. */
    val routes: List<RouteRowUi>,
    val selectedRouteId: String?,
    /** The server preview for (vehicle, selected route). */
    val preview: PreviewUi?,
    /** Fitted equipment ("Route Compass fitted · + a survey find on this trip"); null hides the row. */
    val fitting: FittingUi?,
    /** Added: LOADING keeps the last good routes with "…" numbers; ERROR offers CHECK. */
    val previewState: PreviewState = PreviewState.READY,
    /** Added: the card's origin line ("Solana Island craft"). */
    val origin: String = "Solana Island craft",
    /** Added: SEND was tapped and the server has not answered. */
    val busy: Boolean = false,
    /** Added: a departure from a previous session is being checked (never re-sent). */
    val pending: PendingDepartureUi? = null,
    /** Added: the feature is off on this server (LOCKED). */
    val lockedReason: String? = null,
    /** Added: the preview error sentence. */
    val previewError: String? = null,
    /** Added: the permit length in days for "with a 7-day permit" (server). */
    val permitDays: Int? = null,
    /** Added: a Berth exists (the empty state's second door says "Install it at the Berth"). */
    val hasBerth: Boolean = true,
)

/** Lodge › SEND (CRAFTED) callbacks (SPEC: onMode, onChangeVehicle, onRoute, onSend, onPermit; the rest were added). */
@Immutable data class AdvancedSendActions(
    /** STARTER / CRAFTED chip. */
    val onMode: (String) -> Unit = {},
    /** CHANGE → the vehicle picker. */
    val onChangeVehicle: () -> Unit = {},
    /** A route row (selects it; a blocked row explains through [onRefused]). */
    val onRoute: (routeId: String) -> Unit = {},
    /** SEND (the caller creates the idempotency key once). */
    val onSend: () -> Unit = {},
    /** SEND on a permit route → the permit Seal ([PermitSeal]). */
    val onPermit: () -> Unit = {},
    /** Green RESTORE (0 trips left) → Berth › SERVICE. */
    val onRestore: () -> Unit = {},
    /** CHECK on a preview error or a pending departure. */
    val onCheck: () -> Unit = {},
    /** Empty state: "Craft a vehicle on Solana Island". */
    val onCraftLink: () -> Unit = {},
    /** Empty state: "Install it at the Berth". */
    val onBerthLink: () -> Unit = {},
    /** Any refused tap: toast the reason. */
    val onRefused: (String?) -> Unit = {},
)

/** The two mode ids of SEND. */
object LodgeSendMode {
    const val STARTER = "STARTER"
    const val CRAFTED = "CRAFTED"
}

/** STARTER (lodge-menu) · CRAFTED (navigation-kit) chips, 44 dp faces in 48 dp targets; wood off, cream on. */
@Composable fun LodgeModeChips(mode: String, onMode: (String) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ModeChip("ui:lodge-menu", "STARTER", mode == LodgeSendMode.STARTER) { onMode(LodgeSendMode.STARTER) }
        ModeChip("ui:navigation-kit", "CRAFTED", mode == LodgeSendMode.CRAFTED) { onMode(LodgeSendMode.CRAFTED) }
    }
}

@Composable private fun ModeChip(icon: String, label: String, on: Boolean, onClick: () -> Unit) {
    Plate(if (on) PlateKind.CREAM else PlateKind.WOOD, Modifier.defaultMinSize(minHeight = PkwTokens.Dims.minTap)
        .clearAndSetSemantics { contentDescription = "$label vehicles"; role = Role.Tab; selected = on; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(role = Role.Tab, onClick = onClick), contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp)) {
        Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            VoyageIcon(icon, 32.dp)
            if (on) PkwText(label, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
            else PkwText(label, PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
        }
    }
}

/** The CRAFTED body: the vehicle card, WHERE IT CAN SAIL and the fitting row (or the empty state). */
@Composable fun ColumnScope.AdvancedSendBody(ui: AdvancedSendUi, on: AdvancedSendActions) {
    val c = PkwTokens.Colors
    val v = ui.vehicle
    if (v == null) {
        GoRow("ui:solana-navigation", "Craft a vehicle on Solana Island", "The Public Workshop builds them", "GO", on.onCraftLink,
            "Go to the Solana Island Public Workshop")
        if (ui.hasBerth) GoRow("ui:lodge-menu", "Install it at the Berth", "Then it can sail from here", "BERTH", on.onBerthLink, "Open the Berth")
        return
    }
    ui.pending?.let { pending ->
        VoyageRow(rim = c.gold.face) {
            PkwText(pending.line, PkwTokens.Type.body, Modifier.weight(1f).padding(start = 6.dp), color = c.textOnParch, maxLines = 2)
            if (pending.checking) BusyDots(Modifier.padding(end = 12.dp))
            else SecondaryButton("CHECK", on.onCheck, Modifier.padding(end = 2.dp), contentDescription = "Check the departure")
        }
    }
    RefreshLine(ui.previewState == PreviewState.LOADING)
    VehicleCardV2(v, ui.origin, on.onChangeVehicle)
    VoyageLabel("WHERE IT CAN SAIL", vehicleGradeLine(v))
    val loading = ui.previewState == PreviewState.LOADING
    // send-advanced.html `.rrw`: 58 dp route rows 4 apart.
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ui.routes.forEach { row -> AdvancedRouteRow(row, routeRowState(row, ui.selectedRouteId), loading, on) }
    }
    ui.fitting?.let { fit ->
        VoyageRow {
            VoyageIcon(fit.icon, 32.dp, Modifier.padding(start = 4.dp))
            Column(Modifier.weight(1f)) {
                PkwText(fit.fitted, PkwTokens.Type.body, color = c.textOnParch)
                PkwText("${fit.line} on this trip", PkwTokens.Type.small, color = c.textOnParch2)
            }
        }
    }
}

/** The CRAFTED footer: gold SEND (or off + green RESTORE at 0 trips) and "Can't be called back once it sails." */
@Composable fun ColumnScope.AdvancedSendFooter(ui: AdvancedSendUi, on: AdvancedSendActions) {
    val adv = advancedSendLook(ui) ?: return
    val look = adv.look
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PrimaryButton(look.label, {
            when (adv.action) {
                AdvancedAction.SEND -> on.onSend()
                AdvancedAction.PERMIT -> on.onPermit()
                AdvancedAction.CHECK -> on.onCheck()
                AdvancedAction.EXPLAIN -> on.onRefused(look.reason)
                AdvancedAction.NONE -> Unit
            }
        }, Modifier.weight(1f), verb = look.verb, sub = look.sub, state = look.state, reason = look.reason)
        if (adv.restore) SecondaryButton("RESTORE", on.onRestore, Modifier.width(120.dp), verb = Verb.GREEN, contentDescription = "Restore trips at the Berth")
    }
    PkwText("Can't be called back once it sails.", PkwTokens.Type.small, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch2,
        textAlign = TextAlign.Center)
}

/** The 100 dp vehicle card (send-advanced.html): sea well 76 × 72 with the idle, PS 12 family + blue tier, origin, trips
 *  meter 120, the trips line on its own row, AWAY + return time when away, and the blue CHANGE 84 × 48. */
@Composable private fun VehicleCardV2(v: VehicleUi, origin: String, onChange: () -> Unit) {
    val c = PkwTokens.Colors
    // The card's inner padding is 8 / 8 / 6 inside its 2 dp ink rim.
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 100.dp), contentPadding = PaddingValues(start = 10.dp, top = 10.dp, end = 10.dp, bottom = 8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SeaWell(Modifier.size(76.dp, 72.dp), waves = v.family.ordinal) { VehicleSprite(v.family, v.tier, 2, Modifier.fillMaxSize()) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PkwText(familyShortName(v.family).uppercase(Locale.US), PkwTokens.Type.label, color = c.textOnParch)
                    Tag(tierTag(v.tier), Verb.BLUE)
                    if (v.status == VehicleStatus.AWAY) Tag("AWAY", Verb.BLUE)
                }
                PkwText(if (v.status == VehicleStatus.AWAY) "Back in ${v.returnsAt ?: UNKNOWN}" else origin, PkwTokens.Type.small, color = c.textOnParch2)
                TripsMeter(v.tripsLeft, v.tripsMax, Modifier.width(120.dp))
                PkwText("${v.tripsLeft ?: UNKNOWN}/${v.tripsMax ?: UNKNOWN} trips left", PkwTokens.Type.small,
                    color = if (isWornOut(v)) c.shortText else c.textOnParch2)
            }
            SecondaryButton("CHANGE", onChange, Modifier.size(LODGE_CHANGE_W, LODGE_CHANGE_H), verb = Verb.BLUE, contentDescription = "Change the vehicle")
        }
    }
}

/** One 58 dp route row (see [RouteRowState]); blocked rows use cream.lo and explain on tap. */
@Composable private fun AdvancedRouteRow(row: RouteRowUi, state: RouteRowState, loading: Boolean, on: AdvancedSendActions) {
    val c = PkwTokens.Colors
    val r = row.route
    val blocked = state == RouteRowState.BLOCKED
    val right = when {
        blocked -> row.blockedReason.orEmpty()
        row.needsPermit -> "permit ${row.permitLine.orEmpty()}"
        else -> "${yieldText(if (loading) null else row.yield)}, ${row.duration ?: UNKNOWN}"
    }
    VoyageRow(minHeight = 58.dp,
        rim = if (state == RouteRowState.SELECTED) c.gold.face else null,
        tint = when { blocked -> c.creamLo; state == RouteRowState.SELECTED -> c.selectedTint; else -> null },
        description = "${r.displayName}, ${r.realmName}, Grade ${gradeNumeral(r.grade)}, $right",
        selected = state == RouteRowState.SELECTED,
        onClick = { if (blocked) on.onRefused(row.blockedReason) else on.onRoute(r.routeId) }) {
        // send-advanced.html: a 48 dp well holding the route card at 44.
        SeaWell(Modifier.padding(start = 2.dp).size(48.dp)) {
            LocalVoyageArt.current.routeCard(r, Modifier.size(44.dp).lockedArt(blocked))
        }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText(r.displayName, PkwTokens.Type.body, Modifier.weight(1f, fill = false), color = c.textOnParch)
                if (r.access == Access.HOME) Tag("HOME", Verb.GREEN)
            }
            PkwText("${r.realmName} · Grade ${gradeNumeral(r.grade)}", PkwTokens.Type.small, color = c.textOnParch2)
        }
        Column(Modifier.padding(end = 6.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            when {
                blocked -> PkwText(row.blockedReason.orEmpty(), PkwTokens.Type.small, color = c.shortText)
                row.needsPermit -> {
                    Tag("PERMIT", Verb.GOLD)
                    row.permitLine?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2) }
                }
                else -> {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        VoyageIcon(row.yieldIcon, 24.dp)
                        PkwText(yieldText(if (loading) null else row.yield), PkwTokens.Type.caption, color = c.textOnParch)
                    }
                    PkwText(if (loading) UNKNOWN else row.duration ?: UNKNOWN, PkwTokens.Type.small, color = c.textOnParch2)
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------- previews

private fun advancedLodge(a: AdvancedSendUi) = VoyageR2Samples.lodgeAdvanced.copy(advanced = a)

@Preview(name = "Lodge › SEND, CRAFTED (send-advanced.png)", widthDp = 412, heightDp = 915)
@Composable private fun AdvancedPreview() = LodgeR2PreviewHost(VoyageR2Samples.lodgeAdvanced)

@Preview(name = "Lodge › SEND, CRAFTED, permit route selected", widthDp = 412, heightDp = 915)
@Composable private fun AdvancedPermitPreview() = LodgeR2PreviewHost(advancedLodge(VoyageR2Samples.advanced.copy(
    selectedRouteId = VoyageR2Samples.advanced.routes[3].route.routeId)))

@Preview(name = "Lodge › SEND, CRAFTED, no crafted vehicle", widthDp = 412, heightDp = 915)
@Composable private fun AdvancedEmptyPreview() = LodgeR2PreviewHost(advancedLodge(VoyageR2Samples.advanced.copy(vehicle = null, routes = emptyList())))

@Preview(name = "Lodge › SEND, CRAFTED, vehicle away", widthDp = 412, heightDp = 915)
@Composable private fun AdvancedAwayPreview() = LodgeR2PreviewHost(advancedLodge(VoyageR2Samples.advanced.copy(
    vehicle = VoyageR2Samples.advanced.vehicle?.copy(status = VehicleStatus.AWAY, returnsAt = "1h 12m"))))

@Preview(name = "Lodge › SEND, CRAFTED, 0 trips left (RESTORE)", widthDp = 412, heightDp = 915)
@Composable private fun AdvancedWornPreview() = LodgeR2PreviewHost(advancedLodge(VoyageR2Samples.advanced.copy(
    vehicle = VoyageR2Samples.advanced.vehicle?.copy(tripsLeft = 0, status = VehicleStatus.WORN_OUT))))

@Preview(name = "Lodge › SEND, CRAFTED, loading (…)", widthDp = 412, heightDp = 915)
@Composable private fun AdvancedLoadingPreview() = LodgeR2PreviewHost(advancedLodge(VoyageR2Samples.advanced.copy(previewState = PreviewState.LOADING)))

@Preview(name = "Lodge › SEND, CRAFTED, preview error (CHECK)", widthDp = 412, heightDp = 915)
@Composable private fun AdvancedErrorPreview() = LodgeR2PreviewHost(advancedLodge(VoyageR2Samples.advanced.copy(previewState = PreviewState.ERROR, preview = null)))

@Preview(name = "Lodge › SEND, CRAFTED, sending (busy)", widthDp = 412, heightDp = 915)
@Composable private fun AdvancedBusyPreview() = LodgeR2PreviewHost(advancedLodge(VoyageR2Samples.advanced.copy(busy = true)))

@Preview(name = "Lodge › SEND, CRAFTED, saved departure (CHECK, never re-sent)", widthDp = 412, heightDp = 915)
@Composable private fun AdvancedPendingPreview() = LodgeR2PreviewHost(advancedLodge(VoyageR2Samples.advanced.copy(
    pending = PendingDepartureUi("Your Airship's departure is being checked"))))
