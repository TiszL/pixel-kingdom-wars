package gg.pixelkingdomwars.nativeclient.ui.sheets.editor

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TileMode
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
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyName
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildingArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.StepArrow
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.drawGrassWell
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.foldRows
import kotlinx.coroutines.delay

/*
 * Design component: the BuildingInfo half sheet (design/final/buildings/SPEC.md §2A, info.png; registry row 30). INFO is
 * the first command on every building: what it is, what it does, what gets better at the next level, and one green entry
 * to UPGRADE. A charcoal living header (the building's own sprite in a 112 × 120 well with its LV tag; title plate + red
 * close; a one-line role; category and live-state tags), a parchment STATS list ("now ▸ at LV n+1"), the cost chips and
 * the primary. A building's fifth action (design correction 7: Keep EXPAND, Wall ROW) is a stone row under the stats.
 */

/** A tag on the header (category DEFENCE / PRODUCER / ARMY / STORAGE / FEATURE in stone; state GUARDING moss, READY
 *  green, IDLE stone, UPGRADING 1h 12m gold). */
@Immutable data class InfoTagUi(val text: String, val verb: Verb)

/** One STATS row (SPEC §2A.2 `StatRowUi`). Values arrive formatted from the catalogue / server; null is "…". */
@Immutable data class InfoStatUi(
    /** A 24 px icon (`attack`, `shield`, `scout`, `timer`, …) or a portrait (`ui_portrait_dragon_t2`, drawn 28 dp framed). */
    val icon: String,
    /** VT label ("Damage per second"). */
    val label: String,
    /** The value now ("34", "7 tiles"). */
    val now: String?,
    /** The value at the next level ("41"); null: the stat does not change (single value). */
    val next: String? = null,
    /** A yes/no capability: a green YES or stone NO tag instead of numbers. */
    val yesNo: Boolean? = null,
)

/** The primary (SPEC §2A.1: UPGRADE TO LV n | FINISH | MAX LEVEL). */
@Immutable data class InfoPrimaryUi(
    val kind: InfoPrimaryKind,
    /** "UPGRADE TO LV 5", "FINISH", "MAX LEVEL". */
    val label: String,
    /** "Uses 1 builder for 1h 30m"; MAX: "next level needs Keep 6" (null when truly max). */
    val sub: String?,
    /** The server's state for it (LOCKED: feature locked, charcoal + padlock; DISABLED: read-only base, …). */
    val state: CommandState = CommandState.ENABLED,
    /** The reason line under an off / locked primary ("Opens 14 Oct", "Viewing another kingdom"). */
    val reason: String? = null,
    /** FINISH: its Gems price (the pill on the button's top edge). UPGRADE: the cost lives in the chips instead. */
    val price: PriceUi? = null,
)

/** The fifth action (correction 7), drawn as a stone 52 dp row: icon + VT action + chevron. */
@Immutable data class InfoExtraUi(val icon: String, val label: String, val description: String = label)

/** Everything the BuildingInfo sheet draws (SPEC §2A.2). */
@Immutable data class BuildingInfoUi(
    /** The building's id (keys the row fade-in). */
    val buildingId: String,
    /** "ARCHER TOWER" on the title plate. */
    val name: String,
    /** The blue tag on the well ("LV 4"). */
    val levelTag: String,
    /** One sentence, at most two lines ("Shoots the nearest attacker. Hits flying troops too."). */
    val role: String,
    /** Stone category tag. */
    val category: InfoTagUi,
    /** Live state tag. */
    val stateTag: InfoTagUi,
    /** The header sprite's frames at world zoom (`BuildingArt` names: Phase E `ui:…` tier art or an existing GameArt
     *  name); one name = a still sprite, several = the idle loop. Empty draws the bare well. */
    val headerFrames: List<String>,
    /** The idle loop's frame time. */
    val frameMs: Int = 160,
    /** The STATS rows (at most [INFO_MAX_STATS] shown; more add the "All levels" row). */
    val stats: List<InfoStatUi>,
    /** The legend's right side ("at LV 5"); null at max level (single values, no legend). */
    val nextLegend: String?,
    /** Upgrading: next values are pending (green stripes behind them). */
    val upgrading: Boolean = false,
    /** The upgrade price chip (null at max level or for FINISH-only states). */
    val price: PriceUi?,
    /** The build time chip ("1h 30m"). */
    val time: String?,
    /** The builders chip ("1/2 free"). */
    val builders: String?,
    /** SHORT: how many more are needed ("12,400") for "Need 12,400 more Shards". */
    val shortfall: String? = null,
    /** The primary. */
    val primary: InfoPrimaryUi,
    /** The fifth action, or null. */
    val extra: InfoExtraUi? = null,
    /** The load state. */
    val load: InfoLoad = InfoLoad.READY,
)

/** The sheet's callbacks (SPEC §2A.2; `onShortCost(String)` is [onGetMore] with the currency, as the UPGRADE sheet does). */
class BuildingInfoActions(
    /** Red close / Back (the scene's own tap closes a HALF sheet too). */
    val onClose: () -> Unit,
    /** UPGRADE TO LV n: replace this sheet with the UPGRADE half sheet in place (no stack). Never spends. */
    val onUpgrade: () -> Unit,
    /** FINISH: open the Gems Seal (`goldforge/speedup.png`); the Seal confirms the spend. */
    val onFinish: () -> Unit,
    /** A SHORT cost chip or a SHORT FINISH: Need-more for that currency. */
    val onGetMore: (Currency) -> Unit,
    /** The fifth action row. */
    val onExtra: () -> Unit = {},
    /** The "All levels" row (the level table; not mocked). */
    val onAllLevels: () -> Unit = {},
    /** ERROR: TRY AGAIN. */
    val onRetry: () -> Unit = {},
    /** An off / locked primary was tapped: show this reason (toast); never silent. */
    val onExplain: (String) -> Unit = {},
)

/** The stats list's 2 dp row divider (SPEC `#E2CB93`). */
private val DIVIDER = Color(0xFFE2CB93)
private val ROW_H = 40.dp

/**
 * The BuildingInfo half sheet (info.png). The host (SheetHost) places it from y 452 to the bottom, left / right 4 dp,
 * slides it up in 180 ms (`out`) and out in 140 ms; the header sprite keeps its idle loop (none with reduced motion);
 * the stat rows fade in with a 20 ms stagger. UPGRADE cross-fades this sheet to the UPGRADE sheet (120 ms, the host's).
 *
 * Pointer rule: a HALF sheet has NO scrim. This composable is one painted wood panel (a scene-input region, via the kit's
 * Plate) and only its buttons, the SHORT cost chip and the stone rows take taps; the kingdom above it stays live and the
 * host closes the sheet from the scene's own tap. Nothing here is full-screen, clickable on empty space, or a pointerInput root.
 */
@Composable fun BuildingInfoSheet(ui: BuildingInfoUi, on: BuildingInfoActions, modifier: Modifier = Modifier) {
    Plate(PlateKind.WOOD, modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            InfoHeader(ui, on.onClose)
            Spacer(Modifier.height(6.dp))
            // K-night-A11 (owner, hero altar cut-offs): the sheet wraps its content as designed while the window has room; in a
            // shorter window (a phone in landscape is 400 dp tall) the stats scroll and the primary stays pinned at the bottom
            // instead of being cut off below the screen. Both weights are fill = false, so nothing grows past its content.
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth().weight(1f, fill = false),
                contentPadding = PaddingValues(start = 8.dp, top = 8.dp, end = 8.dp, bottom = 10.dp), blocksScene = false) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        StatsLegend(ui.nextLegend.takeIf { ui.load == InfoLoad.READY })
                        StatsList(ui, on)
                        ui.extra?.let { StoneRow(it.icon, it.label, it.description, on.onExtra) }
                        if (ui.load == InfoLoad.READY && ui.primary.kind != InfoPrimaryKind.MAX) CostRow(ui, on)
                    }
                    InfoPrimary(ui, on)
                }
            }
        }
    }
}

/** The charcoal living header: the sprite well, title plate + close, role, tags. A 3 dp ink rule under it. */
@Composable private fun InfoHeader(ui: BuildingInfoUi, onClose: () -> Unit) {
    val c = PkwTokens.Colors
    Box(Modifier.fillMaxWidth().drawBehind {
        drawRect(c.surface)
        drawRect(c.ink, Offset(0f, size.height - 3.dp.toPx()), Size(size.width, 3.dp.toPx()))
    }.padding(start = 6.dp, top = 6.dp, end = 6.dp, bottom = 9.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HeaderWell(ui)
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Plate(PlateKind.CHARCOAL, Modifier.weight(1f).heightIn(min = 44.dp).semantics(mergeDescendants = true) {
                        heading(); contentDescription = "${ui.name}, ${ui.levelTag}"
                    }, contentPadding = PaddingValues(start = 10.dp, top = 6.dp, end = 6.dp, bottom = 8.dp), blocksScene = false) {
                        PkwText(ui.name, PkwTokens.Type.title, Modifier.align(Alignment.CenterStart), color = c.gold.hi, outline = 1.dp)
                    }
                    CloseSquare(onClose, contentDescription = "Close ${ui.name} info")
                }
                PkwText(ui.role, PkwTokens.Type.body, Modifier.padding(top = 6.dp), color = c.text, maxLines = 2)
                Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Tag(ui.category.text, ui.category.verb)
                    Tag(ui.stateTag.text, ui.stateTag.verb)
                }
            }
        }
    }
}

/** The 112 × 120 well: the building's own sprite on ground, idle loop playing, blue LV tag at the bottom-right. */
@Composable private fun HeaderWell(ui: BuildingInfoUi) {
    val reduced = LocalReducedMotion.current
    val still = LocalInspectionMode.current
    var frame by remember(ui.headerFrames) { mutableIntStateOf(0) }
    LaunchedEffect(ui.headerFrames, reduced, still) {
        if (ui.headerFrames.size < 2 || reduced || still) return@LaunchedEffect
        while (true) { delay(ui.frameMs.coerceAtLeast(60).toLong()); frame = (frame + 1) % ui.headerFrames.size }
    }
    Box(Modifier.size(width = 112.dp, height = 120.dp).clipToBounds().drawBehind { drawGrassWell() }
        .clearAndSetSemantics { contentDescription = "${ui.name}, ${ui.levelTag}" }) {
        ui.headerFrames.getOrNull(frame)?.let { BuildingArt(it, 104.dp, Modifier.align(Alignment.Center)) }
        Tag(ui.levelTag, Verb.BLUE, Modifier.align(Alignment.BottomEnd).padding(end = 6.dp, bottom = 8.dp))
    }
}

/** "STATS" … "now ▸ at LV 5" (the right side only when there is a next level). */
@Composable private fun StatsLegend(next: String?) {
    val c = PkwTokens.Colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        PkwText("STATS", PkwTokens.Type.label, Modifier.semantics { heading() }, color = c.textOnParch)
        Spacer(Modifier.weight(1f))
        if (next != null) {
            PkwText("now", PkwTokens.Type.small, color = c.textOnParch2)
            StepArrow(10.dp, 12.dp, Modifier.padding(horizontal = 6.dp), color = c.textOnParch2)
            PkwText(next, PkwTokens.Type.small, color = c.green.lo)
        }
    }
}

/** The cream list (2 dp ink border, 40 dp rows, 2 dp dividers), skeletons while loading, TRY AGAIN on error. */
@Composable private fun StatsList(ui: BuildingInfoUi, on: BuildingInfoActions) {
    val c = PkwTokens.Colors
    val reduced = LocalReducedMotion.current
    val still = LocalInspectionMode.current || reduced
    val folded = foldRows(ui.stats, expanded = false, max = INFO_MAX_STATS)
    Column(Modifier.fillMaxWidth().background(c.cream).border(2.dp, c.ink).padding(horizontal = 2.dp)) {
        when (ui.load) {
            InfoLoad.LOADING -> repeat(4) { i ->
                if (i > 0) Divider()
                Box(Modifier.fillMaxWidth().height(ROW_H).clearAndSetSemantics { contentDescription = "Loading" }, contentAlignment = Alignment.Center) {
                    PkwText(UNKNOWN, PkwTokens.Type.label, color = c.textOnParch2)
                }
            }
            InfoLoad.ERROR -> Row(Modifier.fillMaxWidth().padding(6.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText(UNKNOWN, PkwTokens.Type.label, Modifier.weight(1f), color = c.textOnParch2, textAlign = TextAlign.Center)
                SecondaryButton("TRY AGAIN", on.onRetry, contentDescription = "Try loading the stats again")
            }
            InfoLoad.READY -> folded.shown.forEachIndexed { index, stat ->
                if (index > 0) Divider()
                val alpha = remember(ui.buildingId) { Animatable(if (still) 1f else 0f) }
                LaunchedEffect(ui.buildingId) {
                    delay(index * PkwTokens.Motion.DRAWER_ROW_STAGGER.toLong())
                    alpha.animateTo(1f, tween(PkwTokens.Motion.TAB_SWITCH, easing = PkwTokens.Motion.Out))
                }
                StatRow(stat, ui.upgrading, Modifier.graphicsLayer { this.alpha = alpha.value })
            }
        }
    }
    if (ui.load == InfoLoad.READY && folded.hidden > 0) {
        StoneRow("shape:info", "All levels", "All levels: ${folded.hidden} more stats", on.onAllLevels)
    }
}

@Composable private fun Divider() { Box(Modifier.fillMaxWidth().height(2.dp).background(DIVIDER)) }

/** One 40 dp stat row: icon (24, or a 28 dp framed portrait), VT label, then a tag, "old ▸ new" or the single value. */
@Composable private fun StatRow(stat: InfoStatUi, pending: Boolean, modifier: Modifier) {
    val c = PkwTokens.Colors
    Row(modifier.fillMaxWidth().heightIn(min = ROW_H).padding(start = 4.dp, end = 8.dp)
        .clearAndSetSemantics { contentDescription = statSpoken(stat.label, stat.now, stat.next, stat.yesNo) },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.width(32.dp), contentAlignment = Alignment.Center) {
            if (statIconFramed(stat.icon)) Box(Modifier.size(32.dp).background(c.ink).padding(2.dp), contentAlignment = Alignment.Center) {
                PkwIcon(stat.icon, 28.dp)
            } else PkwIcon(stat.icon, 24.dp)
        }
        PkwText(stat.label, PkwTokens.Type.body, Modifier.weight(1f), color = c.textOnParch)
        when {
            stat.yesNo != null -> Tag(if (stat.yesNo) "YES" else "NO", if (stat.yesNo) Verb.GREEN else Verb.STONE)
            stat.next != null -> {
                PkwText(stat.now ?: UNKNOWN, PkwTokens.Type.label, color = c.textOnParch)
                StepArrow(10.dp, 12.dp, color = c.textOnParch2)
                PkwText(stat.next, PkwTokens.Type.label, Modifier.then(if (pending) Modifier.pendingStripes() else Modifier).padding(horizontal = 2.dp),
                    color = c.green.lo)
            }
            else -> PkwText(stat.now ?: UNKNOWN, PkwTokens.Type.label, color = c.textOnParch)
        }
    }
}

/** Green stripes at 45 % behind a pending next value (upgrading: the new value is on its way). */
private fun Modifier.pendingStripes(): Modifier = drawBehind {
    val stripe = 4.dp.toPx()
    val brush = Brush.linearGradient(0f to PkwTokens.Colors.green.hi, 0.5f to PkwTokens.Colors.green.hi, 0.5f to PkwTokens.Colors.green.face,
        1f to PkwTokens.Colors.green.face, start = Offset.Zero, end = Offset(stripe * 2, stripe * 2), tileMode = TileMode.Repeated)
    drawRect(brush, alpha = 0.45f)
}

/** A stone 52 dp row: icon 24 + VT action + chevron (the fifth action, "All levels"). */
@Composable private fun StoneRow(icon: String, label: String, description: String, onClick: () -> Unit) {
    val c = PkwTokens.Colors
    ChunkyBox(PkwTokens.Colors.stone, onClick, description, Modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.secondaryH)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwIcon(icon, 24.dp, tint = c.label)
            PkwText(label, PkwTokens.Type.body, Modifier.weight(1f), color = c.label, outline = 1.dp)
            PkwIcon("shape:go", 24.dp, tint = c.label)
        }
    }
}

/** Shards / timer / builder chips; SHORT turns the price chip short (a 48 dp door to Need-more) and adds the sentence. */
@Composable private fun CostRow(ui: BuildingInfoUi, on: BuildingInfoActions) {
    val c = PkwTokens.Colors
    val price = ui.price
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (price != null) {
                val short = price.status == PriceStatus.SHORT
                PriceChip(price, Modifier.heightIn(min = 30.dp), onClick = if (short) ({ on.onGetMore(price.currency) }) else null)
            }
            ui.time?.let { CreamChip("timer", 24.dp, it, "Takes $it") }
            ui.builders?.let { CreamChip("builder", 30.dp, it, "Builders $it") }
        }
        if (price != null && price.status == PriceStatus.SHORT) {
            val need = ui.shortfall ?: UNKNOWN
            val currency = currencyName(price.currency)
            Row(Modifier.semantics(mergeDescendants = true) { contentDescription = "Need $need more $currency" },
                verticalAlignment = Alignment.CenterVertically) {
                PkwText("Need ", PkwTokens.Type.body, color = c.shortText)
                PkwText(need, PkwTokens.Type.label, color = c.shortText)
                PkwText(" more $currency", PkwTokens.Type.body, color = c.shortText)
            }
        }
    }
}

/** A 30 dp cream chip (ink S rim, cream body): icon + PS caption. Not clickable. (The UPGRADE sheet's own is private.) */
@Composable private fun CreamChip(icon: String, iconSize: Dp, text: String, spoken: String) {
    Row(Modifier.heightIn(min = 30.dp).drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 2.dp.toPx()
        fillStepped(i, i, size.width - i, size.height - i, CornerProfiles.S, PkwTokens.Colors.cream)
    }.padding(start = 3.dp, end = 8.dp).clearAndSetSemantics { contentDescription = spoken },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        PkwIcon(icon, iconSize)
        PkwText(text, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
    }
}

/** The primary: green UPGRADE TO LV n (up arrow), gold FINISH with its Gems pill, or the charcoal MAX LEVEL plate. */
@Composable private fun InfoPrimary(ui: BuildingInfoUi, on: BuildingInfoActions) {
    val c = PkwTokens.Colors
    val p = ui.primary
    if (p.kind == InfoPrimaryKind.MAX && ui.load == InfoLoad.READY) {
        Plate(PlateKind.CHARCOAL, Modifier.fillMaxWidth().heightIn(min = 62.dp).semantics(mergeDescendants = true) {
            contentDescription = listOfNotNull(p.label, p.sub).joinToString(". ")
        }, blocksScene = false) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                PkwText(p.label, PkwTokens.Type.primary, color = c.gold.hi, outline = 2.dp)
                p.sub?.let { PkwText(it, PkwTokens.Type.small, color = c.muted) }
            }
        }
        return
    }
    val look = infoPrimaryLook(ui.load, p.kind, p.label, p.sub, p.state, p.reason, p.price)
    val tap: () -> Unit = {
        when (infoPrimaryTap(ui.load, p.kind, p.state, p.price)) {
            InfoTap.UPGRADE -> on.onUpgrade()
            InfoTap.FINISH -> on.onFinish()
            InfoTap.NEED_MORE -> on.onGetMore(p.price?.currency ?: Currency.GEMS)
            InfoTap.EXPLAIN -> on.onExplain(look.reason ?: "Not available right now")
            InfoTap.NONE -> Unit
        }
    }
    val finish = p.kind == InfoPrimaryKind.FINISH
    PrimaryButton(look.label, tap, Modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.sheetPrimaryH),
        verb = if (finish) Verb.GOLD else Verb.GREEN, sub = look.sub, state = look.state, reason = look.reason,
        icon = if (!finish && look.state == CommandState.ENABLED) "shape:up" else null,
        price = if (finish && ui.load == InfoLoad.READY) p.price else null,
        onPrice = p.price?.takeIf { finish && it.status == PriceStatus.SHORT }?.let { short -> { on.onGetMore(short.currency) } })
}

// ---- Previews (sample data only; the real Ui comes from Codex's mapper) ----

private val previewActions = BuildingInfoActions(onClose = {}, onUpgrade = {}, onFinish = {}, onGetMore = {})

private val sampleInfo = BuildingInfoUi(
    buildingId = "archertower-1", name = "ARCHER TOWER", levelTag = "LV 4",
    role = "Shoots the nearest attacker. Hits flying troops too.",
    category = InfoTagUi("DEFENCE", Verb.STONE), stateTag = InfoTagUi("GUARDING", Verb.MOSS),
    headerFrames = listOf("ui_portrait_archertower_t1"),
    stats = listOf(
        InfoStatUi("attack", "Damage per second", "34", "41"),
        InfoStatUi("shield", "Hitpoints", "360", "430"),
        InfoStatUi("scout", "Range", "7 tiles"),
        InfoStatUi("ui_portrait_dragon_t2", "Hits flying troops", null, yesNo = true),
    ),
    nextLegend = "at LV 5",
    price = PriceUi(Currency.SHARDS, "521", PriceStatus.OK), time = "1h 30m", builders = "1/2 free",
    primary = InfoPrimaryUi(InfoPrimaryKind.UPGRADE, "UPGRADE TO LV 5", "Uses 1 builder for 1h 30m"),
)

@Composable private fun InfoPreviewFrame(ui: BuildingInfoUi) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35)), contentAlignment = Alignment.BottomCenter) {
        BuildingInfoSheet(ui, previewActions, Modifier.padding(horizontal = 4.dp))
    }
}

@Preview(name = "Info: ready (info.png)", widthDp = 412, heightDp = 915)
@Composable private fun InfoReadyPreview() = InfoPreviewFrame(sampleInfo)

@Preview(name = "Info: short of Shards", widthDp = 412, heightDp = 915)
@Composable private fun InfoShortPreview() = InfoPreviewFrame(sampleInfo.copy(price = PriceUi(Currency.SHARDS, "521", PriceStatus.SHORT), shortfall = "180"))

@Preview(name = "Info: upgrading, FINISH in Gems", widthDp = 412, heightDp = 915)
@Composable private fun InfoBusyPreview() = InfoPreviewFrame(sampleInfo.copy(stateTag = InfoTagUi("UPGRADING 1h 12m", Verb.GOLD), upgrading = true,
    price = null, time = null, builders = null,
    primary = InfoPrimaryUi(InfoPrimaryKind.FINISH, "FINISH", "Done now", price = PriceUi(Currency.GEMS, "38", PriceStatus.OK))))

@Preview(name = "Info: max level + fifth action", widthDp = 412, heightDp = 915)
@Composable private fun InfoMaxPreview() = InfoPreviewFrame(sampleInfo.copy(nextLegend = null,
    stats = sampleInfo.stats.map { it.copy(next = null) }, price = null,
    primary = InfoPrimaryUi(InfoPrimaryKind.MAX, "MAX LEVEL", "next level needs Keep 6"),
    extra = InfoExtraUi("layout", "Build a wall row", "Build a row of walls")))

@Preview(name = "Info: loading", widthDp = 412, heightDp = 915)
@Composable private fun InfoLoadingPreview() = InfoPreviewFrame(sampleInfo.copy(load = InfoLoad.LOADING, stats = emptyList()))

@Preview(name = "Info: error", widthDp = 412, heightDp = 915)
@Composable private fun InfoErrorPreview() = InfoPreviewFrame(sampleInfo.copy(load = InfoLoad.ERROR, stats = emptyList()))

@Preview(name = "Info: feature locked", widthDp = 412, heightDp = 915)
@Composable private fun InfoLockedPreview() = InfoPreviewFrame(sampleInfo.copy(
    primary = InfoPrimaryUi(InfoPrimaryKind.UPGRADE, "UPGRADE TO LV 5", null, CommandState.LOCKED, "Opens 14 Oct")))

@Preview(name = "Info: six stats fold to All levels", widthDp = 412, heightDp = 915)
@Composable private fun InfoManyPreview() = InfoPreviewFrame(sampleInfo.copy(stats = sampleInfo.stats +
    InfoStatUi("timer", "Attack speed", "1.0s", "0.9s") + InfoStatUi("trophy", "Splash", "none")))
