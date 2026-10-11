package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.PixelShapes
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.countUpText
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Lodge › SEND (design/final/voyage/send.png, SPEC §3 and §3a): the destination row (or the starter's
 * COAST / LONG / INTRO segments), the vehicle strip, the reward preview, the supplies and the pinned SEND. It renders
 * inside the Lodge sheet's parchment body ([LodgeSendBody]) and pinned footer ([LodgeSendFooter]); [LodgeSheet] mounts it.
 *
 * States (SPEC §3): preview loading ("…" numbers, SEND "Checking route"), preview error (RETRY), supplies short (SEND off
 * with "Need 4 more …", GO on the row, never auto-buy), feature off (LOCKED), busy ("Sending": tabs stay usable, closing
 * keeps the server-idempotent request), pending recovery (a departure from a previous session is CHECKed, never re-sent).
 * Success motion (sheet down, camera to the Berth, departure FX, toast) belongs to the host, after the server accepts.
 *
 * Pointer rule: only the painted rows, cards and buttons take touches; the panel's empty parchment is not a target.
 */

/** Everything SEND draws (SPEC §3 Data `LodgeSendUi`; added fields after `pending`). */
@Immutable data class LodgeSendUi(
    /** The 32 islands (for the destination row; the picker has its own list). */
    val routes: List<RouteUi>,
    /** The chosen island; null before the first choice (the sheet then opens on the picker). */
    val selectedRouteId: String?,
    /** Every installed vehicle (EMPTY berths are not shown here). */
    val vehicles: List<VehicleUi>,
    /** The chosen vehicle; the mapper defaults it with [defaultVehicle]. */
    val selectedInstallationId: String?,
    /** The server preview for (vehicle, route); null while loading or on error. */
    val preview: PreviewUi?,
    /** LOADING keeps the last good view with "…" numbers; ERROR shows RETRY. */
    val previewState: PreviewState,
    /** Starter route choices when the starter is chosen (SPEC §3a); null otherwise. */
    val starterRoutes: List<StarterRouteUi>?,
    /** False on a read-only base: SEND is off with [ordersReason]. */
    val ordersAllowed: Boolean,
    /** A departure in flight from a previous session: CHECK, never a fresh SEND. */
    val pending: PendingDepartureUi?,
    /** Added: the chosen starter route id (starter mode). */
    val selectedStarterRouteId: String? = null,
    /** Added: SEND was tapped and the server has not answered ("Sending"). */
    val busy: Boolean = false,
    /** Added: server feature off ("Expeditions are not open on this server yet"): SEND is LOCKED. */
    val lockedReason: String? = null,
    /** Added: why orders are off ("This base is read-only"). */
    val ordersReason: String? = null,
    /** Added: the preview error sentence. */
    val previewError: String? = null,
)

/** SEND's callbacks (SPEC §3 Callbacks; the tab / History / close ones live on [LodgeSheetActions]). */
@Immutable data class LodgeSendActions(
    /** CHANGE: open CHOOSE AN ISLAND (the panel cross-fades, no new page). */
    val onChangeIsland: () -> Unit = {},
    /** A selectable card, or the starter card on an island route (which switches the destination to starter routes). */
    val onPickVehicle: (installationId: String) -> Unit = {},
    /** A card that cannot sail now (AWAY → "Back in 1h 12m"; too low → "Upgrade at the Berth ▸"; worn out → SERVICE GO). */
    val onVehicleBlocked: (installationId: String, state: VehicleCardState) -> Unit = { _, _ -> },
    /** A starter segment. */
    val onStarterRoute: (id: String) -> Unit = {},
    /** "Fit a Route Compass at the Workshop ▸" → Workshop › EQUIPMENT. */
    val onFittingLink: () -> Unit = {},
    /** GO on a short supply row → where it is earned. */
    val onSupplyGo: (resourceId: String) -> Unit = {},
    /** SEND (the caller creates the idempotency key once and stores it in SavedStateHandle; a permit opens the Seal). */
    val onSend: () -> Unit = {},
    /** Any SEND state other than ENABLED / BUSY (so the caller can toast the reason). */
    val onSendRefused: (reason: String?) -> Unit = {},
    /** RETRY on a preview error. */
    val onRetryPreview: () -> Unit = {},
    /** CHECK on a pending departure (the existing by-key read). */
    val onCheckPending: () -> Unit = {},
)

/** The SEND body: pending banner, destination, vehicles, reward preview, supplies. */
@Composable fun ColumnScope.LodgeSendBody(ui: LodgeSendUi, on: LodgeSendActions) {
    val c = PkwTokens.Colors
    val route = ui.routes.firstOrNull { it.routeId == ui.selectedRouteId }
    val chosen = ui.vehicles.firstOrNull { it.installationId == ui.selectedInstallationId }
    val starterMode = chosen?.family == VehicleFamily.STARTER
    val grade = if (starterMode) null else route?.grade

    ui.pending?.let { pending ->
        VoyageRow(rim = c.gold.face) {
            PkwText(pending.line, PkwTokens.Type.body, Modifier.weight(1f).padding(start = 6.dp), color = c.textOnParch, maxLines = 2)
            if (pending.checking) BusyDots(Modifier.padding(end = 12.dp))
            else SecondaryButton("CHECK", on.onCheckPending, Modifier.padding(end = 2.dp), contentDescription = "Check the departure")
        }
    }

    if (starterMode) StarterRoutes(ui.starterRoutes.orEmpty(), ui.selectedStarterRouteId, on.onStarterRoute)
    else DestinationRow(route, on.onChangeIsland)

    VoyageLabel("VEHICLE", if (starterMode) "Coast trips · supplies only" else gradeRuleLine(grade))
    // send.html: 87 × 126 cards 4 apart; the ✓ badge overhangs the selected card by 4 right and 6 up (room kept at the end).
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(end = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        ui.vehicles.filter { it.status != VehicleStatus.EMPTY && it.installationId != null }.forEach { v ->
            val state = vehicleCardState(v, ui.selectedInstallationId, grade)
            VehicleCard(v, state, grade) {
                val id = v.installationId ?: return@VehicleCard
                if (canSelect(state) || state == VehicleCardState.COAST_ONLY) on.onPickVehicle(id) else on.onVehicleBlocked(id, state)
            }
        }
    }

    VoyageLabel("YOU BRING BACK")
    RewardPreview(ui, route, on)

    val supplies = ui.preview?.supplies.orEmpty().take(2)
    if (supplies.isNotEmpty()) {
        VoyageLabel("SUPPLIES", if (starterMode) "supplies only · used up when it sails" else "used up when it sails")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            supplies.forEach { SupplyRow(it, ui.previewState == PreviewState.LOADING, on.onSupplyGo, Modifier.weight(1f)) }
            if (supplies.size == 1) Box(Modifier.weight(1f))
        }
    }
}

/** The pinned SEND and its note. */
@Composable fun ColumnScope.LodgeSendFooter(ui: LodgeSendUi, on: LodgeSendActions) {
    val look = sendLook(hasRoute = ui.selectedRouteId != null || ui.selectedStarterRouteId != null,
        hasVehicle = ui.selectedInstallationId != null, previewState = ui.previewState, preview = ui.preview,
        ordersAllowed = ui.ordersAllowed, ordersReason = ui.ordersReason, lockedReason = ui.lockedReason, busy = ui.busy,
        pending = ui.pending != null, previewError = ui.previewError)
    PrimaryButton(look.label, { if (look.state == gg.pixelkingdomwars.nativeclient.ui.model.CommandState.ENABLED) on.onSend() else on.onSendRefused(look.reason) },
        Modifier.fillMaxWidth(), verb = look.verb, sub = look.sub, state = look.state, reason = look.reason)
    PkwText("Can't be called back once it sails.", PkwTokens.Type.small, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center)
}

/** The destination row (IngredientRow geometry, 60 tall): route thumb, name + HOME / PERMIT tag, realm · grade, CHANGE. */
@Composable private fun DestinationRow(route: RouteUi?, onChange: () -> Unit) {
    val c = PkwTokens.Colors
    VoyageRow(minHeight = 60.dp) {
        SeaWell(Modifier.padding(start = 2.dp).size(44.dp)) { route?.let { LocalVoyageArt.current.routeCard(it, Modifier.size(40.dp)) } }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText(route?.displayName ?: "Choose an island", PkwTokens.Type.body, Modifier.weight(1f, fill = false), color = c.textOnParch)
                if (route != null) AccessTag(route.access)
            }
            if (route != null) PkwText("${route.realmName} · Grade ${gradeNumeral(route.grade)}", PkwTokens.Type.small, color = c.textOnParch2)
        }
        // SPEC §3 item 4: a blue CHANGE 84 × 48.
        SecondaryButton(if (route == null) "CHOOSE" else "CHANGE", onChange, Modifier.padding(end = 2.dp).size(LODGE_CHANGE_W, LODGE_CHANGE_H), verb = Verb.BLUE,
            contentDescription = if (route == null) "Choose an island" else "Change island")
    }
}

/** SPEC §3 item 4 / E1.3: the blue CHANGE is 84 × 48 on SEND and on the crafted vehicle card. */
internal val LODGE_CHANGE_W = 84.dp
internal val LODGE_CHANGE_H = 48.dp

/** The green HOME / blue PERMIT tag. */
@Composable fun AccessTag(access: Access, modifier: Modifier = Modifier) {
    if (access == Access.HOME) Tag("HOME", Verb.GREEN, modifier) else Tag("PERMIT", Verb.BLUE, modifier)
}

/**
 * SPEC §3a: COAST / LONG / INTRO segments, then the `common_<realm>` routes when advertised. The server advertises eight
 * commons; squeezed into the segment row they were eight 30 dp chips all reading "COMMON". They now sit in their own
 * scrolling row ("OTHER REALMS"), each a chip with the realm's cargo icon and name. The route picker is hidden.
 */
@Composable private fun StarterRoutes(routes: List<StarterRouteUi>, selected: String?, onPick: (String) -> Unit) {
    val home = routes.filter { !it.common }
    val commons = routes.filter { it.common }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (routes.isEmpty()) PkwText(UNKNOWN, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2)
        home.forEach { r ->
            ChoiceChip(r.label, r.id == selected, { onPick(r.id) }, Modifier.weight(1f), description = "${r.name} starter route")
        }
    }
    if (commons.isNotEmpty()) {
        VoyageLabel("OTHER REALMS", "coast trips · their own cargo")
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            commons.forEach { r -> CommonRouteChip(r, r.id == selected) { onPick(r.id) } }
        }
    }
}

/** One common starter route: the realm's cargo icon (32 dp) over its realm name; cream with a gold rim when chosen. */
@Composable private fun CommonRouteChip(route: StarterRouteUi, on: Boolean, onPick: () -> Unit) {
    val c = PkwTokens.Colors
    Plate(PlateKind.CREAM, Modifier.width(COMMON_CHIP_W).heightIn(min = 64.dp)
        .then(if (on) Modifier.border(3.dp, c.gold.face, PixelShapes.M) else Modifier)
        .clearAndSetSemantics { contentDescription = "${route.name} starter route"; role = Role.Tab; selected = on
            onClick(label = null, action = { onPick(); true }) }
        .clickable(role = Role.Tab, onClick = onPick), contentPadding = PaddingValues(4.dp), tint = if (on) c.selectedTint else null) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (route.icon.isNotEmpty()) VoyageIcon(route.icon, 32.dp)
            PkwText(route.label, PkwTokens.Type.small, color = c.textOnParch, textAlign = TextAlign.Center, maxLines = 1)
        }
    }
}

/** A common-route chip: wide enough for "Solana Reach" in VT 18 at the phone's 412 dp, four and a half per row. */
private val COMMON_CHIP_W = 84.dp

/**
 * One 87 × 126 vehicle card (SPEC §3 item 6, send.html `.vc`). Every state answers a tap so the caller can explain it.
 * A card that cannot be chosen is dim the design's way: a `#e7dcc0` body and a grey sprite, its text left readable (the
 * reason is the point), never a faded card. The trips meter shows only on a card that can sail.
 */
@Composable private fun VehicleCard(v: VehicleUi, state: VehicleCardState, grade: Int?, onTap: () -> Unit) {
    val c = PkwTokens.Colors
    val selected = state == VehicleCardState.SELECTED
    val dim = vehicleCardDim(state)
    val line = vehicleCardLine(v, state, grade)
    val danger = state in setOf(VehicleCardState.TOO_LOW_TIER, VehicleCardState.COAST_ONLY, VehicleCardState.WORN_OUT)
    val spoken = listOf(familyName(v.family), if (v.family == VehicleFamily.STARTER) "free" else tierTag(v.tier), line,
        if (selected) "selected" else null).filterNotNull().joinToString(". ")
    Box(Modifier.width(VEHICLE_CARD_W)) {
        Plate(PlateKind.CREAM, Modifier.padding(top = 6.dp).fillMaxWidth().heightIn(min = VEHICLE_CARD_H)
            .then(if (selected) Modifier.border(3.dp, c.gold.face, PixelShapes.M) else Modifier)
            .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; this.selected = selected; onClick(label = null, action = { onTap(); true }) }
            .clickable(role = Role.Button, onClick = onTap), contentPadding = PaddingValues(start = 6.dp, top = 6.dp, end = 6.dp, bottom = 6.dp),
            tint = when { selected -> c.selectedTint; dim -> VoyageColors.dimCard; else -> null }) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                SeaWell(Modifier.fillMaxWidth().height(62.dp), waves = v.family.ordinal) {
                    VehicleSprite(v.family, v.tier, wellScale(v.family), Modifier.fillMaxSize(), dim = if (dim) DIM_CARD_SPRITE else null)
                    // send.html: the blue AWAY tag sits on the well's bottom-left.
                    if (state == VehicleCardState.AWAY) Tag("AWAY", Verb.BLUE, Modifier.align(Alignment.BottomStart))
                }
                PkwText(familyShortName(v.family), PkwTokens.Type.small, color = c.textOnParch)
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally)) {
                    if (v.family == VehicleFamily.STARTER) Tag("FREE", Verb.STONE) else {
                        Tag(tierTag(v.tier), Verb.BLUE)
                        if (!dim) TripsMeter(v.tripsLeft, v.tripsMax, Modifier.weight(1f), height = 10.dp)
                    }
                }
                PkwText(line, PkwTokens.Type.small, color = if (danger) c.shortText else c.textOnParch2, textAlign = TextAlign.Center, maxLines = 1)
            }
        }
        if (selected) CheckBadge(Modifier.align(Alignment.TopEnd).offset(x = 4.dp))
    }
}

/** send.html `.vc`: 87 × 126. */
internal val VEHICLE_CARD_W = 87.dp
internal val VEHICLE_CARD_H = 126.dp

/** A card that cannot be chosen now is dimmed (send.html `.vc.dim`): away, too low a tier, coast only, worn out, in service. */
internal fun vehicleCardDim(state: VehicleCardState): Boolean = state != VehicleCardState.SELECTED && state != VehicleCardState.ELIGIBLE

/** The reward preview card (CreamCard 112): the raw resource at 64, "+net" counting up, gross · pool, the fitting row. */
@Composable private fun RewardPreview(ui: LodgeSendUi, route: RouteUi?, on: LodgeSendActions) {
    val c = PkwTokens.Colors
    val p = ui.preview
    val loading = ui.previewState == PreviewState.LOADING
    val icon = p?.resourceIcon?.takeIf { it.isNotBlank() } ?: route?.resourceIcon.orEmpty()
    val name = p?.resourceName?.takeIf { it.isNotBlank() } ?: route?.resourceName ?: UNKNOWN
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 112.dp)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            // send.html: a flat 72 dp well (#f6dfa1, 2 dp ink border) holding the raw resource at 64.
            Box(Modifier.size(72.dp).drawBehind {
                drawRect(c.ink)
                val i = 2.dp.toPx()
                drawRect(VoyageColors.rewardWell, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
            }, contentAlignment = Alignment.Center) {
                if (icon.isNotBlank()) VoyageIcon(icon, 64.dp, contentDescription = name)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                if (ui.previewState == PreviewState.ERROR) {
                    // On cream the design's danger line is #a3261a (the dark-surface danger would not read here).
                    PkwText(ui.previewError ?: "The Lodge can't reach the route chart. Try again.", PkwTokens.Type.small, color = c.shortText, maxLines = 3)
                    SecondaryButton("RETRY", on.onRetryPreview, Modifier.size(104.dp, 44.dp), contentDescription = "Retry the route preview")
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        CountUpNumber(if (loading || p == null) UNKNOWN else "+${p.netQuantity}")
                        PkwText(name, PkwTokens.Type.body, Modifier.weight(1f), color = c.textOnParch)
                    }
                    PkwText(if (loading || p == null) "$UNKNOWN found · $UNKNOWN to the island pool"
                        else "${p.grossQuantity} found · ${p.islandPoolQuantity} to the island pool", PkwTokens.Type.small, color = c.textOnParch2)
                    val fit = p?.fitting
                    if (fit != null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        VoyageIcon(fit.icon, 32.dp)
                        Column {
                            PkwText(fit.line, PkwTokens.Type.small, color = c.textOnParch)
                            PkwText(fit.fitted, PkwTokens.Type.small, color = c.textOnParch2)
                        }
                    } else if (!loading && p != null) QuietButton("Fit a Route Compass at the Workshop ▸", on.onFittingLink, onParchment = true,
                        contentDescription = "Fit a Route Compass at the Workshop")
                }
            }
        }
    }
}

/** A PS number that counts up over 300 ms when it changes (SPEC §3 motion 3); "…" never animates. */
@Composable private fun CountUpNumber(text: String) {
    val reduced = LocalReducedMotion.current
    var from by remember { mutableStateOf(text) }
    val t = remember { Animatable(1f) }
    LaunchedEffect(text) {
        if (reduced || from == text || text == UNKNOWN || from == UNKNOWN) { from = text; t.snapTo(1f) }
        else { t.snapTo(0f); t.animateTo(1f, tween(PREVIEW_COUNT_UP_MS, easing = PkwTokens.Motion.Out)); from = text }
    }
    PkwText(countUpText(from, text, t.value), PkwTokens.Type.numeralL, color = PkwTokens.Colors.textOnParch)
}

/** SPEC §3 motion 3: preview numbers count up in 300 ms (shorter than the kit's 600 ms money count-up). */
private const val PREVIEW_COUNT_UP_MS = 300

/** A half-width supply row (52 tall): icon, name + "have n", "×need"; SHORT = blood rim, red have, blue GO. */
@Composable private fun SupplyRow(s: SupplyUi, loading: Boolean, onGo: (String) -> Unit, modifier: Modifier) {
    val c = PkwTokens.Colors
    VoyageRow(modifier, rim = if (s.short) c.blood else null) {
        VoyageIcon(s.icon, 32.dp, Modifier.padding(start = 4.dp), contentDescription = s.name)
        Column(Modifier.weight(1f)) {
            PkwText(s.name, PkwTokens.Type.small, color = c.textOnParch)
            PkwText("have ${if (loading) UNKNOWN else s.have}", PkwTokens.Type.small, color = if (s.short) c.shortText else c.textOnParch2)
        }
        val go = s.earnedAt
        // SHORT: a blue GO 58 × 44 to where it is earned; otherwise PS 12 "×need" (send.html).
        if (s.short && go != null) GoButton({ onGo(s.resourceId) }, "Go to where ${s.name} is earned", Modifier.padding(end = 2.dp).size(58.dp, 44.dp))
        else PkwText("×${if (loading) UNKNOWN else s.need}", PkwTokens.Type.label, Modifier.padding(end = 2.dp), color = c.textOnParch)
    }
}
