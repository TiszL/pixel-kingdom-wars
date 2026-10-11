package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.Access
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LocalVoyageArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RouteUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageIcon
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.vehicleIdleArt

/*
 * Design component: the archipelago island panel (design/final/map/SPEC.md §6, archipelago-panel.png): what the island is
 * for (route card, GRADE / TIER tags, chain and realm line, the vehicle it needs), YOUR EXPEDITIONS HERE (under way with
 * a green meter and time left, RETURNED on a green row; the label is "Returned" until the collect semantics are verified,
 * IS-N2), and the way to the Lodge: blue GO TO LODGE + gold SEND "from your Lodge". The island never owns dispatch: SEND
 * goes Home, focuses the Lodge and opens Lodge › SEND with this route preselected.
 *
 * Route art comes from the voyage cluster's [LocalVoyageArt] (the data side provides the chain atlases); this panel adds
 * no second route-art path.
 */

/** One trip to this island (SPEC §6 `TripRowUi`). */
@Immutable data class ExpeditionRowUi(
    val id: String,
    val family: VehicleFamily,
    val tier: Int?,
    /** "Survey Balloon". */
    val name: String,
    val state: ExpeditionState,
    /** "Under way · back in 1h 20m" / "Returned to the Lodge". */
    val line: String,
    /** Under way: 0..1 done; null draws an empty meter. */
    val progress: Float? = null,
)

/** Everything the archipelago panel draws (SPEC §6 `ArchipelagoPanelUi`). */
@Immutable data class ArchipelagoPanelUi(
    /** "<chain>/<slot>". */
    val islandId: String,
    /** The route this island is (the id join); null when the join failed: name only, no SEND, Report. */
    val route: RouteUi?,
    /** "AURORA ISLE 2" from the route catalogue. */
    val name: String,
    val grade: Int?,
    val minTier: Int?,
    /** "Aurora chain, near Frostveil". */
    val realmLine: String?,
    /** "Needs a tier 2 vehicle or better". */
    val needsLine: String?,
    val trips: List<ExpeditionRowUi>,
    /** SEND: caption "SEND", sub "from your Lodge"; DISABLED + reason when no vehicle is eligible ("Needs tier 2 · your best
     *  is tier 1"). */
    val send: CommandUi,
    /** False: SEND becomes the green BUILD A LODGE and GO TO LODGE hides. */
    val hasLodge: Boolean,
    /** No eligible vehicle: a blue GO to the Solana Public Workshop under the row. */
    val publicWorkshopGo: Boolean = false,
    /** The route art did not load: a stone well with "art didn't load" (no fake art). */
    val artFailed: Boolean = false,
)

/** Archipelago panel callbacks (SPEC §6). */
@Immutable data class ArchipelagoPanelActions(
    /** SEND: Home → focus Lodge → Lodge(SEND, routeId). */
    val onSend: () -> Unit = {},
    /** GO TO LODGE: Home → focus Lodge. */
    val onGoLodge: () -> Unit = {},
    /** BUILD A LODGE: BuildShop focus. */
    val onBuildLodge: () -> Unit = {},
    /** The no-eligible-vehicle GO: the Solana Public Workshop. */
    val onPublicWorkshop: () -> Unit = {},
    /** The unknown-route Report link. */
    val onReport: () -> Unit = {},
    /** A disabled SEND: its reason (toast). */
    val onExplain: (String) -> Unit = {},
    val onClose: () -> Unit = {},
)

/**
 * The archipelago island panel (SPEC §6).
 *
 * Pointer rule: a HALF sheet with no scrim; only the painted frame and its buttons take touches (trip rows are paint).
 */
@Composable fun ArchipelagoPanel(ui: ArchipelagoPanelUi, on: ArchipelagoPanelActions, modifier: Modifier = Modifier) {
    val primary = archipelagoPrimary(ui.hasLodge, ui.route != null)
    MapSheetFrame(ui.name, "ui:lodge-menu", on.onClose, modifier, footer = { ArchipelagoFooter(ui, primary, on) }) {
        if (ui.route != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ArtWell(84.dp, PkwTokens.Colors.surface) {
                    if (ui.artFailed) PkwText("art didn't load", PkwTokens.Type.small, Modifier.padding(4.dp), color = PkwTokens.Colors.muted,
                        textAlign = TextAlign.Center, maxLines = 2)
                    else LocalVoyageArt.current.routeCard(ui.route, Modifier.size(80.dp))
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Tag(gradeTag(ui.grade), Verb.BLUE)
                        Tag(tierTag(ui.minTier), Verb.STONE)
                    }
                    ui.realmLine?.let { ParchLine(it, maxLines = 2) }
                    ui.needsLine?.let { ParchLine(it, secondary = true, maxLines = 2) }
                }
            }
        }
        MapSectionHeader(if (ui.trips.isEmpty()) "YOUR EXPEDITIONS HERE" else "YOUR EXPEDITIONS HERE · ${ui.trips.size}")
        if (ui.trips.isEmpty()) ParchLine("No expeditions here yet", secondary = true)
        ui.trips.forEach { TripRow(it) }
    }
}

/** A trip row (IngredientRow ≥ 52): the vehicle idle at 56, VT 20 name, VT 18 state; under way adds the 12 dp green meter,
 *  returned is a green-tint row with the green RETURNED tag. Paint only. */
@Composable private fun TripRow(t: ExpeditionRowUi) {
    val back = t.state == ExpeditionState.RETURNED
    MapRow(Modifier.clearAndSetSemantics { contentDescription = "${t.name}. ${t.line}" },
        tint = if (back) MapColors.leadBody else PkwTokens.Colors.cream, rim = if (back) PkwTokens.Colors.green.lo else PkwTokens.Colors.ink) {
        VoyageIcon(vehicleIdleArt(t.family, t.tier), 56.dp)
        Column(Modifier.weight(1f)) {
            PkwText(t.name, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
            PkwText(t.line, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2)
            if (!back) ParchMeter(t.progress, Verb.GREEN, Modifier.padding(top = 3.dp))
        }
        if (back) Tag("RETURNED", Verb.GREEN)
    }
}

/** The command row (SPEC §6): GO TO LODGE + SEND, or BUILD A LODGE, or (route unknown) the Report link. */
@Composable private fun ArchipelagoFooter(ui: ArchipelagoPanelUi, primary: ArchipelagoPrimary, on: ArchipelagoPanelActions) {
    when (primary) {
        ArchipelagoPrimary.NONE -> QuietButton("Report this island", on.onReport, Modifier.fillMaxWidth(), onParchment = true)
        ArchipelagoPrimary.BUILD_LODGE -> PrimaryButton("BUILD A LODGE", on.onBuildLodge, Modifier.fillMaxWidth(), verb = Verb.GREEN,
            sub = "expeditions sail from it", icon = "ui:lodge-menu")
        ArchipelagoPrimary.SEND -> {
            val state = commandDrawState(ui.send)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                BlueDoorButton("GO TO LODGE", null, "Go to your Lodge", on.onGoLodge)
                PrimaryButton(ui.send.caption, { if (state == CommandState.ENABLED) on.onSend() else on.onExplain(ui.send.reason ?: ui.send.caption) },
                    Modifier.weight(1f), sub = ui.send.sub, state = state, reason = ui.send.reason, badge = ui.send.badge)
            }
            if (ui.publicWorkshopGo) {
                MapRow {
                    MapIcon("site:solana-active", 32.dp)
                    RowText("Craft a better vehicle", "at the Solana Public Workshop")
                    GoButton(on.onPublicWorkshop, "Go to the Solana Public Workshop", Modifier.size(58.dp, 48.dp))
                }
            }
        }
    }
}

// ---- Previews ----

private val previewRoute = RouteUi("aurora-2", "aurora", 1, "Aurora Isle 2", "frostveil", "Frostveil", "frost_glass", 2, Access.HOME, null)
private val send = CommandUi(FeatureId("island.archipelago.send"), "ui:lodge-menu", "SEND", null, true, CommandState.ENABLED, null, null,
    sub = "from your Lodge")
private val trips = listOf(
    ExpeditionRowUi("t1", VehicleFamily.SURVEY_BALLOON, 2, "Survey Balloon", ExpeditionState.UNDER_WAY, "Under way · back in 1h 20m", 0.6f),
    ExpeditionRowUi("t2", VehicleFamily.CARGO_CUTTER, 2, "Cargo Cutter", ExpeditionState.RETURNED, "Returned to the Lodge"))

private val base = ArchipelagoPanelUi("aurora/2", previewRoute, "AURORA ISLE 2", 2, 2, "Aurora chain, near Frostveil",
    "Needs a tier 2 vehicle or better", trips, send, hasLodge = true)

@Composable private fun Host(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.bg).padding(horizontal = 4.dp), contentAlignment = Alignment.BottomCenter) { content() }
}

@Preview(name = "Trips here (archipelago-panel)", widthDp = 412, heightDp = 915)
@Composable private fun ArchipelagoPreview() { Host { ArchipelagoPanel(base, ArchipelagoPanelActions()) } }

@Preview(name = "No eligible vehicle; no trips", widthDp = 412, heightDp = 915)
@Composable private fun ArchipelagoIneligiblePreview() {
    Host {
        ArchipelagoPanel(base.copy(trips = emptyList(), publicWorkshopGo = true,
            send = send.copy(state = CommandState.DISABLED, reason = "Needs tier 2 · your best is tier 1")), ArchipelagoPanelActions())
    }
}

@Preview(name = "No Lodge / route unknown / art failed", widthDp = 412, heightDp = 1500)
@Composable private fun ArchipelagoStatesPreview() {
    Host {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ArchipelagoPanel(base.copy(hasLodge = false, trips = emptyList()), ArchipelagoPanelActions())
            ArchipelagoPanel(base.copy(route = null, grade = null, minTier = null, trips = emptyList()), ArchipelagoPanelActions())
            ArchipelagoPanel(base.copy(artFailed = true, grade = null), ArchipelagoPanelActions())
        }
    }
}
