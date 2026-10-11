package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetTitlePlate
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Keep EXPAND (design/final/buildings/SPEC.md E1.2, keep-expand.png; registry row 34): the next
 * expansion of the land claim, what it gives, what it costs, and the one consent (the system Seal "EXPAND LAND · 0.15 SOL →
 * 16×16 land · Paid from your wallet. You sign once.", raised by the host, then the money sequence). The world part (the
 * cream dashed present edge, the 30 dp green new-ring band closed by a marching gold dashed line on all four sides, the
 * two VeilChips "edge of your land" / "New land +1 tile") is the scene's, drawn on [ExpandUi.ring].
 */

/** A claim rectangle in tiles (the scene draws the ring band on it). */
@Immutable data class RectTiles(val x: Int, val y: Int, val w: Int, val h: Int)

/** A resumable expansion payment (SPEC E1.2 `saved: MoneyOp?`): its money stage, and whether its answer was lost. */
@Immutable data class MoneyOp(
    /** Where the money sequence stands (Check wallet → Sending → SENT / RETRY). */
    val stage: MoneyStage,
    /** True when the answer was lost: "Being checked · the land grows when the realm confirms it" + CHECK. */
    val uncertain: Boolean = false,
)

/** Everything EXPAND draws (SPEC E1.2 `ExpandUi`). Unknowns are null and read "…", never 0. */
@Immutable data class ExpandUi(
    /** Expansions done. */
    val index: Int,
    /** Expansions possible (6). */
    val max: Int,
    /** Land size now (14 → "14×14"). */
    val sizeNow: Int,
    /** Land size after (16); null when full size (26×26). */
    val sizeNext: Int?,
    /** New tiles to build on; null = computed from the sizes (16² − 14² = 60). */
    val newTiles: Int?,
    /** Trees and rocks inside the new ring ("+9"); null = "…". */
    val obstaclesInRing: Int?,
    /** The Keep level this expansion needs (12); null = none. */
    val reqKeepLevel: Int?,
    /** The Keep level now. */
    val keepLevel: Int,
    /** SOL, from the server (CHECKING allowed: EXPAND stays navigation into the Seal, which re-quotes). */
    val price: PriceUi,
    /** The Keep level the next expansion after this one needs (14); null = none. */
    val nextReqKeepLevel: Int?,
    /** The new ring for the world overlay. */
    val ring: RectTiles,
    /** A payment in flight or with a lost answer (resumable); null = none. */
    val saved: MoneyOp?,
    /** Read-only base / no deed: EXPAND off with this server reason. */
    val readOnly: String? = null,
    /** "as of 14:20" while a refresh failed (the last good quote stays); null draws none. */
    val asOf: String? = null,
    /** True while refreshing: the 2 dp stone line. */
    val loading: Boolean = false,
    /** Existing candidate-only free expansion navigation, distinct from a server zero SOL price. */
    val testExpansion: Boolean = false,
    /** Live catalogue geometry may grow by more than one tile per side. */
    val growthLine: String? = null,
    /** The live host names its existing purchase-review handoff. */
    val reviewHint: String? = null,
    /** A saved SOL purchase needs its recovery: the stone DETAILS door under the footer ([ExpandActions.onDetails]). */
    val recovery: Boolean = false,
)

/** EXPAND callbacks (SPEC E1.2). */
class ExpandActions(
    /** EXPAND: raises the SOL Seal (never pays on tap). */
    val onExpand: () -> Unit,
    /** The Seal's confirm (the OverlayHost's Seal calls it; kept here so one object carries the flow). */
    val onSealConfirm: () -> Unit,
    /** RETRY after a failed payment. */
    val onRetry: () -> Unit,
    /** CHECK after a lost answer: asks the realm whether the land grew. */
    val onCheck: () -> Unit,
    /** Red close / Back / the scene's own tap. */
    val onClose: () -> Unit,
    /** The camera pans to the ring (400 ms `out`) as the sheet opens. */
    val onFlyToRing: () -> Unit,
    /** LOCKED: blue GO KEEP UPGRADE. */
    val onKeepUpgrade: () -> Unit = {},
    /** SOL short: Need-more ("Add SOL in Profile › WALLET"); never auto-spends. */
    val onNeedMore: () -> Unit = {},
    /** Off states: the host shows the reason. */
    val onExplain: (String) -> Unit = {},
    /** The stone DETAILS door ([ExpandUi.recovery]): the saved purchase's recovery screen. */
    val onDetails: () -> Unit = {},
)

/** The header's land-icon well colour (current grass). */
private val WELL_GRASS = Color(0xFF4F8A3A)

/**
 * The EXPAND half sheet (keep-expand.png): a charcoal header with the 112 dp land-icon well and its stone "1 OF 6" tag,
 * the "EXPAND LAND" plate + red close, "Your land grows one tile on every side." and the green "KEEP LV 12 ✓" tag; the
 * parchment "WHAT YOU GET now ▸ after" table and its note; the footer SOL CostPill + gold EXPAND "you confirm in the
 * Seal". The host places it from y 452 and slides it 180 ms while the camera pans to the ring ([ExpandActions.onFlyToRing]).
 *
 * Pointer rule: a HALF sheet has NO scrim. One painted wood panel (a scene-input region); only its buttons and the SHORT
 * price pill take taps; the kingdom above it stays live. Nothing here is full-screen, clickable on empty space, a
 * pointerInput root, a scrim or draggable.
 */
@Composable fun KeepExpandSheet(ui: ExpandUi, on: ExpandActions, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    val kind = expandPrimary(ui)
    Plate(PlateKind.WOOD, modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            ExpandHeader(ui, on)
            Spacer(Modifier.height(6.dp))
            if (ui.loading) LoadingLine(Modifier.padding(bottom = 4.dp))
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), contentPadding = PaddingValues(8.dp), blocksScene = false) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        PkwText("WHAT YOU GET", PkwTokens.Type.label, Modifier.weight(1f), color = c.textOnParch)
                        if (ui.sizeNext != null) {
                            PkwText("now ", PkwTokens.Type.small, color = c.textOnParch2)
                            StepArrow(8.dp, 10.dp, color = c.textOnParch2)
                            PkwText(" after", PkwTokens.Type.small, color = c.green.lo)
                        }
                    }
                    Column(Modifier.fillMaxWidth().background(c.cream).border(2.dp, c.ink).padding(2.dp)) {
                        expandRows(ui).forEachIndexed { i, row ->
                            if (i > 0) Box(Modifier.fillMaxWidth().height(2.dp).background(Color(0xFFE2CB93)))
                            StatDeltaRow(StatDeltaUi(row.icon, row.label, row.now, row.after))
                        }
                    }
                    if (ui.sizeNext != null) PkwText("Each tree or rock you clear gives Shards once.", PkwTokens.Type.small, color = c.textOnParch2)
                    if (ui.sizeNext != null) PkwText("Your buildings stay in place. Recorded on your land deed.", PkwTokens.Type.small, color = c.textOnParch2, maxLines = 3)
                    ui.asOf?.let { PkwText("as of $it", PkwTokens.Type.small, color = c.textOnParch2) }
                    ExpandFooter(ui, kind, on)
                }
            }
        }
    }
}

/** The charcoal header: the land well (layout icon at 72 on current grass) + "1 OF 6"; the title plate + close; the line
 *  and the Keep tag. */
@Composable private fun ExpandHeader(ui: ExpandUi, on: ExpandActions) {
    val c = PkwTokens.Colors
    val tag = expandKeepTag(ui)
    Plate(PlateKind.CHARCOAL, Modifier.fillMaxWidth(), blocksScene = false) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(112.dp).background(c.ink).padding(2.dp).background(WELL_GRASS).clipToBounds()
                .clearAndSetSemantics { contentDescription = "Land expansion ${expandIndexTag(ui.index, ui.max)}" }) {
                PkwIcon("layout", 72.dp, Modifier.align(Alignment.Center).offset(y = (-8).dp))
                Tag(expandIndexTag(ui.index, ui.max), Verb.STONE, Modifier.align(Alignment.BottomCenter).padding(bottom = 4.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    SheetTitlePlate("EXPAND LAND", Modifier.weight(1f))
                    CloseSquare(on.onClose)
                }
                PkwText(if (ui.sizeNext == null) "Your land is full size (${ui.sizeNow}×${ui.sizeNow})." else ui.growthLine ?: "Your land grows one tile on every side.",
                    PkwTokens.Type.body, color = c.text, maxLines = 2)
                if (tag.met) Tag(tag.text, Verb.GREEN)
                else PkwText(tag.text, PkwTokens.Type.small, color = c.gold.hi)
            }
        }
    }
}

/** The footer per [expandPrimary]: SOL pill + gold EXPAND; the locked padlock + GO KEEP UPGRADE; the money sequence;
 *  "Being checked" + CHECK; off states with their reasons; nothing at full size; then the stone DETAILS recovery door
 *  whenever a saved purchase needs it. */
internal fun expandTestOnlyVisible(ui: ExpandUi, kind: ExpandPrimaryKind): Boolean = ui.testExpansion && kind == ExpandPrimaryKind.EXPAND

@Composable private fun ExpandFooter(ui: ExpandUi, kind: ExpandPrimaryKind, on: ExpandActions) {
    val c = PkwTokens.Colors
    val h = Modifier.heightIn(min = PkwTokens.Dims.sheetPrimaryH)
    val req = ui.reqKeepLevel
    when (kind) {
        ExpandPrimaryKind.HIDDEN -> Unit
        ExpandPrimaryKind.LOCKED -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton("EXPAND", { on.onExplain("Needs Keep Lv $req") }, Modifier.weight(1f).then(h), state = CommandState.LOCKED,
                reason = "Needs Keep Lv $req")
            SecondaryButton("KEEP UPGRADE", on.onKeepUpgrade, Modifier.weight(1f).heightIn(min = PkwTokens.Dims.sheetPrimaryH), verb = Verb.BLUE,
                icon = "ui_portrait_keep_t3")
        }
        ExpandPrimaryKind.MONEY -> MoneyButton(ui.saved?.stage ?: MoneyStage.READY, "EXPAND", on.onRetry, Modifier.fillMaxWidth())
        ExpandPrimaryKind.CHECK -> PrimaryButton("CHECK", on.onCheck, Modifier.fillMaxWidth().then(h), verb = Verb.STONE,
            sub = "$BEING_CHECKED · the land grows when the realm confirms it")
        else -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val short = kind == ExpandPrimaryKind.NEED_MORE
            if (expandTestOnlyVisible(ui, kind)) Tag("FREE · TEST ONLY", Verb.STONE)
            else if (!ui.testExpansion) PriceChip(ui.price, Modifier.heightIn(min = 30.dp), onClick = if (short) on.onNeedMore else null)
            Column(Modifier.weight(1f)) {
                when (kind) {
                    ExpandPrimaryKind.EXPAND -> PrimaryButton("EXPAND", on.onExpand, Modifier.fillMaxWidth().then(h), sub = ui.reviewHint ?: "you confirm in the Seal")
                    ExpandPrimaryKind.NEED_MORE -> PrimaryButton("EXPAND", on.onNeedMore, Modifier.fillMaxWidth().then(h), state = CommandState.SHORT,
                        sub = "needs more SOL")
                    ExpandPrimaryKind.UNAVAILABLE -> PrimaryButton("EXPAND", { on.onExplain("Expansion price unavailable") }, Modifier.fillMaxWidth().then(h),
                        state = CommandState.DISABLED, reason = "Expansion price unavailable")
                    else -> PrimaryButton("EXPAND", { on.onExplain(ui.readOnly ?: "") }, Modifier.fillMaxWidth().then(h),
                        state = CommandState.DISABLED, reason = ui.readOnly)
                }
            }
        }
    }
    if (expandTestOnlyVisible(ui, kind)) PkwText("This test kingdom expands for free. No SOL payment or wallet approval is needed.",
        PkwTokens.Type.small, color = c.textOnParch2)
    if (kind == ExpandPrimaryKind.NEED_MORE) PkwText("Add SOL in Profile › WALLET", PkwTokens.Type.small, color = c.textOnParch2)
    if (ui.recovery) SecondaryButton("DETAILS", on.onDetails, Modifier.fillMaxWidth())
}

// ---- Previews ----

private val sampleExpand = ExpandUi(index = 0, max = 6, sizeNow = 14, sizeNext = 16, newTiles = null, obstaclesInRing = 9, reqKeepLevel = 12,
    keepLevel = 12, price = PriceUi(Currency.SOL, "0.15", PriceStatus.OK), nextReqKeepLevel = 14, ring = RectTiles(-1, -1, 16, 16), saved = null)
private val previewActions = ExpandActions(onExpand = {}, onSealConfirm = {}, onRetry = {}, onCheck = {}, onClose = {}, onFlyToRing = {})

@Preview(name = "Expand: default (keep-expand.png)", widthDp = 412, heightDp = 915)
@Composable private fun ExpandDefaultPreview() = HalfSheetPreviewFrame { KeepExpandSheet(sampleExpand, previewActions, it) }

@Preview(name = "Expand: full size (empty)", widthDp = 412, heightDp = 915)
@Composable private fun ExpandFullPreview() = HalfSheetPreviewFrame {
    KeepExpandSheet(sampleExpand.copy(index = 6, sizeNow = 26, sizeNext = null, obstaclesInRing = null, nextReqKeepLevel = null), previewActions, it)
}

@Preview(name = "Expand: locked (Keep too low), price checking, unknown obstacles", widthDp = 824, heightDp = 915)
@Composable private fun ExpandLockedPreview() {
    Row {
        Box(Modifier.width(412.dp)) { HalfSheetPreviewFrame { KeepExpandSheet(sampleExpand.copy(index = 1, keepLevel = 11, reqKeepLevel = 14,
            sizeNow = 16, sizeNext = 18), previewActions, it) } }
        Box(Modifier.width(412.dp)) { HalfSheetPreviewFrame { KeepExpandSheet(sampleExpand.copy(price = PriceUi(Currency.SOL, null, PriceStatus.CHECKING),
            obstaclesInRing = null, loading = true), previewActions, it) } }
    }
}

@Preview(name = "Expand: unavailable, SOL short, error as-of", widthDp = 1236, heightDp = 915)
@Composable private fun ExpandOffPreview() {
    Row {
        Box(Modifier.width(412.dp)) { HalfSheetPreviewFrame { KeepExpandSheet(sampleExpand.copy(price = PriceUi(Currency.SOL, null, PriceStatus.UNAVAILABLE)), previewActions, it) } }
        Box(Modifier.width(412.dp)) { HalfSheetPreviewFrame { KeepExpandSheet(sampleExpand.copy(price = PriceUi(Currency.SOL, "0.15", PriceStatus.SHORT)), previewActions, it) } }
        Box(Modifier.width(412.dp)) { HalfSheetPreviewFrame { KeepExpandSheet(sampleExpand.copy(asOf = "14:20"), previewActions, it) } }
    }
}

@Preview(name = "Expand: sending, being checked, read-only", widthDp = 1236, heightDp = 915)
@Composable private fun ExpandMoneyPreview() {
    Row {
        Box(Modifier.width(412.dp)) { HalfSheetPreviewFrame { KeepExpandSheet(sampleExpand.copy(saved = MoneyOp(MoneyStage.SENDING)), previewActions, it) } }
        Box(Modifier.width(412.dp)) { HalfSheetPreviewFrame { KeepExpandSheet(sampleExpand.copy(saved = MoneyOp(MoneyStage.SENDING, uncertain = true)), previewActions, it) } }
        Box(Modifier.width(412.dp)) { HalfSheetPreviewFrame { KeepExpandSheet(sampleExpand.copy(readOnly = "No land deed on this account"), previewActions, it) } }
    }
}
