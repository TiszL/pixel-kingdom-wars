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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.CommandRoute
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.VeilChip
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.kit.commandRoute
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ErrorRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState

/*
 * Design component: CRYSTAL FRAGMENTS (design/final/map/SPEC.md Round 2 §E; divine-fragments.png), registry row 89,
 * `Destination.DivineFragments`. A TALL sheet: the living header (the isle's crystal peaks, from the host), title
 * "FRAGMENTS", History, close, VeilChip `ready-status` "8 waiting for you"; the count card (fragments 64 in a `#4A3F66`
 * well, PS 16 count + VT 20 "in Ironhold", VT 18 what they are); WAITING FOR YOU rows (48 well, VT title "Solo area 212 ·
 * +6", VT 18 sub, green READY; the clan citadel row locked with "join a clan at the Clan Hall" + blue GO); INTO with
 * CHANGE; "Trade them / at your Market stall" + blue GO (Market › BUY › FRAGMENTS); footer gold DELIVER 8 "into
 * Ironhold's stores". The count card is the fly target on success (no readout is added: a 64 px icon cannot sit in a
 * 24 dp readout row at an integer scale).
 */

/** One WAITING FOR YOU row (§E `FragmentSourceUi`; `go` is the registry row of its door). */
@Immutable data class FragmentSourceUi(
    val kind: FragmentSource,
    /** "Solo area 212 · +6". */
    val title: String,
    /** "held last week" / "join a clan at the Clan Hall". */
    val sub: String,
    /** "+6" ("…" unknown); null when nothing is waiting. */
    val amount: String?,
    val state: SourceState,
    /** A LOCKED row's blue GO (the Clan Hall); null draws none. */
    val go: FeatureId?,
)

/** Everything FRAGMENTS draws (§E `DivineFragmentsUi`; fields after `load` were added with defaults). */
@Immutable data class DivineFragmentsUi(
    /** Fragments already in the kingdom ("12"; "…" unknown). */
    val inKingdom: String,
    /** "Ironhold". */
    val kingdomName: String,
    val waiting: List<FragmentSourceUi>,
    val destination: KingdomPickUi,
    /** DELIVER 8: sub "into Ironhold's stores"; DISABLED "Nothing waiting · hold a solo area to earn"; BUSY "Delivering". */
    val primary: CommandUi,
    /** "This request may already be accepted. Check its outcome." + CHECK OUTCOME; DELIVER stays off until checked. */
    val recovery: RecoveryUi?,
    val load: LoadState,
    /** The header chip ("8 waiting for you"); null hides it. */
    val waitingLine: String? = null,
    /** The host's crop of the crystal peaks; null fills the stage colour. */
    val headerArt: ImageBitmap? = null,
    /** The feature is off: the body is the EmptyState "Fragments open later on this server". */
    val featureOff: Boolean = false,
    /** The Market door (Market › BUY › FRAGMENTS); null hides the trade row. */
    val market: FeatureId? = null,
    /** VT 18 under the count. */
    val about: String = "Crystal Fragments. Earned on the Divine Isle and Seeker Island.",
)

/** FRAGMENTS callbacks (§E; `onRetry`, `onReport`, `onExplain` added). */
@Immutable data class DivineFragmentsActions(
    val onDeliver: () -> Unit = {},
    val onChangeKingdom: () -> Unit = {},
    /** A row's or the trade row's GO (registry row). */
    val onGo: (FeatureId) -> Unit = {},
    val onHistory: () -> Unit = {},
    val onRecover: (String) -> Unit = {},
    val onClose: () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onReport: () -> Unit = {},
    val onExplain: (String) -> Unit = {},
)

/**
 * The FRAGMENTS tall sheet.
 *
 * Pointer rule: the root is the kit SheetFrame (a painted panel); only its frame, rows and buttons take touches. The TALL
 * scrim is the SheetHost's, under it, only while shown.
 */
@Composable fun DivineFragmentsSheet(ui: DivineFragmentsUi, on: DivineFragmentsActions, modifier: Modifier = Modifier) {
    SheetFrame(SheetFrameUi("FRAGMENTS", null, SheetSize.TALL, emptyList(), null, history = true), on.onClose, modifier,
        onHistory = on.onHistory,
        header = {
            HeaderArtCrop(ui.headerArt, Modifier.fillMaxSize())
            ui.waitingLine?.let { VeilChip(it, Modifier.align(Alignment.BottomStart).padding(6.dp), icon = "ui:ready-status") }
        },
        footer = if (ui.featureOff) null else ({ DeliverFooter(ui, on) })) {
        if (ui.featureOff) {
            EmptyState(EmptyStateUi("ui:crystal-fragments", "Fragments open later on this server",
                "Hold a solo area on the Divine Isle to earn them.", null, null), on.onGo)
            return@SheetFrame
        }
        (ui.load as? LoadState.Error)?.let { ErrorRow(it, on.onRetry, on.onReport) }
        ui.recovery?.let { RecoveryRow(it, on.onRecover) }
        CountCard(ui)
        MapSectionHeader("WAITING FOR YOU")
        if (ui.waiting.isEmpty()) ParchLine(if (ui.load == LoadState.Loading) UNKNOWN else "Nothing waiting yet.", secondary = true)
        ui.waiting.forEach { SourceRow(it, ui.load == LoadState.Loading, on) }
        MapSectionHeader("INTO")
        KingdomPickRow(ui.destination, on.onChangeKingdom)
        ui.market?.let { market ->
            MapRow {
                R2MapIcon("ui:market-menu", 32.dp)
                RowText("Trade them", "at your Market stall")
                SecondaryButton("GO", { on.onGo(market) }, Modifier.widthIn(min = 72.dp), verb = Verb.BLUE,
                    contentDescription = "Go to your Market stall to trade fragments")
            }
        }
    }
}

/** The 96 count card: fragments 64 in the `#4A3F66` well, PS 16 count + VT 20 "in Ironhold", VT 18 what they are. */
@Composable private fun CountCard(ui: DivineFragmentsUi) {
    val count = if (ui.load == LoadState.Loading) UNKNOWN else ui.inKingdom.ifBlank { UNKNOWN }
    // The count is the selected kingdom's stock; with no name known it says so plainly instead of a placeholder that never fills.
    val place = ui.kingdomName.takeUnless { it.isBlank() || it == UNKNOWN } ?: "your kingdom"
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 96.dp)
        .clearAndSetSemantics { contentDescription = "$count Crystal Fragments in $place. ${ui.about}" }, blocksScene = false) {
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ArtWell(72.dp, MapColors.divineWell) { R2MapIcon("ui:crystal-fragments", 64.dp) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwText(count, PkwTokens.Type.numeralL, color = PkwTokens.Colors.textOnParch)
                    PkwText("in $place", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                }
                PkwText(ui.about, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 3)
            }
        }
    }
}

/** A source row: 48 well with its site art, VT title / sub, then READY (green-rimmed row), a blue GO (locked), or nothing. */
@Composable private fun SourceRow(row: FragmentSourceUi, loading: Boolean, on: DivineFragmentsActions) {
    val ready = row.state == SourceState.READY
    val art = when (row.kind) {
        FragmentSource.SOLO -> "site:divine-solo-active"
        FragmentSource.CLAN -> "site:divine-clan-occupied"
        FragmentSource.SEEKER -> "site:seeker-active"
    }
    // The frame's title carries the amount ("Solo area 212 · +6"), whether or not the mapper already joined it; "…" while a read runs.
    val shownAmount = row.amount?.let { if (loading) UNKNOWN else if (it.startsWith("+") || it == UNKNOWN) it else "+$it" }
    val title = shownAmount?.let { row.title.substringBefore(" · ") + " · $it" } ?: row.title
    MapRow(tint = if (ready) MapColors.leadBody else PkwTokens.Colors.cream, rim = if (ready) PkwTokens.Colors.green.lo else PkwTokens.Colors.ink) {
        ArtWell(48.dp, MapColors.divineWell) { R2MapIcon(art, 32.dp, alpha = if (row.state == SourceState.LOCKED) 0.6f else 1f) }
        RowText(title, row.sub)
        val go = row.go
        when {
            row.state == SourceState.LOCKED && go != null -> SecondaryButton("GO", { on.onGo(go) }, Modifier.widthIn(min = 72.dp), verb = Verb.BLUE,
                contentDescription = "${row.title}: ${row.sub}. Go")
            else -> sourceTag(row.state)?.let { RowTag(it) }
        }
    }
}

/** DELIVER, routed by [commandRoute]; a saved request still being checked keeps it off ([deliverState]). */
@Composable private fun DeliverFooter(ui: DivineFragmentsUi, on: DivineFragmentsActions) {
    val pending = ui.recovery != null
    val p = ui.primary.copy(state = deliverState(ui.primary.state, pending),
        reason = if (pending && ui.primary.state == CommandState.ENABLED) DELIVER_CHECK_FIRST else ui.primary.reason)
    PrimaryButton(p.caption, {
        when (commandRoute(p)) {
            CommandRoute.OPEN -> on.onDeliver()
            CommandRoute.NEED_MORE, CommandRoute.EXPLAIN -> on.onExplain(p.reason ?: p.caption)
            CommandRoute.IGNORE -> Unit
        }
    }, Modifier.fillMaxWidth(), sub = p.sub, state = commandDrawState(p), reason = p.reason, badge = p.badge)
}

// ---- Previews (divine-fragments.png numbers; every number is a placeholder) ----

private val previewDeliver = CommandUi(FeatureId("island.divine.fragments.deliver"), "ui:crystal-fragments", "DELIVER 8", null, true,
    CommandState.ENABLED, null, null, sub = "into Ironhold's stores")

private val previewFragments = DivineFragmentsUi("12", "Ironhold", listOf(
    FragmentSourceUi(FragmentSource.SOLO, "Solo area 212 · +6", "held last week", "+6", SourceState.READY, null),
    FragmentSourceUi(FragmentSource.SEEKER, "Seeker spot 7 · +2", "your share this term", "+2", SourceState.READY, null),
    FragmentSourceUi(FragmentSource.CLAN, "Clan citadels", "join a clan at the Clan Hall", null, SourceState.LOCKED, FeatureId("hud.clan")),
), KingdomPickUi("Ironhold", "Crownlands · Keep 12", "ui_portrait_keep_t3"), previewDeliver, null, LoadState.Ready,
    waitingLine = "8 waiting for you", market = FeatureId("market.buy.fragments"))

@Composable private fun FragmentsHost(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(MapColors.stage).padding(start = 4.dp, end = 4.dp, top = 104.dp)) { content() }
}

@Preview(name = "Fragments (divine-fragments)", widthDp = 412, heightDp = 915)
@Composable private fun FragmentsPreview() { FragmentsHost { DivineFragmentsSheet(previewFragments, DivineFragmentsActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Fragments: empty / uncertain delivery", widthDp = 412, heightDp = 915)
@Composable private fun FragmentsEmptyPreview() {
    FragmentsHost {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            DivineFragmentsSheet(previewFragments.copy(waiting = previewFragments.waiting.map { it.copy(state = if (it.state == SourceState.READY) SourceState.NONE else it.state,
                sub = if (it.state == SourceState.READY) "nothing yet" else it.sub) }, waitingLine = null,
                primary = previewDeliver.copy(caption = "DELIVER", state = CommandState.DISABLED, reason = "Nothing waiting · hold a solo area to earn", sub = null)),
                DivineFragmentsActions(), Modifier.weight(1f))
            DivineFragmentsSheet(previewFragments.copy(recovery = RecoveryUi("deliver-3", "This request may already be accepted. Check its outcome.", "CHECK OUTCOME")),
                DivineFragmentsActions(), Modifier.weight(1f))
        }
    }
}

@Preview(name = "Fragments: loading / busy / error / feature off", widthDp = 412, heightDp = 915)
@Composable private fun FragmentsStatesPreview() {
    FragmentsHost {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            DivineFragmentsSheet(previewFragments.copy(load = LoadState.Loading, primary = previewDeliver.copy(caption = "Delivering", state = CommandState.BUSY)),
                DivineFragmentsActions(), Modifier.weight(1f))
            DivineFragmentsSheet(previewFragments.copy(load = LoadState.Error("Can't reach the isle.", asOf = "14:02")), DivineFragmentsActions(), Modifier.weight(1f))
            DivineFragmentsSheet(previewFragments.copy(featureOff = true), DivineFragmentsActions(), Modifier.weight(1f))
        }
    }
}
