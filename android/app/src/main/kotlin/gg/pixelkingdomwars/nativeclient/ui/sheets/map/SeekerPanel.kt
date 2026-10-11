package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.IslandPanelUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: the Seeker Island panel on the world map (design/final/map/SPEC.md §3.1, seeker-panel.png): the
 * "what it is" line, the auction state card (timer, BIDDING OPEN / OPENS / OPERATING, time, 12 dp gold meter), YOU HERE
 * (MY SPOTS, MY BIDS, each a door into the scene with that filter), up to two alert rows (outbid > won-unclaimed >
 * ready-to-claim) with a blue GO, and the gold ENTER ISLAND primary. A half sheet (no scrim).
 */

/** One alert row (SPEC §3.1): "Outbid on Spot 42" / "120 SKR held for you" (the same amount as the spot sheet). */
@Immutable data class SpotAlertUi(val spotNo: Int, val kind: AlertKind, val title: String, val sub: String)

/** Everything the Seeker panel draws: the §7.2 [IslandPanelUi] plus the SPEC §3.1 extension fields. */
@Immutable data class SeekerPanelUi(
    /** islandId "seeker-island"; stateLine = the VT 20 "Win a trading spot …" line; primary = ENTER ISLAND. */
    val panel: IslandPanelUi,
    /** The catalogue line ("100 spots, 20 of them King."); counts from the catalogue, "…" while unknown. */
    val catalogueLine: String,
    /** Null while loading. */
    val phase: AuctionPhase?,
    /** The time on the state card ("14h 10m"); null while unknown. */
    val phaseTime: String? = null,
    /** Share of the 24 h window gone (0..1); null draws an empty meter. */
    val phaseProgress: Float? = null,
    /** "1"; "…" while unknown. */
    val mySpots: String = UNKNOWN,
    /** "2"; "…" while unknown. */
    val myBids: String = UNKNOWN,
    val alerts: List<SpotAlertUi> = emptyList(),
    /** Fixture data: stone TEST DATA in the header; the state card never says LIVE. */
    val testData: Boolean = false,
    /** The auction read failed: "Can't reach the auction · RETRY". */
    val error: Boolean = false,
)

/** Seeker panel callbacks (SPEC §3.1). */
@Immutable data class SeekerPanelActions(
    /** ENTER ISLAND (always offered: the island is a place even when auctions are off). */
    val onEnter: () -> Unit = {},
    /** A YOU HERE card: the scene with that filter (MINE / BIDS). */
    val onStat: (SpotFilter) -> Unit = {},
    /** An alert's GO: the scene with that spot selected. */
    val onAlert: (Int) -> Unit = {},
    val onRetry: () -> Unit = {},
    val onClose: () -> Unit = {},
    /** A non-enabled primary's tap (reason toast), routed with `commandRoute`. */
    val onPrimaryRefused: (CommandUi) -> Unit = {},
)

/**
 * The Seeker Island panel (SPEC §3.1).
 *
 * Pointer rule: a HALF sheet with no scrim; only the painted frame and its buttons take touches. A tap on empty map
 * closes it through the scene's own tap (the SheetHost), never through a scrim here.
 */
@Composable fun SeekerPanel(ui: SeekerPanelUi, on: SeekerPanelActions, modifier: Modifier = Modifier) {
    val off = ui.phase == AuctionPhase.SERVER_OFF
    MapSheetFrame("SEEKER ISLAND", "ui:seeker-navigation", on.onClose, modifier,
        tags = if (ui.testData) listOf(MapTagUi("TEST DATA", Verb.STONE)) else emptyList(),
        footer = {
            val p = ui.panel.primary
            val state = commandDrawState(p)
            PrimaryButton(p.caption, { if (state == CommandState.ENABLED) on.onEnter() else on.onPrimaryRefused(p) }, Modifier.fillMaxWidth(),
                verb = if (p.verb == Verb.STONE) Verb.GOLD else p.verb, sub = p.sub, state = state, reason = p.reason, badge = p.badge)
        }) {
        ParchLine("${ui.panel.stateLine} ${ui.catalogueLine}".trim())
        StateCard(ui, on)
        if (!off) {
            MapSectionHeader("YOU HERE")
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                StatCard("site:seeker-active", "MY SPOTS", ui.mySpots, Modifier.weight(1f), onClick = { on.onStat(SpotFilter.MINE) })
                StatCard("skr", "MY BIDS", ui.myBids, Modifier.weight(1f), onClick = { on.onStat(SpotFilter.BIDS) }, iconSize = 24.dp)
            }
            topAlerts(ui.alerts) { it.kind }.forEach { alert ->
                val outbid = alert.kind == AlertKind.OUTBID
                MapRow(tint = if (outbid) MapColors.missBody else PkwTokens.Colors.selectedTint, rim = if (outbid) PkwTokens.Colors.blood else PkwTokens.Colors.ink) {
                    MapIcon(if (outbid) "site:seeker-occupied" else "ui:ready-status", 32.dp)
                    RowText(alert.title, alert.sub)
                    GoButton({ on.onAlert(alert.spotNo) }, "Go to spot ${alert.spotNo}", Modifier.size(58.dp, 48.dp))
                }
            }
        }
    }
}

/** The state card (SPEC §3.1): CreamCard 66, timer 36, PS 12 headline, PS 12 red time, 12 dp gold meter; stone and
 *  meterless when the server has auctions off (the warm fieldstone light face with ink text: `off` is the disabled face
 *  and never carries text, DESIGN-SYSTEM colour pass); a danger line + RETRY on error; "…" while loading. */
@Composable private fun StateCard(ui: SeekerPanelUi, on: SeekerPanelActions) {
    val off = ui.phase == AuctionPhase.SERVER_OFF
    val head = phaseHeadline(ui.phase)
    val time = if (ui.phase == null || off) null else ui.phaseTime ?: UNKNOWN
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 66.dp)
        .clearAndSetSemantics { contentDescription = listOfNotNull(head, time, if (ui.error) "Can't reach the auction" else null).joinToString(", ") },
        tint = if (off) PkwTokens.Colors.stone.hi else null, blocksScene = ui.error) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwIcon(if (off) "ui:exhausted-status" else "timer", 36.dp)
            Column(Modifier.weight(1f)) {
                if (ui.error) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        PkwText("Can't reach the auction", PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.shortText, maxLines = 2)
                        SecondaryButton("RETRY", on.onRetry, verb = Verb.BLUE)
                    }
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        PkwText(head, if (off) PkwTokens.Type.body else PkwTokens.Type.label, Modifier.weight(1f),
                            color = PkwTokens.Colors.textOnParch, maxLines = 2)
                        if (time != null) PkwText(time, PkwTokens.Type.label, color = PkwTokens.Colors.shortText)
                    }
                    if (!off) ParchMeter(ui.phaseProgress, Verb.GOLD, Modifier.padding(top = 4.dp))
                }
            }
        }
    }
}

// ---- Previews ----

private val enterIsland = CommandUi(FeatureId("island.seeker.enter"), "ui:seeker-navigation", "ENTER ISLAND", null, true,
    CommandState.ENABLED, null, null, sub = "bid from the trading spots")

private fun previewPanel(phase: AuctionPhase?, error: Boolean = false, testData: Boolean = false) = SeekerPanelUi(
    IslandPanelUi("seeker-island", "Win a trading spot to sell realm permits for 7 days.", enterIsland, emptyList()),
    "100 spots, 20 of them King.", phase, "14h 10m", 0.42f, if (phase == null) UNKNOWN else "1", if (phase == null) UNKNOWN else "2",
    listOf(SpotAlertUi(42, AlertKind.OUTBID, "Outbid on Spot 42", "120 SKR held for you"),
        SpotAlertUi(7, AlertKind.READY_TO_CLAIM, "Spot 7 has rewards", "Island pool share ready"),
        SpotAlertUi(9, AlertKind.WON_UNCLAIMED, "You won Spot 9", "Open it to start operating")), testData, error)

@Composable private fun PanelHost(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.bg).padding(horizontal = 4.dp), contentAlignment = Alignment.BottomCenter) { content() }
}

@Preview(name = "Bidding open with alerts (seeker-panel)", widthDp = 412, heightDp = 915)
@Composable private fun SeekerPanelOpenPreview() { PanelHost { SeekerPanel(previewPanel(AuctionPhase.OPEN), SeekerPanelActions()) } }

@Preview(name = "Server off", widthDp = 412, heightDp = 915)
@Composable private fun SeekerPanelOffPreview() { PanelHost { SeekerPanel(previewPanel(AuctionPhase.SERVER_OFF).copy(alerts = emptyList()), SeekerPanelActions()) } }

@Preview(name = "Loading", widthDp = 412, heightDp = 915)
@Composable private fun SeekerPanelLoadingPreview() { PanelHost { SeekerPanel(previewPanel(null).copy(alerts = emptyList()), SeekerPanelActions()) } }

@Preview(name = "TEST DATA + error", widthDp = 412, heightDp = 915)
@Composable private fun SeekerPanelErrorPreview() { PanelHost { SeekerPanel(previewPanel(AuctionPhase.OPENS_AT, error = true, testData = true), SeekerPanelActions()) } }
