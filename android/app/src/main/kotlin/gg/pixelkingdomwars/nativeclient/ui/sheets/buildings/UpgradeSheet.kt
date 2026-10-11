@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyName
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay

/*
 * Design component: the UPGRADE half sheet (design/final/buildings/SPEC.md §2, upgrade.png, upgrade-short.png) and the new
 * `StatDeltaRow` (SPEC §0). One calm card: tier art now → next, what improves, cost / time / builder, one green primary.
 */

/** One "what improves" row (SPEC §2.1 `StatDeltaRow`). */
@Immutable data class StatDeltaUi(
    /** 64 px Phase E art (`ui:…`, drawn at 32 dp) or 24 px art (drawn at 24 dp). */
    val icon: String,
    /** VT label ("Craft queue"). */
    val label: String,
    /** The value now ("2", "-10%"); null draws no old value and no arrow. */
    val old: String?,
    /** The value after the upgrade ("3", "-15%"); null draws "…". Ignored when [unlock]. */
    val new: String?,
    /** True: the row ends in a gold UNLOCK tag instead of numbers (a recipe, a feature). */
    val unlock: Boolean = false,
)

/** The best place to earn what is short (SPEC §2.1 "Mines hold 8,400", from the server). */
@Immutable data class DoorUi(
    /** The VT sub-line under GET SHARDS ("Mines hold 8,400"). */
    val label: String,
    /** The registry row of that place. SPEC types this as `Destination`, which does not exist in the code yet
     *  (features/Destination.kt is Codex's); a [FeatureId] is what every kit door carries. Informational here: the GET
     *  button calls [UpgradeActions.onGetMore], which pushes Need-more, and Need-more offers this door. */
    val destination: FeatureId,
)

/** The sheet's state (SPEC §2.2 + [VERIFYING] from DESIGN CORRECTION 7). */
enum class UpgradeState {
    /** Can upgrade now: green UPGRADE. */
    READY,
    /** The price is not known yet: "…" pill, stone + dots primary; nothing can be sent. */
    CHECKING,
    /** Not enough of the price's currency: shortfall line, off UPGRADE, blue GET <CURRENCY>. */
    SHORT,
    /** No free builder: off UPGRADE + stone BUILDERS "Free in …". */
    NO_BUILDER,
    /** The upgrade request is out: stone + dots "Starting…"; close is held for at most 0.5 s. */
    BUSY,
    /** Max level: normally the sheet is not opened (UPGRADE is hidden on the bar); drawn as off with a reason. */
    MAX,
    /** A read-only base: off with [UpgradeSheetUi.reason] (the herald's words). */
    READ_ONLY,
    /** The server refused or failed: back to the READY look so the player may retry; the error toast is the OverlayHost's
     *  and its words come from `failureLine` (only an authoritative refusal says nothing was spent). */
    ERROR,
    /** The answer was lost (timeout): stone + dots "Checking the upgrade" + Report; never re-sendable until the server
     *  says what happened. [UpgradeSheetUi.reason] may carry the sentence. */
    VERIFYING,
}

/** Everything the UPGRADE sheet draws (SPEC §2.2). Every number arrives formatted; unknown is "…", never "0". */
@Immutable data class UpgradeSheetUi(
    /** The building's id (keys the art fade and the badge pop). */
    val buildingId: String,
    /** The building name on the title plate ("WORKSHOP"). */
    val name: String,
    /** The current level tag ("LV 2"), blue. */
    val levelFrom: String,
    /** The next level tag ("LV 3"), green. */
    val levelTo: String,
    /** The current tier art (112 px; `ui:workshop-t2-idle`, or an existing GameArt name for ordinary buildings). */
    val artNow: String,
    /** The next tier art; the same as [artNow] when the look does not change. */
    val artNext: String,
    /** True only when the tier art changes (tier 1..4): the gold NEW LOOK badge on the next well. */
    val newLook: Boolean,
    /** What improves, 2-4 rows (more fold into "+n more"). */
    val rows: List<StatDeltaUi>,
    /** The upgrade price (status CHECKING / UNAVAILABLE / SHORT as the server says). */
    val price: PriceUi,
    /** The build time ("4h", "…"). */
    val time: String,
    /** Builders ("1/2 free"). */
    val builders: String,
    /** The sheet state. */
    val state: UpgradeState,
    /** SHORT: how much more is needed ("12,400"); null otherwise. */
    val shortfall: String?,
    /** SHORT: the best place to earn it (the GET button's sub-line); null draws no sub-line. */
    val bestDoor: DoorUi?,
    /** NO_BUILDER: when the next builder frees up ("2h 14m"). */
    val builderFreeIn: String?,
    /** READ_ONLY / MAX / VERIFYING: the one-line reason; ignored otherwise. */
    val reason: String?,
    /** A SOL step's SOL part (the chip beside the Shards chip; UNAVAILABLE when the catalogue has no amount). Non-null
     *  makes the primary open the SOL Seal (the consent) instead of sending a Shards order. */
    val solPrice: PriceUi? = null,
)

/** The primary's sub-line on a SOL step: the Seal reviews and confirms the payment, this sheet never pays. */
internal const val PAID_STEP_SUB = "Paid step · review before paying"

/** The sheet's callbacks (SPEC §2.2, plus [onReport] for the VERIFYING recovery link). */
class UpgradeActions(
    /** Sends the upgrade order. Only called when `upgradePrimaryLook(...).sends`. */
    val onUpgrade: () -> Unit,
    /** Opens Need-more for this currency (GET SHARDS, or a tap on the off UPGRADE while short). Never spends. */
    val onGetMore: (Currency) -> Unit,
    /** Opens the Builders half sheet (BUILDERS, the builder chip, the off UPGRADE while no builder is free). */
    val onBuilders: () -> Unit,
    /** Closes the sheet (red close, Back). */
    val onClose: () -> Unit,
    /** VERIFYING: the "Report" link (the recovery surface stays while the server is asked). */
    val onReport: () -> Unit = {},
)

/** The art fades in this long after the sheet's slide (SPEC §2.4: "wells' art fades in 120 ms after"). */
private const val ART_FADE_MS = 120
/** The NEW LOOK badge pops at +200 ms (SPEC §2.4). */
private const val NEW_LOOK_DELAY_MS = 200L
/** BUSY holds the close button for at most 0.5 s (SPEC §2.3). */
private const val BUSY_CLOSE_HOLD_MS = 500L

/**
 * The UPGRADE half sheet (upgrade.png): title plate "NAME LV 2 ▸ LV 3" + red close; on parchment the two tier wells (NOW,
 * next with gold rim and NEW LOOK), what improves, the cost / time / builder chips, and one primary row that follows
 * [upgradePrimaryLook]. SHORT (upgrade-short.png) replaces the chips with the red pill + "Need 12,400 more Shards" and the
 * primary with off UPGRADE + blue GET SHARDS. The host (SheetHost) places it from y 452 to the bottom, left / right 4,
 * slides it up in 180 ms and out in 140 ms; the wells' art fades in 120 ms after the slide and NEW LOOK pops at +200 ms.
 *
 * Pointer rule: a HALF sheet has NO scrim. This composable is one painted wood panel (a scene-input region, via the kit's
 * Plate) and only its buttons take taps; everything above it is the live kingdom, which the host lets close the sheet from
 * the scene's own tap. Nothing here is full-screen, clickable on empty space, or a pointerInput root.
 */
@Composable fun UpgradeSheet(ui: UpgradeSheetUi, on: UpgradeActions, modifier: Modifier = Modifier) {
    val still = LocalInspectionMode.current
    val look = upgradePrimaryLook(ui.state, ui.price, ui.reason)
    val artAlpha = remember(ui.buildingId) { Animatable(if (still) 1f else 0f) }
    var newLookShown by remember(ui.buildingId) { mutableStateOf(still) }
    LaunchedEffect(ui.buildingId) {
        delay(PkwTokens.Motion.HALF_SHEET_IN.toLong())
        artAlpha.animateTo(1f, tween(ART_FADE_MS, easing = PkwTokens.Motion.Out))
    }
    LaunchedEffect(ui.buildingId) { delay(NEW_LOOK_DELAY_MS); newLookShown = true }
    var closeHeld by remember { mutableStateOf(false) }
    LaunchedEffect(ui.state == UpgradeState.BUSY) {
        if (ui.state == UpgradeState.BUSY) { closeHeld = true; delay(BUSY_CLOSE_HOLD_MS) }
        closeHeld = false
    }

    Plate(PlateKind.WOOD, modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                LevelTitlePlate(ui.name, ui.levelFrom, ui.levelTo, Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                IconSquare("shape:close", Verb.RED, on.onClose, "Close", enabled = !closeHeld)
            }
            Spacer(Modifier.height(6.dp))
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), contentPadding = PaddingValues(8.dp), blocksScene = false) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    CompareRow(ui, { artAlpha.value }, newLookShown && ui.newLook)
                    if (ui.rows.isNotEmpty()) StatList(ui.rows)
                    PriceRow(ui, look)
                    PrimaryRow(ui, look, on)
                }
            }
        }
    }
}

/** The charcoal title plate: name, blue "LV 2", gold step arrow, green "LV 3". */
@Composable private fun LevelTitlePlate(name: String, from: String, to: String, modifier: Modifier) {
    Plate(PlateKind.CHARCOAL, modifier.heightIn(min = 44.dp).semantics(mergeDescendants = true) {
        heading(); contentDescription = "$name, level $from to $to"
    }, blocksScene = false) {
        Row(Modifier.align(Alignment.CenterStart).padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwText(name, PkwTokens.Type.title, Modifier.weight(1f, fill = false), color = PkwTokens.Colors.gold.hi, outline = 1.dp)
            Tag(from, Verb.BLUE)
            StepArrow(12.dp, 14.dp)
            Tag(to, Verb.GREEN)
        }
    }
}

/** NOW well → step arrow → next well (118 tall). */
@Composable private fun CompareRow(ui: UpgradeSheetUi, artAlpha: () -> Float, showNewLook: Boolean) {
    Row(Modifier.fillMaxWidth().height(118.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TierWell(ui.artNow, "NOW", Verb.STONE, gold = false, artAlpha, "${ui.name} now, ${ui.levelFrom}", Modifier.weight(1f))
        StepArrow(24.dp, 28.dp)
        Box(Modifier.weight(1f).fillMaxHeight()) {
            TierWell(ui.artNext, ui.levelTo, Verb.GREEN, gold = true, artAlpha,
                listOfNotNull("${ui.name} after the upgrade, ${ui.levelTo}", if (ui.newLook) "new look" else null).joinToString(", "),
                Modifier.fillMaxSize())
            if (showNewLook) Badge(BadgeUi("NEW LOOK", BadgeTone.REWARD, "New look"),
                Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-10).dp))
        }
    }
}

@Composable private fun TierWell(art: String, tag: String, tagVerb: Verb, gold: Boolean, artAlpha: () -> Float, spoken: String, modifier: Modifier) {
    Box(modifier.fillMaxHeight().clipToBounds().drawBehind { drawGrassWell(goldRim = gold) }
        .clearAndSetSemantics { contentDescription = spoken }) {
        BuildingArt(art, 112.dp, Modifier.align(Alignment.Center).graphicsLayer { alpha = artAlpha() })
        Tag(tag, tagVerb, Modifier.align(Alignment.TopStart).padding(start = 4.dp, top = 4.dp))
    }
}

/** What improves: a cream list with 2 dp ink border, 36 dp rows, 2 dp dividers, at most 4 rows + "+n more" in place. */
@Composable private fun StatList(rows: List<StatDeltaUi>) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val folded = foldRows(rows, expanded)
    Column(Modifier.fillMaxWidth().background(PkwTokens.Colors.cream).border(2.dp, PkwTokens.Colors.ink).padding(2.dp)) {
        folded.shown.forEachIndexed { index, row ->
            if (index > 0) Box(Modifier.fillMaxWidth().height(2.dp).background(DIVIDER))
            StatDeltaRow(row)
        }
        if (folded.hidden > 0) {
            Box(Modifier.fillMaxWidth().height(2.dp).background(DIVIDER))
            QuietButton("+${folded.hidden} more", { expanded = true }, Modifier.fillMaxWidth(), onParchment = true,
                contentDescription = "Show ${folded.hidden} more improvements")
        }
    }
}

/** The 2 dp row divider of the improves list (SPEC §2.1 `#E2CB93`). */
private val DIVIDER = Color(0xFFE2CB93)

/** 64 px Phase E art at 32 dp, 24 px art at 24 dp (KIT-API rule 4). */
private fun rowIconSize(icon: String): Dp = if (icon.startsWith("ui:") || icon.startsWith("pkw_ui_")) 32.dp else 24.dp

/** One `StatDeltaRow` (36 tall): icon, VT label, then "old ▸ new" (new in deep green) or a gold UNLOCK tag. */
@Composable fun StatDeltaRow(ui: StatDeltaUi, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    val spoken = when {
        ui.unlock -> "${ui.label}: unlocks"
        ui.old != null -> "${ui.label}: ${ui.old} to ${ui.new ?: UNKNOWN}"
        else -> "${ui.label}: ${ui.new ?: UNKNOWN}"
    }
    Row(modifier.fillMaxWidth().heightIn(min = 36.dp).padding(horizontal = 6.dp).clearAndSetSemantics { contentDescription = spoken },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.width(32.dp), contentAlignment = Alignment.Center) { PkwIcon(ui.icon, rowIconSize(ui.icon)) }
        PkwText(ui.label, PkwTokens.Type.body, Modifier.weight(1f), color = c.textOnParch)
        if (ui.unlock) Tag("UNLOCK", Verb.GOLD)
        else {
            if (ui.old != null) {
                PkwText(ui.old, PkwTokens.Type.caption, color = c.textOnParch2)
                StepArrow(10.dp, 12.dp, color = c.textOnParch2)
            }
            PkwText(ui.new ?: UNKNOWN, PkwTokens.Type.label, color = c.green.lo)
        }
    }
}

/** Cost / time / builder chips, or (SHORT) the red pill + "Need 12,400 more Shards". */
@Composable private fun PriceRow(ui: UpgradeSheetUi, look: UpgradePrimaryLook) {
    val c = PkwTokens.Colors
    if (look.kind == UpgradePrimaryKind.NEED_MORE) {
        val short = if (ui.price.status == PriceStatus.OK) ui.price.copy(status = PriceStatus.SHORT) else ui.price
        val currency = currencyName(ui.price.currency)
        val need = ui.shortfall ?: UNKNOWN
        Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = "Need $need more $currency" },
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PriceChip(short, Modifier.heightIn(min = 30.dp))
            PkwText("Need ", PkwTokens.Type.body, color = c.shortText)
            PkwText(need, PkwTokens.Type.label, color = c.shortText)
            PkwText(" more $currency", PkwTokens.Type.body, Modifier.weight(1f), color = c.shortText)
        }
        return
    }
    // A SOL step carries four chips (Shards, SOL, time, builders): they wrap rather than clip at 412 dp.
    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        PriceChip(ui.price, Modifier.heightIn(min = 30.dp))
        ui.solPrice?.let { PriceChip(it, Modifier.heightIn(min = 30.dp)) }
        CreamChip("timer", 24.dp, ui.time, "Takes ${ui.time}")
        CreamChip("builder", 30.dp, ui.builders, "Builders ${ui.builders}")
    }
}

/** A 30 dp cream chip (ink S rim, cream body): icon + PS caption. Not clickable. */
@Composable private fun CreamChip(icon: String, iconSize: Dp, text: String, spoken: String) {
    Row(Modifier.heightIn(min = 30.dp).drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 2.dp.toPx()
        fillStepped(i, i, size.width - i, size.height - i, CornerProfiles.S, PkwTokens.Colors.cream)
    }.padding(start = 3.dp, end = 7.dp).clearAndSetSemantics { contentDescription = spoken },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        PkwIcon(icon, iconSize)
        PkwText(text, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
    }
}

/** The primary row (SPEC §2.1 / §2.3). */
@Composable private fun PrimaryRow(ui: UpgradeSheetUi, look: UpgradePrimaryLook, on: UpgradeActions) {
    val c = PkwTokens.Colors
    // SPEC says 62 tall; the kit's sheet primary is 60 (TOKENS `sheetPrimaryH`), and both halves of a split row must match.
    val primaryH = Modifier.heightIn(min = PkwTokens.Dims.sheetPrimaryH)
    when (look.kind) {
        UpgradePrimaryKind.UPGRADE -> PrimaryButton("UPGRADE", on.onUpgrade, Modifier.fillMaxWidth().then(primaryH), verb = Verb.GREEN,
            sub = if (ui.solPrice != null) PAID_STEP_SUB else "Uses 1 builder for ${ui.time}")
        UpgradePrimaryKind.WAIT_PRICE -> PrimaryButton("Checking the price", {}, Modifier.fillMaxWidth().then(primaryH), state = CommandState.BUSY)
        UpgradePrimaryKind.STARTING -> PrimaryButton("Starting…", {}, Modifier.fillMaxWidth().then(primaryH), state = CommandState.BUSY)
        UpgradePrimaryKind.VERIFYING -> Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            PrimaryButton("Checking the upgrade", {}, Modifier.fillMaxWidth().then(primaryH), state = CommandState.BUSY)
            look.reason?.let { PkwText(it, PkwTokens.Type.small, Modifier.padding(top = 3.dp), color = c.textOnParch2, textAlign = TextAlign.Center, maxLines = 2) }
            QuietButton("Report", on.onReport, onParchment = true, contentDescription = "Report a problem with this upgrade")
        }
        UpgradePrimaryKind.OFF -> PrimaryButton("UPGRADE", {}, Modifier.fillMaxWidth().then(primaryH), verb = Verb.GREEN,
            state = CommandState.DISABLED, reason = look.reason)
        UpgradePrimaryKind.NEED_MORE -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val currency = ui.price.currency
            PrimaryButton("UPGRADE", { on.onGetMore(currency) }, Modifier.width(118.dp).then(primaryH), verb = Verb.GREEN,
                sub = "needs ${currencyName(currency)}", state = CommandState.DISABLED)
            DoorButton(icon = currencyIcon(currency, ui.price.icon), label = "GET ${currencyName(currency).uppercase()}",
                sub = ui.bestDoor?.label, verb = Verb.BLUE, onClick = { on.onGetMore(currency) },
                spoken = listOfNotNull("Get more ${currencyName(currency)}", ui.bestDoor?.label).joinToString(". "),
                modifier = Modifier.weight(1f).then(primaryH))
        }
        UpgradePrimaryKind.NEED_BUILDER -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton("UPGRADE", on.onBuilders, Modifier.width(118.dp).then(primaryH), verb = Verb.GREEN,
                sub = "needs a builder", state = CommandState.DISABLED)
            DoorButton(icon = "builder", label = "BUILDERS", sub = ui.builderFreeIn?.let { "Free in $it" }, verb = Verb.STONE,
                onClick = on.onBuilders, spoken = listOfNotNull("Builders", ui.builderFreeIn?.let { "next free in $it" }).joinToString(", "),
                modifier = Modifier.weight(1f).then(primaryH))
        }
    }
}

/** A flex chunky button with a 36 dp icon, a PS label and a VT sub-line (GET SHARDS, BUILDERS). */
@Composable private fun DoorButton(icon: String, label: String, sub: String?, verb: Verb, onClick: () -> Unit, spoken: String, modifier: Modifier) {
    ChunkyBox(PkwTokens.ramp(verb), onClick, spoken, modifier) {
        Row(Modifier.padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PkwIcon(icon, 36.dp)
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                PkwText(label, PkwTokens.Type.primary, color = PkwTokens.Colors.label, outline = 2.dp)
                if (sub != null) PkwText(sub, PkwTokens.Type.small, color = PkwTokens.Colors.text)
            }
        }
    }
}

// ---- Previews (sample data only; the real Ui comes from Codex's mapper) ----

private val sampleRows = listOf(
    StatDeltaUi("timer", "Craft queue", "2", "3"),
    StatDeltaUi("ui:workshop-menu", "Refine time", "-10%", "-15%"),
    StatDeltaUi("ui:market-menu", "Cosmetics recipes", null, null, unlock = true),
)

private val sampleUpgrade = UpgradeSheetUi(
    buildingId = "workshop-1", name = "WORKSHOP", levelFrom = "LV 2", levelTo = "LV 3",
    artNow = "ui:workshop-t2-idle", artNext = "ui:workshop-t3-idle", newLook = true, rows = sampleRows,
    price = PriceUi(Currency.SHARDS, "40,000", PriceStatus.OK), time = "4h", builders = "1/2 free",
    state = UpgradeState.READY, shortfall = null, bestDoor = null, builderFreeIn = null, reason = null,
)

private val previewActions = UpgradeActions(onUpgrade = {}, onGetMore = {}, onBuilders = {}, onClose = {})

@Composable private fun UpgradePreviewFrame(ui: UpgradeSheetUi) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35)), contentAlignment = Alignment.BottomCenter) {
        UpgradeSheet(ui, previewActions, Modifier.padding(horizontal = 4.dp))
    }
}

@Preview(name = "Upgrade: ready (upgrade.png)", widthDp = 412, heightDp = 915)
@Composable private fun UpgradeReadyPreview() = UpgradePreviewFrame(sampleUpgrade)

@Preview(name = "Upgrade: short (upgrade-short.png)", widthDp = 412, heightDp = 915)
@Composable private fun UpgradeShortPreview() = UpgradePreviewFrame(sampleUpgrade.copy(state = UpgradeState.SHORT,
    price = PriceUi(Currency.SHARDS, "40,000", PriceStatus.SHORT), shortfall = "12,400",
    bestDoor = DoorUi("Mines hold 8,400", FeatureId("mine.collect"))))

@Preview(name = "Upgrade: SOL step (UPGRADE opens the Seal)", widthDp = 412, heightDp = 915)
@Composable private fun UpgradeSolStepPreview() = UpgradePreviewFrame(sampleUpgrade.copy(solPrice = PriceUi(Currency.SOL, "0.5", PriceStatus.OK)))

@Preview(name = "Upgrade: checking price (loading keeps the last view)", widthDp = 412, heightDp = 915)
@Composable private fun UpgradeCheckingPreview() = UpgradePreviewFrame(sampleUpgrade.copy(state = UpgradeState.CHECKING,
    price = PriceUi(Currency.SHARDS, null, PriceStatus.CHECKING), time = UNKNOWN))

@Preview(name = "Upgrade: no builder", widthDp = 412, heightDp = 915)
@Composable private fun UpgradeNoBuilderPreview() = UpgradePreviewFrame(sampleUpgrade.copy(state = UpgradeState.NO_BUILDER,
    builders = "0/2 free", builderFreeIn = "2h 14m"))

@Preview(name = "Upgrade: busy (request sent)", widthDp = 412, heightDp = 915)
@Composable private fun UpgradeBusyPreview() = UpgradePreviewFrame(sampleUpgrade.copy(state = UpgradeState.BUSY))

@Preview(name = "Upgrade: error (back to ready; toast is the host's)", widthDp = 412, heightDp = 915)
@Composable private fun UpgradeErrorPreview() = UpgradePreviewFrame(sampleUpgrade.copy(state = UpgradeState.ERROR))

@Preview(name = "Upgrade: answer lost, being checked", widthDp = 412, heightDp = 915)
@Composable private fun UpgradeVerifyingPreview() = UpgradePreviewFrame(sampleUpgrade.copy(state = UpgradeState.VERIFYING,
    reason = failureLine("upgrade", authoritative = false)))

@Preview(name = "Upgrade: read-only base (locked)", widthDp = 412, heightDp = 915)
@Composable private fun UpgradeReadOnlyPreview() = UpgradePreviewFrame(sampleUpgrade.copy(state = UpgradeState.READ_ONLY,
    reason = "Viewing another kingdom"))

@Preview(name = "Upgrade: same look, five rows, price unavailable", widthDp = 412, heightDp = 915)
@Composable private fun UpgradeManyRowsPreview() = UpgradePreviewFrame(sampleUpgrade.copy(artNext = "ui:workshop-t2-idle", newLook = false,
    rows = sampleRows + StatDeltaUi("shards", "Storage", "8,000", "12,000") + StatDeltaUi("timer", "Hit points", "900", "1,150"),
    price = PriceUi(Currency.SHARDS, null, PriceStatus.UNAVAILABLE)))

@Preview(name = "StatDeltaRow", widthDp = 380, heightDp = 140)
@Composable private fun StatDeltaRowPreview() {
    Column(Modifier.background(PkwTokens.Colors.cream).padding(4.dp)) { sampleRows.forEach { StatDeltaRow(it) } }
}
