package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay

/*
 * Design component: the Builders half sheet (design/final/buildings/SPEC.md R2.1, builders.png; registry row 3,
 * `Destination.Builders`): who is busy, on what, for how long; FINISH a job early (Gems Seal); BUILD with a free builder;
 * hire the next builder (SOL Seal).
 */

/** A builder slot's status (native RESTING maps to FREE; LOCKED / NEXT feed the hire line). */
enum class BuilderStatus { WORKING, FREE }

/** One owned builder (SPEC R2.1 `BuilderRowUi`). */
@Immutable data class BuilderRowUi(
    /** "BUILDER 1". */
    val number: Int,
    /** Working or free. */
    val status: BuilderStatus,
    /** The server job line: "Workshop · LV 2>3", "Building Lodge", "Clearing a rock"; null for a free builder. */
    val jobLine: String?,
    /** Time left ("1h 12m", "…"); working only. */
    val timeLeft: String?,
    /** Elapsed share 0..1 of the job; null = unknown (empty bar, never "0 % done"). */
    val progress: Float?,
    /** Queued behind another job: the bar is striped. */
    val queued: Boolean,
    /** The Gems finish price from the server (CHECKING = still tappable, the Seal shows "checking"). */
    val finish: PriceUi?,
    /** Where a tap on the row flies: `FocusBuilding(jobBuildingId)` (spec type `Destination`; the registry row here). */
    val focus: FeatureId?,
    /** FINISH was pressed and the Seal has not returned: stone + dots. */
    val busy: Boolean = false,
    /** A FINISH whose answer was lost: the job line reads "Being checked"; FINISH stays the recovery action. */
    val checking: Boolean = false,
    /** Replaces "BUILDER n" for a server job that holds no builder slot (it still rides in the same list, never a second
     *  panel); [number] then only keys the row. Null reads "BUILDER n". */
    val title: String? = null,
)

/** The hire offer (SPEC R2.1 `HireBuilderUi`). */
@Immutable data class HireBuilderUi(
    /** The builder number on offer ("HIRE BUILDER 4"). */
    val number: Int,
    /** SOL, from the server. */
    val price: PriceUi,
    /** "Builder 5 opens after 4."; null draws none. */
    val nextLockedLine: String?,
    /** The money sequence once the Seal is confirmed (READY until then). */
    val stage: MoneyStage = MoneyStage.READY,
    /** A hire whose answer was lost: "Being checked"; HIRE stays the recovery action. */
    val checking: Boolean = false,
    /** Why an off HIRE cannot open its Seal (a saved purchase to recover first, purchases paused), in the owner's words;
     *  null reads "Hire price unavailable". */
    val offReason: String? = null,
)

/** Everything the Builders sheet draws (SPEC R2.1 `BuildersSheetUi`). */
@Immutable data class BuildersSheetUi(
    /** Owned builders. */
    val owned: Int,
    /** Free builders. */
    val free: Int,
    /** Builder slots in the game. */
    val maximum: Int,
    /** One row per owned builder. Loading keeps the last good rows (times "…"); never zero rows. */
    val rows: List<BuilderRowUi>,
    /** The hire offer; null when every slot is owned, or the offer is missing ([hireLine] says which). */
    val hire: HireBuilderUi?,
    /** True while the list refreshes: the 2 dp stone line; values the mapper does not know read "…". */
    val loading: Boolean,
    /** The error toast is the OverlayHost's ("The builders list can't reach the server. Try again." + Report); this is
     *  only shown as a VT line under the rows while the last good rows stay. */
    val error: String?,
    /** With [hire] null: "All builder slots are yours." or "Hiring opens later" (locked). */
    val hireLine: String? = null,
    /** The VT 18 hint under the rows ("Tap a builder to fly to the job. Builder 4 is for hire. Hired builders stay for
     *  good."); [HireBuilderUi.nextLockedLine] is appended. */
    val hint: String = "Tap a builder to fly to the job.",
    /** A saved SOL purchase needs its recovery: the stone DETAILS door under the primary ([BuildersActions.onDetails]). */
    val recovery: Boolean = false,
)

/** Builders callbacks (SPEC R2.1). */
class BuildersActions(
    /** FINISH on a working row (builder number): raises the Finish-now Seal; a CHECKING price is navigation, the Seal
     *  re-quotes. */
    val onFinish: (Int) -> Unit,
    /** A tap anywhere else on a row: the camera flies 240 ms, selects the job's building; the sheet closes. */
    val onRow: (FeatureId) -> Unit,
    /** BUILD on a free row: `BuildShop()`. */
    val onBuild: () -> Unit,
    /** HIRE (and RETRY / recovery): raises the SOL money Seal; never pays on tap. */
    val onHire: () -> Unit,
    /** Red close / Back. */
    val onClose: () -> Unit,
    /** A SHORT FINISH (GEMS) or HIRE (SOL) pill: Need-more; never auto-spends. */
    val onNeedMore: (Currency) -> Unit = {},
    /** An UNAVAILABLE price: the host shows why (toast). */
    val onExplain: (String) -> Unit = {},
    /** The stone DETAILS door ([BuildersSheetUi.recovery]): the saved purchase's recovery screen. */
    val onDetails: () -> Unit = {},
)

/**
 * The Builders half sheet (builders.png): header "BUILDERS · 2 working · 1 free" + red close; one 76 dp `BuilderRow` per
 * owned builder (60 dp builder well, number + time left, job line, 14 dp job bar, green FINISH 84 × 56 with its gem
 * price; a free row is green-rimmed with a moss FREE tag and a blue BUILD 104 × 56); the hire line; the gold HIRE primary;
 * the stone DETAILS door only while a saved SOL purchase needs its recovery ([BuildersSheetUi.recovery]).
 * The host (SheetHost) places it from y 452 to the bottom and slides it in 180 ms `out` / out 140 ms `in`; rows fade in
 * with a 20 ms stagger; the resource stack stays visible (FINISH compares against Gems).
 *
 * Pointer rule: a HALF sheet has NO scrim. This composable is one painted wood panel (a scene-input region) whose only
 * touch targets are its cards and buttons; the live kingdom above it closes the sheet from the scene's own tap. Nothing
 * here is full-screen, clickable on empty space, a pointerInput root, a scrim or draggable.
 */
@Composable fun BuildersSheet(ui: BuildersSheetUi, on: BuildersActions, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    Plate(PlateKind.WOOD, modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            HalfSheetHeader("BUILDERS", on.onClose, icon = "builder", right = buildersHeaderLine(ui.owned, ui.free))
            Spacer(Modifier.height(6.dp))
            if (ui.loading) LoadingLine(Modifier.padding(bottom = 4.dp))
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), contentPadding = PaddingValues(8.dp), blocksScene = false) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ui.rows.forEachIndexed { index, row -> key(row.number) { StaggeredIn(index) { BuilderRow(row, on) } } }
                    ui.error?.let { PkwText(it, PkwTokens.Type.small, color = c.shortText, maxLines = 2) }
                    HireLine(ui)
                    HirePrimary(ui, on)
                    if (ui.recovery) SecondaryButton("DETAILS", on.onDetails, Modifier.fillMaxWidth())
                }
            }
        }
    }
}

/** Rows fade in with the drawer's 20 ms stagger (SPEC R2.1 motion); previews and reduced motion show them at once. */
@Composable private fun StaggeredIn(index: Int, content: @Composable () -> Unit) {
    val still = LocalReducedMotion.current || LocalInspectionMode.current
    val alpha = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (still) return@LaunchedEffect
        delay(index * PkwTokens.Motion.DRAWER_ROW_STAGGER.toLong())
        alpha.animateTo(1f, tween(PkwTokens.Motion.HALF_SHEET_IN, easing = PkwTokens.Motion.Out))
    }
    Box(Modifier.graphicsLayer { this.alpha = alpha.value }) { content() }
}

/** One `BuilderRow` (76 tall). The whole card flies to the job; FINISH / BUILD keep their own taps. */
@Composable private fun BuilderRow(row: BuilderRowUi, on: BuildersActions) {
    val c = PkwTokens.Colors
    val free = row.status == BuilderStatus.FREE
    val look = finishLook(row.finish, row.busy, row.checking)
    val job = when {
        free -> "Ready for a job"
        look.beingChecked -> BEING_CHECKED
        else -> row.jobLine ?: UNKNOWN
    }
    val title = row.title ?: "BUILDER ${row.number}"
    val spoken = listOfNotNull(title, if (free) "free" else row.timeLeft?.let { "$it left" }, job,
        row.focus?.let { "tap to fly to the job" }).joinToString(", ")
    val focus = row.focus
    TapCard(Modifier.fillMaxWidth().heightIn(min = 76.dp), body = if (free) c.selectedTint else null, rim = if (free) c.green.face else null,
        padding = PaddingValues(start = 6.dp, top = 5.dp, end = 6.dp, bottom = 8.dp),
        onClick = if (focus != null) ({ on.onRow(focus) }) else null, description = spoken) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(60.dp).background(c.ink).padding(2.dp).background(c.creamLo), contentAlignment = Alignment.Center) {
                PkwIcon("builder", 56.dp)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwText(title, PkwTokens.Type.label, color = c.textOnParch)
                    if (free) Tag("FREE", Verb.MOSS)
                    else PkwText(row.timeLeft ?: UNKNOWN, PkwTokens.Type.caption, color = c.gold.lo)
                }
                PkwText(job, PkwTokens.Type.body, color = if (look.beingChecked) c.textOnParch2 else c.textOnParch)
                if (!free) JobBar(row.progress, striped = row.queued)
            }
            if (free) ChunkyBox(c.blue, on.onBuild, "Build with builder ${row.number}", Modifier.size(104.dp, 56.dp)) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    PkwIcon("itm_hammer", 24.dp)
                    PkwText("BUILD", PkwTokens.Type.caption, color = c.label, outline = 1.dp)
                }
            } else FinishButton(row, look, on)
        }
    }
}

/** FINISH 84 × 56: PS 11 "FINISH" over gem 24 + the price; stone dots while busy; off when unavailable; SHORT routes to
 *  Need-more (GEMS). */
@Composable private fun FinishButton(row: BuilderRowUi, look: FinishLook, on: BuildersActions) {
    val c = PkwTokens.Colors
    val price = row.finish
    val verb = when (look.kind) { FinishKind.BUSY -> Verb.STONE; FinishKind.OFF -> Verb.OFF; else -> Verb.GREEN }
    val spoken = listOfNotNull("Finish builder ${row.number} now", price?.let(::priceDescription)).joinToString(". ")
    val tap = {
        when (look.kind) {
            FinishKind.FINISH -> on.onFinish(row.number)
            FinishKind.NEED_MORE -> on.onNeedMore(price?.currency ?: Currency.GEMS)
            FinishKind.OFF -> on.onExplain("The finish price is unavailable right now.")
            FinishKind.BUSY -> Unit
        }
    }
    ChunkyBox(PkwTokens.ramp(verb), tap, spoken, Modifier.size(84.dp, 56.dp), enabled = look.kind != FinishKind.BUSY) {
        if (look.kind == FinishKind.BUSY) BusyDots()
        else Column(horizontalAlignment = Alignment.CenterHorizontally) {
            PkwText("FINISH", PkwTokens.Type.caption, color = c.label, outline = 1.dp)
            if (price != null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                PkwIcon(currencyIcon(price.currency, price.icon), 24.dp)
                PkwText(priceText(price), PkwTokens.Type.caption,
                    color = if (price.status == PriceStatus.SHORT) c.shortPill else c.label, outline = 1.dp)
            }
        }
    }
}

/** The hire line: a dark 36 dp well with the builder grey at 45 %, then the VT 18 hint (+ the next-locked sentence). */
@Composable private fun HireLine(ui: BuildersSheetUi) {
    val c = PkwTokens.Colors
    val text = listOfNotNull(ui.hint, ui.hire?.let { "Builder ${it.number} is for hire. Hired builders stay for good." },
        ui.hire?.nextLockedLine, if (ui.hire == null) ui.hireLine else null).joinToString(" ")
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(36.dp).background(c.ink).padding(2.dp).background(c.surface), contentAlignment = Alignment.Center) {
            R2Art("builder", 30.dp, 30.dp, grey = 0.45f)
        }
        PkwText(text, PkwTokens.Type.small, Modifier.weight(1f), color = c.textOnParch2, maxLines = 3)
    }
}

/** The gold HIRE BUILDER n primary (60 tall): builder icon + PS 14 + VT "0.25 SOL once · paid from your wallet". It only
 *  raises the money Seal; after the Seal the kit's money sequence takes over. Hidden when every slot is owned. */
@Composable private fun HirePrimary(ui: BuildersSheetUi, on: BuildersActions) {
    val hire = ui.hire ?: return
    val label = "HIRE BUILDER ${hire.number}"
    val full = Modifier.fillMaxWidth()
    when (hireKind(hire.price, hire.stage, hire.checking)) {
        HireKind.HIRE -> PrimaryButton(label, on.onHire, full, icon = "builder", sub = hireSubLine(hire.price))
        HireKind.MONEY -> MoneyButton(hire.stage, label, on.onHire, full)
        HireKind.CHECKING -> PrimaryButton(BEING_CHECKED, on.onHire, full, verb = Verb.STONE, sub = "tap to check the hire again")
        HireKind.NEED_MORE -> PrimaryButton(label, { on.onNeedMore(hire.price.currency) }, full, icon = "builder",
            sub = hireSubLine(hire.price), state = CommandState.SHORT, price = hire.price, onPrice = { on.onNeedMore(hire.price.currency) })
        HireKind.OFF -> {
            val reason = hire.offReason ?: "Hire price unavailable"
            PrimaryButton(label, { on.onExplain(reason) }, full, state = CommandState.DISABLED, reason = reason)
        }
    }
}

// ---- Previews (sample data only; the real Ui comes from Codex's mapper) ----

private fun gems(amount: String?, status: PriceStatus = PriceStatus.OK) = PriceUi(Currency.GEMS, amount, status)

private val sampleRows = listOf(
    BuilderRowUi(1, BuilderStatus.WORKING, "Workshop · LV 2>3", "1h 12m", 0.68f, false, gems("38"), FeatureId("focus.workshop-1")),
    BuilderRowUi(2, BuilderStatus.WORKING, "Clearing a rock", "4m 10s", 0.3f, false, gems("2"), FeatureId("focus.rock-14")),
    BuilderRowUi(3, BuilderStatus.FREE, null, null, null, false, null, null),
)

private val sampleBuilders = BuildersSheetUi(owned = 3, free = 1, maximum = 5, rows = sampleRows,
    hire = HireBuilderUi(4, PriceUi(Currency.SOL, "0.25", PriceStatus.OK), "Builder 5 opens after 4."), loading = false, error = null)

private val previewActions = BuildersActions(onFinish = {}, onRow = {}, onBuild = {}, onHire = {}, onClose = {})

@Preview(name = "Builders: default (builders.png)", widthDp = 412, heightDp = 915)
@Composable private fun BuildersDefaultPreview() = HalfSheetPreviewFrame { BuildersSheet(sampleBuilders, previewActions, it) }

@Preview(name = "Builders: all free (empty) + all slots owned", widthDp = 412, heightDp = 915)
@Composable private fun BuildersEmptyPreview() = HalfSheetPreviewFrame {
    BuildersSheet(sampleBuilders.copy(owned = 2, free = 2, maximum = 2, hire = null, hireLine = "All builder slots are yours.",
        rows = listOf(sampleRows[2].copy(number = 1), sampleRows[2].copy(number = 2))), previewActions, it)
}

@Preview(name = "Builders: loading (prices checking, times …)", widthDp = 412, heightDp = 915)
@Composable private fun BuildersLoadingPreview() = HalfSheetPreviewFrame {
    BuildersSheet(sampleBuilders.copy(loading = true, rows = sampleRows.map { r ->
        if (r.status == BuilderStatus.WORKING) r.copy(timeLeft = UNKNOWN, finish = gems(null, PriceStatus.CHECKING)) else r },
        hire = sampleBuilders.hire?.copy(price = PriceUi(Currency.SOL, null, PriceStatus.CHECKING))), previewActions, it)
}

@Preview(name = "Builders: error keeps rows + hiring locked", widthDp = 412, heightDp = 915)
@Composable private fun BuildersErrorPreview() = HalfSheetPreviewFrame {
    BuildersSheet(sampleBuilders.copy(error = "Updated 2 min ago", hire = null, hireLine = "Hiring opens later"), previewActions, it)
}

@Preview(name = "Builders: busy FINISH, uncertain row, wallet check", widthDp = 412, heightDp = 915)
@Composable private fun BuildersBusyPreview() = HalfSheetPreviewFrame {
    BuildersSheet(sampleBuilders.copy(rows = listOf(sampleRows[0].copy(busy = true), sampleRows[1].copy(checking = true), sampleRows[2]),
        hire = sampleBuilders.hire?.copy(stage = MoneyStage.CHECK_WALLET)), previewActions, it)
}

@Preview(name = "Builders: short Gems, hire uncertain", widthDp = 412, heightDp = 915)
@Composable private fun BuildersShortPreview() = HalfSheetPreviewFrame {
    BuildersSheet(sampleBuilders.copy(rows = listOf(sampleRows[0].copy(finish = gems("38", PriceStatus.SHORT)), sampleRows[1].copy(queued = true), sampleRows[2]),
        hire = sampleBuilders.hire?.copy(checking = true)), previewActions, it)
}

@Preview(name = "Builder row widths", widthDp = 412, heightDp = 120)
@Composable private fun BuilderRowPreview() {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(8.dp)) { BuilderRow(sampleRows[0], previewActions); Spacer(Modifier.width(1.dp)) }
}
