package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyName
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: wall ROW mode's quote (design/final/buildings/SPEC.md R2.4 + critic fixes, wall-row.png; registry row
 * 51). Wall selected → ROW selects the straight connected run; the bar becomes CANCEL ROW · UPGRADE ROW★; UPGRADE ROW
 * opens this WallRowQuote half sheet. The world part is the scene's and the committed selection overlay's: every wall in
 * the row gets the 2 dp gold sprite outline + 18 % gold tint, and the NamePlate under the row is the committed
 * `SelectionOverlay` with `NamePlateUi("WALL ROW", "LV 3", "9 walls in this row", null)` anchored on the row's union rect
 * (its plate-avoid rule keeps it over open grass with a 4 dp ink stem). A tap on a wall in the row toggles it
 * ([WallRowActions.onToggleWall], outline off 120 ms) and the quote re-asks the server.
 */

/** The wall-row quote (SPEC R2.4 `WallRowQuoteUi`). Every number arrives formatted; unknown is "…", never "0". */
@Immutable data class WallRowQuoteUi(
    /** Every wall in the straight run, in row order (left → right). */
    val wallIds: List<String>,
    /** Walls the player tapped out of the row. */
    val excluded: Set<String>,
    /** The lowest level in the row ("LV 3"), blue. */
    val fromLevel: String,
    /** The level after ("LV 4"), green. */
    val toLevel: String,
    /** The wall piece now (`pkw_web_wall_t3` / `wall5_t3_straight_intact_f1`), drawn three times at k = 2. */
    val artNow: String,
    /** The wall piece after (`pkw_web_wall_t4`). */
    val artNext: String,
    /** Walls that will upgrade ("UPGRADE 7"). */
    val count: Int,
    /** Walls already at [toLevel], skipped. */
    val skipped: Int,
    /** What improves (Walls to upgrade 7 of 9, Already LV 4 skipped 2, Hitpoints each 900 › 1,150). */
    val rows: List<StatDeltaUi>,
    /** One wall's price (the "7 × 1,500" pill); CHECKING keeps the pill enabled as navigation (re-asks the price). */
    val unitPrice: PriceUi,
    /** The whole row's price ("10,500 Shards in all"); SHORT turns the quote SHORT. */
    val total: PriceUi,
    /** Build time ("20m"); null when walls are instant on the server (the time chip is hidden). */
    val time: String?,
    /** Builders ("1/2 free"). */
    val builders: String,
    /** The quote state (the UPGRADE sheet's states; VERIFYING here keeps the primary as RETRY, see [quoteLook]). */
    val state: UpgradeState,
    /** SHORT: how much more is needed ("2,300"). */
    val shortfall: String? = null,
    /** NO_BUILDER: when the next builder frees up ("2h 14m"). */
    val builderFreeIn: String? = null,
    /** READ_ONLY / VERIFYING / an authoritative refusal: the one-line reason. */
    val reason: String? = null,
    /** True only when the server keeps walls up while they upgrade (the unverified second hint sentence, SPEC R2.4). */
    val wallsStayUp: Boolean = false,
    /** Live hosts override this when the current quote owner does not support per-wall exclusion. */
    val selectionHint: String? = null,
)

/** Wall-row callbacks (SPEC R2.4 `WallRowActions`, plus the recovery doors the states name). */
class WallRowActions(
    /** A tap on a wall in the outlined row (from the scene): toggles it in / out; the quote re-asks the server. */
    val onToggleWall: (String) -> Unit,
    /** UPGRADE n: sends the row upgrade. Only called when [quoteLook] `sends` (RETRY re-sends after a lost answer). */
    val onUpgrade: () -> Unit,
    /** CANCEL ROW and the red close: leaves ROW mode (outlines off, the bar returns to the wall's own commands). */
    val onCancelRow: () -> Unit,
    /** GET SHARDS / the SHORT pill: Need-more for this currency key ("shards"). Never spends. */
    val onGetMore: (String) -> Unit,
    /** The CHECKING price pill: re-ask the price (the quote stays open and readable). */
    val onRecheck: () -> Unit = {},
    /** NO_BUILDER: the stone BUILDERS door. */
    val onBuilders: () -> Unit = {},
    /** "Report" while being checked. */
    val onReport: (() -> Unit)? = null,
)

/**
 * The WallRowQuote half sheet (wall-row.png): title "UPGRADE ROW · LV 3 ▸ LV 4" + red close; two grass compare wells (96
 * tall, three wall pieces each, NO gold rim: t3 and t4 differ only in height and a trim band, critic fix 2026-10-03);
 * the StatDeltaRow list; the "7 × 1,500" pill, time and builders chips; the hint; stone CANCEL ROW 104 × 62 + the green
 * "UPGRADE 7 · 10,500 Shards in all" primary. The host places it from y 458 and slides it as UPGRADE (180 / 140 ms).
 *
 * Pointer rule: a HALF sheet has NO scrim. One painted wood panel (a scene-input region); only its buttons and the price
 * pill take taps. The outlined row above it stays live: the scene routes wall taps to [WallRowActions.onToggleWall].
 * Nothing here is full-screen, clickable on empty space, a pointerInput root, a scrim or draggable.
 */
@Composable fun WallRowQuoteSheet(ui: WallRowQuoteUi, on: WallRowActions, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    val look = quoteLook(ui.state, ui.total, ui.reason, nothingToDo = ui.count <= 0 && ui.state != UpgradeState.CHECKING,
        emptyReason = ui.reason ?: "All walls are ${ui.toLevel}")
    val key = currencyKey(ui.total.currency)
    Plate(PlateKind.WOOD, modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            HalfSheetHeader("UPGRADE ROW", on.onCancelRow, tag = ui.fromLevel, tagTo = ui.toLevel,
                closeEnabled = look.kind != QuoteKind.STARTING)
            Spacer(Modifier.height(6.dp))
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), contentPadding = PaddingValues(8.dp), blocksScene = false) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(Modifier.fillMaxWidth().height(96.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        WallWell(ui.artNow, "Walls now, ${ui.fromLevel}", Modifier.weight(1f))
                        StepArrow(12.dp, 22.dp)
                        WallWell(ui.artNext, "Walls after the upgrade, ${ui.toLevel}", Modifier.weight(1f))
                    }
                    if (ui.rows.isNotEmpty()) Column(Modifier.fillMaxWidth().background(c.cream).border(2.dp, c.ink).padding(2.dp)) {
                        ui.rows.forEachIndexed { i, row ->
                            if (i > 0) Box(Modifier.fillMaxWidth().height(2.dp).background(ROW_DIVIDER))
                            StatDeltaRow(row)
                        }
                    }
                    ChipsRow(ui, look, on, key)
                    PkwText(look.reason.takeIf { look.kind == QuoteKind.RETRY } ?: ui.selectionHint ?: wallRowHint(ui.wallsStayUp), PkwTokens.Type.small,
                        color = c.textOnParch2, maxLines = 3)
                    PrimaryRow(ui, look, on, key)
                }
            }
        }
    }
}

/** The 2 dp divider of the improves list (`#E2CB93`, as UPGRADE). */
private val ROW_DIVIDER = Color(0xFFE2CB93)

/** The Need-more key of a currency ("shards", "gems"). */
private fun currencyKey(currency: Currency): String = currencyName(currency).lowercase()

/** A grass well (96 tall) with three wall pieces side by side at a whole scale. No rim. */
@Composable private fun WallWell(art: String, spoken: String, modifier: Modifier) {
    Box(modifier.fillMaxHeight().clipToBounds().drawBehind { drawGrassWell(goldRim = false) }.clearAndSetSemantics { contentDescription = spoken },
        contentAlignment = Alignment.Center) {
        Row(horizontalArrangement = Arrangement.spacedBy(0.dp)) { repeat(3) { R2Art(art, 32.dp, 56.dp) } }
    }
}

/** Unit-price pill (tappable while CHECKING = re-ask; SHORT = Need-more), time (hidden when instant), builders. SHORT
 *  replaces the chips with the red pill and "Need 2,300 more Shards". */
@Composable private fun ChipsRow(ui: WallRowQuoteUi, look: QuoteLook, on: WallRowActions, key: String) {
    val c = PkwTokens.Colors
    val unitText = unitTimesCount(ui.count, ui.unitPrice)
    val pill = if (look.kind == QuoteKind.NEED_MORE) ui.total.copy(status = PriceStatus.SHORT)
    else ui.unitPrice.copy(amount = unitText, status = if (unitText == null && ui.unitPrice.status == PriceStatus.OK) PriceStatus.CHECKING else ui.unitPrice.status,
        description = unitText?.let { "${ui.count} walls at ${ui.unitPrice.amount} ${currencyName(ui.unitPrice.currency)} each" })
    val onPill: (() -> Unit)? = when (priceTap(pill)) {
        PriceTap.NEED_MORE -> ({ on.onGetMore(key) })
        PriceTap.OPEN -> if (pill.status == PriceStatus.CHECKING) on.onRecheck else null
        PriceTap.EXPLAIN -> null
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        PriceChip(pill, Modifier.heightIn(min = 30.dp), onClick = onPill)
        if (look.kind == QuoteKind.NEED_MORE) {
            PkwText("Need ${ui.shortfall ?: UNKNOWN} more ${currencyName(ui.total.currency)}", PkwTokens.Type.body, Modifier.weight(1f),
                color = c.shortText, maxLines = 2)
        } else {
            ui.time?.let { QuoteChip("timer", 24.dp, it, "Takes $it") }
            QuoteChip("builder", 30.dp, ui.builders, "Builders ${ui.builders}")
        }
    }
}

/** Stone CANCEL ROW 104 × 62 + the primary that follows [quoteLook]. */
@Composable private fun PrimaryRow(ui: WallRowQuoteUi, look: QuoteLook, on: WallRowActions, key: String) {
    val h = Modifier.heightIn(min = PkwTokens.Dims.sheetPrimaryH)
    val label = "UPGRADE ${ui.count}"
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        SecondaryButton("CANCEL ROW", on.onCancelRow, Modifier.width(104.dp).heightIn(min = 62.dp), enabled = look.kind != QuoteKind.STARTING)
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
            when (look.kind) {
                QuoteKind.COMMIT -> PrimaryButton(label, on.onUpgrade, Modifier.fillMaxWidth().then(h), verb = Verb.GREEN, icon = "shape:up",
                    sub = inAllLine(ui.total))
                QuoteKind.WAIT_PRICE -> PrimaryButton("Checking price", {}, Modifier.fillMaxWidth().then(h), state = CommandState.BUSY)
                QuoteKind.STARTING -> PrimaryButton("Starting…", {}, Modifier.fillMaxWidth().then(h), state = CommandState.BUSY)
                QuoteKind.RETRY -> {
                    PrimaryButton("RETRY", on.onUpgrade, Modifier.fillMaxWidth().then(h), verb = Verb.GREEN, sub = BEING_CHECKED)
                    on.onReport?.let { report -> QuietButton("Report", report, onParchment = true, contentDescription = "Report a problem with this upgrade") }
                }
                QuoteKind.NEED_MORE -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PrimaryButton(label, { on.onGetMore(key) }, Modifier.weight(1f).then(h), verb = Verb.GREEN,
                        sub = "needs ${currencyName(ui.total.currency)}", state = CommandState.DISABLED)
                    PrimaryButton(getLabel(ui.total.currency), { on.onGetMore(key) }, Modifier.weight(1f).then(h), verb = Verb.BLUE,
                        icon = currencyIcon(ui.total.currency, ui.total.icon))
                }
                QuoteKind.NEED_BUILDER -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PrimaryButton(label, on.onBuilders, Modifier.weight(1f).then(h), verb = Verb.GREEN, sub = "needs a builder", state = CommandState.DISABLED)
                    PrimaryButton("BUILDERS", on.onBuilders, Modifier.weight(1f).then(h), verb = Verb.STONE, icon = "builder",
                        sub = ui.builderFreeIn?.let { "Free in $it" })
                }
                QuoteKind.OFF -> PrimaryButton(label, {}, Modifier.fillMaxWidth().then(h), verb = Verb.GREEN, state = CommandState.DISABLED,
                    reason = look.reason)
            }
        }
    }
}

// ---- Previews ----

private fun shards(amount: String?, status: PriceStatus = PriceStatus.OK) = PriceUi(Currency.SHARDS, amount, status)

private val sampleRow = WallRowQuoteUi(
    wallIds = (1..9).map { "wall-$it" }, excluded = emptySet(), fromLevel = "LV 3", toLevel = "LV 4",
    artNow = "pkw_web_wall_t3", artNext = "pkw_web_wall_t4", count = 7, skipped = 2,
    rows = listOf(StatDeltaUi("layout", "Walls to upgrade", null, "7 of 9"), StatDeltaUi("shape:info", "Already LV 4, skipped", null, "2"),
        StatDeltaUi("shield", "Hitpoints each", "900", "1,150")),
    unitPrice = shards("1,500"), total = shards("10,500"), time = "20m", builders = "1/2 free", state = UpgradeState.READY,
)
private val previewActions = WallRowActions(onToggleWall = {}, onUpgrade = {}, onCancelRow = {}, onGetMore = {})

@Preview(name = "Wall row: default (wall-row.png)", widthDp = 412, heightDp = 915)
@Composable private fun WallRowDefaultPreview() = HalfSheetPreviewFrame { WallRowQuoteSheet(sampleRow, previewActions, it) }

@Preview(name = "Wall row: checking price (pill enabled, commit waits)", widthDp = 412, heightDp = 915)
@Composable private fun WallRowCheckingPreview() = HalfSheetPreviewFrame {
    WallRowQuoteSheet(sampleRow.copy(state = UpgradeState.CHECKING, unitPrice = shards(null, PriceStatus.CHECKING), total = shards(null, PriceStatus.CHECKING)),
        previewActions, it)
}

@Preview(name = "Wall row: short Shards", widthDp = 412, heightDp = 915)
@Composable private fun WallRowShortPreview() = HalfSheetPreviewFrame {
    WallRowQuoteSheet(sampleRow.copy(state = UpgradeState.SHORT, total = shards("10,500", PriceStatus.SHORT), shortfall = "2,300"), previewActions, it)
}

@Preview(name = "Wall row: empty (all at LV 4), instant walls", widthDp = 412, heightDp = 915)
@Composable private fun WallRowEmptyPreview() = HalfSheetPreviewFrame {
    WallRowQuoteSheet(sampleRow.copy(count = 0, skipped = 9, time = null), previewActions, it)
}

@Preview(name = "Wall row: no builder, starting, being checked", widthDp = 1236, heightDp = 915)
@Composable private fun WallRowStatesPreview() {
    Row {
        Box(Modifier.width(412.dp)) { HalfSheetPreviewFrame { WallRowQuoteSheet(sampleRow.copy(state = UpgradeState.NO_BUILDER, builders = "0/2 free", builderFreeIn = "2h 14m"), previewActions, it) } }
        Box(Modifier.width(412.dp)) { HalfSheetPreviewFrame { WallRowQuoteSheet(sampleRow.copy(state = UpgradeState.BUSY), previewActions, it) } }
        Box(Modifier.width(412.dp)) { HalfSheetPreviewFrame { WallRowQuoteSheet(sampleRow.copy(state = UpgradeState.VERIFYING), previewActions, it) } }
    }
}
