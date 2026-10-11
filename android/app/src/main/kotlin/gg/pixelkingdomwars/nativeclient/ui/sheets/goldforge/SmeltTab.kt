package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.keyframes
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.drawChunky
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * Design component: the Gold Forge SMELT tab (design/final/goldforge/SPEC.md §3; `smelt.png`, `smelt-seal.png`,
 * `smelt-held.png`): today's furnace load, the Basket · Raid · Coins steps, the raid-day pips, the basket picker (tap
 * +1, hold = as much as fits, "− 1" take-back, a tile at the allowance shakes), the pinned basket value + SMELT, the
 * consent Seal ([SmeltSeal]) and the held / qualified progress view. Data: `/mining/contributions` through the existing
 * session-scoped `MiningContributionViewModel` (the mapper owns every number and the allowance maths).
 *
 * Pointer rule: the body and footer are plain layouts inside the sheet's painted parchment; only tiles, take-back
 * buttons, GO / primary buttons and the dismissible callout take touches. [SmeltSeal] is full-screen only while shown.
 */

/** Where SMELT stands (SPEC "SMELT: UI state"). An empty [SmeltUi.tiles] in CHOOSING is the "Nothing to smelt" state. */
enum class SmeltState { LOADING, CHOOSING, REVIEW, SENDING, HELD, QUALIFIED, PAUSED, NOT_READY, ERROR }

/** One step chip (SPEC §2 StepRow): "Basket" / "fill it now". */
@Immutable data class StepUi(val title: String, val small: String, val state: StepState)

/** The raid-day pips (SPEC §2 RaidDayPips): the last window's days, oldest first (true = a counted raid day). */
@Immutable data class RaidDaysUi(
    val days: List<Boolean>,
    /** Today's index in [days] (gold rim on the held view); null when today is not in the window. */
    val todayIndex: Int?,
    /** "+8%"; null hides the bonus. */
    val bonus: String?,
)

/** One basket tile (SPEC §2 ItemTile picker). */
@Immutable data class SmeltTileUi(
    val resourceId: String,
    /** 64 px item art (`craft:inv_crownsteel`, `gf:forge_ingot`) at 32 dp, or a 24 px currency (`shards`) at 36 dp. */
    val icon: String,
    /** What the player has, exactly as shown on the tile ("x6", "40.9K", "…"). */
    val have: String,
    /** Units in the basket. */
    val chosen: Int,
    /** "200" (worth per unit, already formatted). */
    val unitValue: String,
    /** Where it is earned ("Workshop"). */
    val source: String,
    /** Display name for the selected-info row and screen readers ("Crownsteel"). */
    val name: String = "",
    /** False when one more unit would pass today's allowance: a tap shakes the tile (the caller toasts "Today's
     *  allowance is full"); never a silent clamp. */
    val canAdd: Boolean = true,
)

/** The settlement callout shown once at the top of SMELT the next day (SPEC §3c "Later states"). */
@Immutable data class SmeltResultUi(
    /** True: "Yesterday's basket melted into KEEP" (moss, GO to CLAIM); false: "Yesterday's basket came back" (stone). */
    val melted: Boolean,
    val line: String = if (melted) "Yesterday's basket melted into KEEP" else "Yesterday's basket came back",
)

/** The SMELT consent Seal (SPEC §3b). Shown while the review is up (state REVIEW / SENDING). */
@Immutable data class SmeltSealUi(
    /** "7 items". */
    val items: String,
    /** The basket's worth, "1,800". */
    val worth: String,
    /** Up to two basket icons ([smeltSealIcons]). */
    val icons: List<String>,
    /** The consent box (the existing MINING_CONTRIBUTION_CONSENT gate). */
    val consent: Boolean,
    /** Wall-clock ms the seal was raised. Arming starts at the later of this and the consent tick ([consentArmStart]). */
    val armedAtMs: Long,
    /** The confirm was accepted and the server is answering: dots, BACK and the box locked. */
    val sending: Boolean = false,
    /** The consent line; legal / owner must accept this shorter paraphrase (SPEC §9), else pass the full sentence. */
    val consentText: String = "Yes, melt it if it mints coins",
    /** SPEC §9 fallback: the full existing legal sentence, drawn in the Seal body in place of the paraphrase. */
    val consentBody: String? = null,
    /** The existing risk sentence drawn under [consentBody]. */
    val riskLine: String? = null,
)

/** Everything the SMELT tab draws (SPEC "SMELT: UI state"; additions after [state] have defaults). */
@Immutable data class SmeltUi(
    /** The UTC day, shown without "UTC" ("2 Oct"). */
    val day: String,
    /** Server pool id: "free" / "deed" ([furnaceLabel]). */
    val pool: String,
    /** Committed today ("1,800"); "…" while unknown. */
    val committed: String,
    /** Today's cap ("5,000"); null = uncapped. */
    val cap: String?,
    /** The basket's worth ("1,800"); "…" while unknown. */
    val basketValue: String,
    /** 0..1 of the cap the basket adds (green stripes). */
    val basketFill: Float,
    /** 0..1 of the cap already committed (gold). */
    val committedFill: Float,
    /** Basket · Raid · Coins. */
    val steps: List<StepUi>,
    /** Null when the server sends no counted days. */
    val raidDays: RaidDaysUi?,
    /** Resources with stock > 0, ordered Gold Ingots, Shards, refined, raw. */
    val tiles: List<SmeltTileUi>,
    /** The last tapped tile (selected-info row). */
    val selected: SmeltTileUi?,
    /** The held basket (HELD / QUALIFIED). */
    val held: List<SmeltTileUi>?,
    /** "42" when the server gives an estimate; null otherwise. */
    val estimate: String?,
    /** SMELT / FIND A RAID / PAYOUT IN (build it with [smeltPrimaryCommand]). */
    val primary: CommandUi,
    /** The once-per-settlement callout. */
    val result: SmeltResultUi?,
    val state: SmeltState,
    /** The consent Seal while the review is up. */
    val seal: SmeltSealUi? = null,
)

/** SMELT callbacks (SPEC; the additions after [onRetry] have defaults). */
@Immutable data class SmeltActions(
    val onTile: (String) -> Unit = {},
    val onTileHold: (String) -> Unit = {},
    val onMinus: (String) -> Unit = {},
    val onSmelt: () -> Unit = {},
    val onConsent: (Boolean) -> Unit = {},
    val onConfirm: () -> Unit = {},
    val onBack: () -> Unit = {},
    val onFindRaid: () -> Unit = {},
    val onRetry: () -> Unit = {},
    /** Hold on "− 1": remove the whole line. */
    val onMinusHold: (String) -> Unit = {},
    /** The settlement callout's GO (switches to CLAIM). */
    val onResultGo: () -> Unit = {},
    /** A tap on the settlement callout. */
    val onResultDismiss: () -> Unit = {},
    /** Empty state's GO TO WORKSHOP. */
    val onGoWorkshop: () -> Unit = {},
    /** Not-ready's GoRow to the Build shop. */
    val onGoBuild: () -> Unit = {},
    /** Says why a tap did nothing (an off or locked primary, a refused tile); the host shows it in the toast zone. */
    val onExplain: (String) -> Unit = {},
)

/** The SMELT body (inside the sheet's parchment). */
@Composable fun SmeltBody(ui: SmeltUi, on: SmeltActions) {
    val c = PkwTokens.Colors
    val held = ui.state == SmeltState.HELD || ui.state == SmeltState.QUALIFIED
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val result = ui.result
        if (result != null && !held) CalloutRow(if (result.melted) "gf:keep_24" else "gf:forge_ingot", result.line, null,
            tint = if (result.melted) GoldForgeColors.stepDone else GoldForgeColors.stepTodo, onTap = on.onResultDismiss,
            go = if (result.melted) on.onResultGo else null, goDescription = "Go to CLAIM")
        SectionRow("TODAY'S MELT", right = "${furnaceLabel(ui.pool)} · ${ui.day}")
        val load = furnaceLoadText(ui.state, ui.committed, ui.basketValue, ui.cap)
        Row(Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = "Furnace load: ${load.basket ?: ""}${load.rest}" },
            verticalAlignment = Alignment.CenterVertically) {
            PkwText("Furnace load", PkwTokens.Type.body, color = c.textOnParch)
            Spacer(Modifier.weight(1f))
            load.basket?.let { PkwText(it, PkwTokens.Type.caption, color = GoldForgeColors.basketGreen) }
            PkwText(load.rest, PkwTokens.Type.caption, color = c.textOnParch)
        }
        val known = ui.state != SmeltState.LOADING
        ProgressBar(if (known) ui.committedFill else null, "Furnace load ${load.basket ?: ""}${load.rest}", verb = Verb.GOLD,
            pending = if (known && !held) (ui.committedFill + ui.basketFill).coerceAtMost(1f) else null, height = 16.dp)
        StepRow(ui.steps)
        if (held) HeldSection(ui) else ChoosingSection(ui, on)
    }
}

@Composable private fun ChoosingSection(ui: SmeltUi, on: SmeltActions) {
    val c = PkwTokens.Colors
    RaidDayPips(ui.raidDays)
    if (ui.state == SmeltState.CHOOSING && ui.tiles.isEmpty()) {
        ForgeEmpty("gf:forge_ingot", "Nothing to smelt yet", "Ingots are cast at the Workshop", goLabel = "GO TO WORKSHOP", onGo = on.onGoWorkshop)
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        PkwText("CHOOSE WHAT TO SMELT", PkwTokens.Type.label, color = c.textOnParch)
        PkwText("Tap = +1 · hold = as much as fits", PkwTokens.Type.small, color = c.textOnParch2)
    }
    when (ui.state) {
        SmeltState.ERROR -> SecondaryButton("TRY AGAIN", on.onRetry, Modifier.width(160.dp))
        SmeltState.LOADING -> LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(end = 8.dp)) {
            items(SKELETON_TILES) { SkeletonTile() }
        }
        else -> {
            val enabled = ui.state == SmeltState.CHOOSING
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(end = 8.dp)) {
                items(ui.tiles, key = { it.resourceId }) { tile ->
                    SmeltTile(tile, enabled, on, Modifier.alpha(if (ui.state == SmeltState.PAUSED) 0.6f else 1f))
                }
            }
        }
    }
    ui.selected?.let { sel ->
        Row(Modifier.fillMaxWidth().heightIn(min = 24.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GfIcon(sel.icon, tileIconDp(sel.icon).dp)
            PkwText(sel.name.ifBlank { sel.resourceId }, PkwTokens.Type.body, color = c.textOnParch)
            // The frame's "· Workshop" part only when the source is known; never a dangling separator.
            val source = if (sel.source.isBlank()) "" else " · ${sel.source}"
            PkwText("· worth ${sel.unitValue} each$source", PkwTokens.Type.small, Modifier.weight(1f), color = c.textOnParch2)
        }
    }
    if (ui.state == SmeltState.NOT_READY) GoRow("ui:workshop-menu", "Build the mining buildings", "in the Build shop", on.onGoBuild, "Open the Build shop")
}

@Composable private fun HeldSection(ui: SmeltUi) {
    SectionRow("IN THE FURNACE", tag = { Tag("HELD", Verb.MOSS) })
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        val (shown, more) = heldStrip(ui.held.orEmpty())
        shown.forEach { HeldTile(it.icon, "x${it.chosen}", "${it.name.ifBlank { it.resourceId }}, ${it.chosen} held") }
        if (more > 0) HeldTile(null, "+$more", "$more more held")
        EstimateCard(ui.estimate, Modifier.weight(1f))
    }
    if (ui.state == SmeltState.QUALIFIED) CalloutRow("shape:check", "Raid won. Your basket counts today.", null, tint = GoldForgeColors.stepDone)
    else CalloutRow("attack", "Win one raid before midnight", "or the basket comes back unused")
    RaidDayPips(ui.raidDays, todayRim = true)
}

/** The SMELT footer: basket value + SMELT, or FIND A RAID, or the payout plate; then the footnote. */
@Composable fun ColumnScope.SmeltFooter(ui: SmeltUi, on: SmeltActions) {
    val c = PkwTokens.Colors
    val held = ui.state == SmeltState.HELD || ui.state == SmeltState.QUALIFIED
    if (ui.state == SmeltState.CHOOSING && ui.tiles.isEmpty()) return
    val look = smeltPrimaryLook(ui.state, ui.primary)
    val tap: () -> Unit = { smeltPrimaryTap(look, on) }
    when {
        look == null -> Plate(PlateKind.CHARCOAL, Modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.sheetPrimaryH)
            .clearAndSetSemantics { contentDescription = ui.primary.caption }) {
            Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwIcon("timer", 24.dp)
                PkwText(ui.primary.caption, PkwTokens.Type.label, color = c.gold.hi, outline = 1.dp)
            }
        }
        held -> ForgePrimary(look, tap, Modifier.fillMaxWidth())
        else -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
            Plate(PlateKind.CREAM, Modifier.width(104.dp).heightIn(min = PkwTokens.Dims.sheetPrimaryH)
                .clearAndSetSemantics { contentDescription = "Basket worth ${ui.basketValue}" }) {
                Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    PkwText("basket worth", PkwTokens.Type.small, color = c.textOnParch2)
                    PkwText(ui.basketValue, PkwTokens.Type.title, color = c.textOnParch)
                }
            }
            ForgePrimary(look, tap, Modifier.weight(1f))
        }
    }
    ForgeFootnote(if (held) "One basket a day · the furnace relights at midnight (00:00 UTC)"
        else "Held in the furnace till midnight. If no coins are minted, every item comes back.")
}

/**
 * What a tap on the SMELT primary does: its action, or, on an off or locked face, its reason through `onExplain` (a door
 * never does nothing). A busy face never calls back ([ForgePrimary]); QUALIFIED has no button.
 */
internal fun smeltPrimaryTap(look: ForgePrimaryLook?, on: SmeltActions) {
    when (look?.action) {
        ForgeAction.SMELT -> on.onSmelt()
        ForgeAction.FIND_RAID -> on.onFindRaid()
        ForgeAction.RETRY -> on.onRetry()
        else -> if (look != null && look.reason != null &&
            (look.state == CommandState.DISABLED || look.state == CommandState.LOCKED)) on.onExplain(look.reason)
    }
}

private val SKELETON_TILES = List(6) { it }

/** A loading tile: cream, no icon, "…". */
@Composable private fun SkeletonTile() {
    Column(Modifier.width(PkwTokens.Dims.itemTileW).clearAndSetSemantics { }) {
        Box(Modifier.size(PkwTokens.Dims.itemTileW, PkwTokens.Dims.itemTileH).drawBehind { drawTileFace(chosen = false, pressed = false) },
            contentAlignment = Alignment.Center) {
            PkwText(UNKNOWN, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
        }
        Spacer(Modifier.height(TAKE_BACK_SLOT))
    }
}

/** The take-back slot every tile reserves so the row never jumps (SPEC §2 ItemTile: 4 + 48). */
private val TAKE_BACK_SLOT = 52.dp

/** The cream tile face: ink M rim, cream body with its 4 dp band; chosen = 3 dp green inner rim; pressed = darker band. */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawTileFace(chosen: Boolean, pressed: Boolean) {
    val c = PkwTokens.Colors
    val w = size.width; val h = size.height; val i = 2.dp.toPx()
    fillStepped(0f, 0f, w, h, CornerProfiles.M, c.ink)
    insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
        drawRect(c.cream)
        band(i, w - i, h - i - 4.dp.toPx(), 4.dp.toPx(), if (pressed) c.parchmentLo else c.creamLo)
        if (chosen) {
            val r = 3.dp.toPx()
            val g = c.green.face
            drawRect(g, Offset(i, i), Size(w - 2 * i, r)); drawRect(g, Offset(i, h - i - r), Size(w - 2 * i, r))
            drawRect(g, Offset(i, i), Size(r, h - 2 * i)); drawRect(g, Offset(w - i - r, i), Size(r, h - 2 * i))
        }
    }
}

/**
 * One basket tile (72 × 80) and its reserved take-back slot: tap +1, hold = fill; chosen = green rim + green "+n" badge
 * and a stone 72 × 48 "− 1" under it (hold = remove the line). A tap past the allowance shakes it (2 dp × 2 in 160 ms)
 * and still calls back so the caller can say why.
 */
@Composable private fun SmeltTile(tile: SmeltTileUi, enabled: Boolean, on: SmeltActions, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    val name = tile.name.ifBlank { tile.resourceId }
    val reduced = LocalReducedMotion.current
    val shake = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    Column(modifier.width(PkwTokens.Dims.itemTileW)) {
        Box(Modifier.offset { IntOffset((shake.value * density).roundToInt(), 0) }) {
            HoldBox("$name, have ${tile.have}" + if (tile.chosen > 0) ", ${tile.chosen} in the basket" else "",
                onTap = {
                    if (!tile.canAdd && !reduced) scope.launch {
                        shake.snapTo(0f)
                        shake.animateTo(0f, keyframes {
                            durationMillis = PkwTokens.Motion.INVALID_SHAKE
                            2f at 40; -2f at 80; 2f at 120
                        })
                    }
                    on.onTile(tile.resourceId)
                },
                onHold = { on.onTileHold(tile.resourceId) }, modifier = Modifier.size(PkwTokens.Dims.itemTileW, PkwTokens.Dims.itemTileH),
                enabled = enabled, holdLabel = "Add as much as fits") { pressed ->
                Box(Modifier.fillMaxSize().drawBehind { drawTileFace(tile.chosen > 0, pressed) }, contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        GfIcon(tile.icon, tileIconDp(tile.icon).dp)
                        PkwText(tile.have, PkwTokens.Type.caption, color = c.textOnParch)
                    }
                }
            }
            if (tile.chosen > 0) Badge(BadgeUi("+${tile.chosen}", BadgeTone.READY, "${tile.chosen} chosen"),
                Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp))
        }
        Spacer(Modifier.height(4.dp))
        Box(Modifier.height(PkwTokens.Dims.minTap)) {
            if (tile.chosen > 0) HoldBox("Take one $name back", { on.onMinus(tile.resourceId) }, { on.onMinusHold(tile.resourceId) },
                Modifier.size(PkwTokens.Dims.itemTileW, PkwTokens.Dims.minTap), enabled = enabled, holdLabel = "Remove $name from the basket") { pressed ->
                Box(Modifier.fillMaxSize().drawBehind { drawChunky(c.stone, if (pressed) 1f else 0f) }, contentAlignment = Alignment.Center) {
                    PkwText("− 1", PkwTokens.Type.label, Modifier.padding(bottom = 5.dp), color = c.label, outline = 1.dp)
                }
            }
        }
    }
}

/** A read-only held tile (SPEC §3c.4): 72 × 80 cream with its count, or the "+n" overflow tile. */
@Composable private fun HeldTile(icon: String?, count: String, spoken: String) {
    Box(Modifier.size(PkwTokens.Dims.itemTileW, PkwTokens.Dims.itemTileH).clearAndSetSemantics { contentDescription = spoken }
        .drawBehind { drawTileFace(chosen = false, pressed = false) }, contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (icon != null) GfIcon(icon, tileIconDp(icon).dp)
            PkwText(count, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
        }
    }
}

/**
 * The SMELT consent Seal (SPEC §3b, `smelt-seal.png`): "SMELT THIS BASKET?", basket → "a share of tonight's coins", the
 * can't-take-back sentence (or, when [SmeltSealUi.consentBody] is set, the full existing legal sentence and its risk line),
 * the consent row, BACK + gold SMELT. The primary stays off until the box is ticked, then arms
 * over 450 ms ([consentArmStart]). Callbacks: `onConsent`, `onConfirm`, `onBack` (the existing `model.start(lines)`,
 * consent and `model.confirm(review)`).
 *
 * Pointer rule: the OverlayHost composes this call always; it is full-screen (55 % scrim) only while [ui] is non-null
 * and while it animates out. A scrim tap is BACK, ignored while sending.
 */
@Composable fun SmeltSeal(ui: SmeltSealUi?, on: SmeltActions, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }, onExitFinished: () -> Unit = {}) {
    val c = PkwTokens.Colors
    ForgeSeal(ui, { "SMELT THIS BASKET?" }, { seal -> if (!seal.sending) on.onBack() }, modifier, onExitFinished) { seal, active ->
        PayGet(left = {
            Row(Modifier.height(48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                seal.icons.take(2).forEach { GfIcon(it, 32.dp) }
            }
            PkwText(seal.items, PkwTokens.Type.title, color = c.textOnParch)
            PkwText("worth ${seal.worth}", PkwTokens.Type.small, color = c.textOnParch2)
        }, right = {
            SealSide("gf:keep_48", "a share", "of tonight's coins")
        })
        val paraphrase = "The basket goes into the furnace now and can't be taken back. If it mints coins, it melts. If not, every item comes back."
        if (seal.consentBody == null && seal.riskLine == null) PkwText(paraphrase, PkwTokens.Type.body, Modifier.fillMaxWidth(),
            color = c.textOnParch, maxLines = 4)
        // SPEC §9 fallback: the whole existing legal sentence and its risk line, never clipped. They scroll inside a bounded
        // block so the consent row, BACK and SMELT always stay on screen.
        else Column(Modifier.fillMaxWidth().heightIn(max = SEAL_TERMS_MAX_H).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(6.dp)) {
            PkwText(seal.consentBody ?: paraphrase, PkwTokens.Type.body, Modifier.fillMaxWidth(), color = c.textOnParch,
                maxLines = Int.MAX_VALUE)
            seal.riskLine?.let { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, maxLines = Int.MAX_VALUE) }
        }
        ConsentRow(seal.consent, seal.consentText, on.onConsent, enabled = active && !seal.sending)
        val consentAt = remember(seal.consent) { if (seal.consent) clock() else null }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            SecondaryButton("BACK", on.onBack, Modifier.width(PkwTokens.Dims.sealBackW), enabled = active && !seal.sending)
            if (seal.sending) ForgePrimary(ForgePrimaryLook("Sending", Verb.STONE, CommandState.BUSY, ForgeAction.NONE, sentence = true), {},
                Modifier.weight(1f))
            else ArmingButton("SMELT", consentArmStart(seal.armedAtMs, consentAt), active, on.onConfirm, clock, Modifier.weight(1f))
        }
    }
}

/** The tallest the Seal's legal block grows before it scrolls (about eight VT lines). */
private val SEAL_TERMS_MAX_H = 200.dp

@Preview(name = "SMELT: choosing a basket", widthDp = 398, heightDp = 760)
@Composable private fun SmeltChoosingPreview() = SmeltPreviewFrame(GoldForgeSamples.smeltChoosing)

@Preview(name = "SMELT: settlement callout (melted)", widthDp = 398, heightDp = 760)
@Composable private fun SmeltResultPreview() = SmeltPreviewFrame(GoldForgeSamples.smeltChoosing.copy(result = SmeltResultUi(melted = true)))

@Preview(name = "SMELT: loading", widthDp = 398, heightDp = 760)
@Composable private fun SmeltLoadingPreview() = SmeltPreviewFrame(GoldForgeSamples.smeltLoading)

@Preview(name = "SMELT: nothing to smelt", widthDp = 398, heightDp = 760)
@Composable private fun SmeltEmptyPreview() = SmeltPreviewFrame(GoldForgeSamples.smeltChoosing.copy(tiles = emptyList(), selected = null))

@Preview(name = "SMELT: paused", widthDp = 398, heightDp = 760)
@Composable private fun SmeltPausedPreview() = SmeltPreviewFrame(GoldForgeSamples.smeltChoosing.copy(state = SmeltState.PAUSED,
    primary = smeltPrimaryCommand(SmeltState.PAUSED, 7)))

@Preview(name = "SMELT: not ready (locked)", widthDp = 398, heightDp = 760)
@Composable private fun SmeltNotReadyPreview() = SmeltPreviewFrame(GoldForgeSamples.smeltChoosing.copy(state = SmeltState.NOT_READY,
    primary = smeltPrimaryCommand(SmeltState.NOT_READY, 0)))

@Preview(name = "SMELT: read failed", widthDp = 398, heightDp = 760)
@Composable private fun SmeltErrorPreview() = SmeltPreviewFrame(GoldForgeSamples.smeltChoosing.copy(state = SmeltState.ERROR,
    primary = smeltPrimaryCommand(SmeltState.ERROR, 7)))

@Preview(name = "SMELT: sending", widthDp = 398, heightDp = 760)
@Composable private fun SmeltSendingPreview() = SmeltPreviewFrame(GoldForgeSamples.smeltChoosing.copy(state = SmeltState.SENDING,
    primary = smeltPrimaryCommand(SmeltState.SENDING, 7)))

@Preview(name = "SMELT: basket held", widthDp = 398, heightDp = 760)
@Composable private fun SmeltHeldPreview() = SmeltPreviewFrame(GoldForgeSamples.smeltHeld)

@Preview(name = "SMELT: raid won (qualified)", widthDp = 398, heightDp = 760)
@Composable private fun SmeltQualifiedPreview() = SmeltPreviewFrame(GoldForgeSamples.smeltHeld.copy(state = SmeltState.QUALIFIED,
    primary = smeltPrimaryCommand(SmeltState.QUALIFIED, 0, payoutIn = "6h 20m"), estimate = null))

@Preview(name = "SMELT seal: consent not given", widthDp = 412, heightDp = 700)
@Composable private fun SmeltSealPreview() = SmeltSeal(GoldForgeSamples.smeltSeal.copy(consent = false), SmeltActions())

@Preview(name = "SMELT seal: consent given (arming)", widthDp = 412, heightDp = 700)
@Composable private fun SmeltSealArmingPreview() = SmeltSeal(GoldForgeSamples.smeltSeal, SmeltActions(), clock = { 0L })

@Composable private fun SmeltPreviewFrame(ui: SmeltUi) {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f, fill = true)) { SmeltBody(ui, SmeltActions()) }
        SmeltFooter(ui, SmeltActions())
    }
}
