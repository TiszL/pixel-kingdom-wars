package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CommandRoute
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.VeilChip
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.kit.commandRoute
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ArmyTileUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ErrorRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LadderRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LadderUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Pips
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RankMedal
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowVariant
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkeletonBlock
import kotlinx.coroutines.delay

/*
 * Design component: SOLO TRIALS (design/final/map/SPEC.md Round 2 §D; divine-trials.png), registry row 88,
 * `Destination.DivineTrials`. A TALL sheet: the living header (the isle around the ring, from the host), title "SOLO
 * TRIALS", History (saved events), close, VeilChip "Week 41 ends 3d 4h"; tabs THIS WEEK · STANDINGS.
 * THIS WEEK: the "ONE ARMY. YOUR PLAN." card with the fixed army as 32 minis (portrait 28 + outlined count; the hero at 24
 * in a gold-rim mini), TRIES LEFT (PS 16 + "of 3 this week" + pips) and YOUR BEST (stars 24 + PS 12 % + rank) cards, WHAT
 * THE TOP 500 WIN (lavender row with the solo-area sprite 64 in a `#4A3F66` well), LAST WEEK (held area + moss HELD), the
 * footnote. STANDINGS: the hub ladder grammar, your row pinned, a gold rule at rank 500 "TOP 500 HOLD AN AREA".
 * Footer: stone BEST 112 × 64 (replay of your best attempt) + gold PLAN & FIGHT "try 2 of 3 this week".
 */

/** YOUR BEST (§D `TrialBestUi`): stars, percentage, rank and field size, each "…" when unknown. */
@Immutable data class TrialBestUi(val stars: Int?, val pct: String, val rank: String, val of: String)

/** LAST WEEK (§D): the area you held and until when. */
@Immutable data class LastWeekUi(
    /** "Rank 112 · solo area 212". */
    val title: String,
    /** "yours until Mon 00:00 UTC". */
    val sub: String,
    /** Still held: moss HELD tag. */
    val held: Boolean,
)

/** Everything SOLO TRIALS draws (§D `DivineTrialsUi`; fields after `load` were added with defaults). */
@Immutable data class DivineTrialsUi(
    /** "Week 41". */
    val week: String,
    /** "3d 4h"; null hides the chip's time ("…"). */
    val endsIn: String?,
    /** The fixed army everyone gets (portrait + count). Empty while loading draws skeleton minis. */
    val army: List<ArmyTileUi>,
    /** The hero's portrait ("hero_vex_portrait", 48 art at 24); null draws none. */
    val hero: String?,
    /** Tries left / per week; null = unknown ("…", no pips). */
    val triesLeft: Int?,
    val triesMax: Int?,
    val best: TrialBestUi?,
    /** "A solo area on the Divine Isle held for next week. It earns Crystal Fragments every day." (server copy). */
    val prizeLine: String,
    val lastWeek: LastWeekUi?,
    /** PLAN & FIGHT: sub "try 2 of 3 this week"; DISABLED "No tries left · new trial Mon 00:00 UTC"; LOCKED + the
     *  server's reason ("Needs Keep 8"); BUSY "Sending your plan". */
    val primary: CommandUi,
    /** BEST (replay of your best attempt); null hides it. */
    val replay: CommandUi?,
    /** STANDINGS (the hub ladder: rows best first, your row pinned); `LadderRowUi.trophies` carries the score text. */
    val standings: LadderUi?,
    /** "THIS_WEEK" or "STANDINGS". */
    val tab: String,
    /** An attempt whose result is not known: "Your attempt is being checked" + CHECK RESULT (never shown refunded). */
    val recovery: RecoveryUi?,
    val load: LoadState,
    /** The host's crop of the isle around the ring; null fills the stage colour. */
    val headerArt: ImageBitmap? = null,
    /** No trial this week: the card line ("No trial this week · next opens Mon"); null draws the week. */
    val emptyLine: String? = null,
    /** A new best just landed: the YOUR BEST card flashes gold twice (2 × 120 ms). */
    val bestFlash: Boolean = false,
    /** The area cutoff rank (server; 500 today). */
    val cutoff: Int = 500,
    val tabs: List<TabUi> = divineTrialsTabs(),
    val prizeTitle: String = "WHAT THE TOP 500 WIN",
    val footnote: String = "Your own troops stay home. New trial every Monday.",
)

/** SOLO TRIALS callbacks (§D; `onRetry`, `onReport`, `onExplain`, `onRow` added). */
@Immutable data class DivineTrialsActions(
    val onTab: (String) -> Unit = {},
    /** PLAN & FIGHT: plan the fixed army, then `DivineTrialBattle`. */
    val onPlan: () -> Unit = {},
    /** BEST: replay of your best attempt. */
    val onWatchBest: () -> Unit = {},
    val onHistory: () -> Unit = {},
    /** CHECK RESULT on a saved attempt. */
    val onRecover: (String) -> Unit = {},
    val onClose: () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onReport: () -> Unit = {},
    /** A refused primary / BEST: show its reason. */
    val onExplain: (String) -> Unit = {},
    /** A standings row (the player half sheet). */
    val onRow: (String) -> Unit = {},
)

const val TRIALS_THIS_WEEK = "THIS_WEEK"
const val TRIALS_STANDINGS = "STANDINGS"

/** THIS WEEK (the crowned cup) · STANDINGS (trophy). */
fun divineTrialsTabs(): List<TabUi> = listOf(
    TabUi(TRIALS_THIS_WEEK, "ui:divine-navigation", "THIS WEEK", null, false),
    TabUi(TRIALS_STANDINGS, "trophy", "STANDINGS", null, false),
)

/**
 * The SOLO TRIALS tall sheet. STANDINGS is a lazy list (the frame does not scroll it) with your row pinned under it.
 *
 * Pointer rule: the root is the kit SheetFrame (a painted panel); only its frame, tabs, rows and buttons take touches.
 * The TALL scrim is the SheetHost's, under it, only while shown.
 */
@Composable fun DivineTrialsSheet(ui: DivineTrialsUi, on: DivineTrialsActions, modifier: Modifier = Modifier) {
    val standings = ui.tab == TRIALS_STANDINGS
    SheetFrame(SheetFrameUi("SOLO TRIALS", null, SheetSize.TALL, ui.tabs, ui.tab, history = true), on.onClose, modifier,
        onTab = on.onTab, onHistory = on.onHistory,
        scrollState = if (standings) null else rememberScrollState(),
        header = {
            HeaderArtCrop(ui.headerArt, Modifier.fillMaxSize())
            // With neither the week nor its end known there is no chip: a countdown made of placeholders reads as loading forever.
            if (ui.week != UNKNOWN || ui.endsIn != null)
                VeilChip("${ui.week} ends", Modifier.align(Alignment.BottomStart).padding(6.dp), icon = "timer", emphasis = ui.endsIn ?: UNKNOWN)
        },
        footer = { TrialsFooter(ui, on) }) {
        (ui.load as? LoadState.Error)?.let { ErrorRow(it, on.onRetry, on.onReport) }
        ui.recovery?.let { RecoveryRow(it, on.onRecover) }
        if (standings) StandingsBody(ui, on, Modifier.weight(1f, fill = false)) else ThisWeekBody(ui)
    }
}

@Composable private fun ThisWeekBody(ui: DivineTrialsUi) {
    val loading = ui.load == LoadState.Loading
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth(), blocksScene = false) {
        Column(Modifier.fillMaxWidth().padding(4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            PkwText("ONE ARMY. YOUR PLAN.", PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
            val empty = ui.emptyLine
            if (empty != null) ParchLine(empty, secondary = true)
            else {
                ParchLine("Everyone gets this same army. Where you place it decides your score.", secondary = true)
                ArmyMinis(ui.army, ui.hero, loading)
            }
        }
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        TriesCard(ui.triesLeft, ui.triesMax, Modifier.weight(1f))
        BestCard(ui.best, ui.bestFlash, Modifier.weight(1f))
    }
    MapSectionHeader(ui.prizeTitle)
    MapRow(tint = TRIALS_LAVENDER) {
        ArtWell(72.dp, MapColors.divineWell) { MapIcon("site:divine-solo-active", 64.dp) }
        ParchLine(ui.prizeLine, Modifier.weight(1f), maxLines = 4)
    }
    ui.lastWeek?.let { lw ->
        MapSectionHeader("LAST WEEK")
        MapRow {
            ArtWell(48.dp, MapColors.divineWell) { MapIcon("site:divine-solo-active", 32.dp) }
            RowText(lw.title, lw.sub)
            if (lw.held) RowTag(MapTagUi("HELD", Verb.MOSS))
        }
    }
    ParchLine(ui.footnote, secondary = true, center = true)
}

/** §D: the prize row's lavender (`#ECE1F6`, not a TOKENS.json colour). */
private val TRIALS_LAVENDER = Color(0xFFECE1F6)

/** The fixed army as 32 minis (portrait 28 + outlined count), the hero at 24 in a gold-rim mini; skeleton while loading. */
@Composable private fun ArmyMinis(army: List<ArmyTileUi>, hero: String?, loading: Boolean) {
    val said = army.joinToString(", ") { it.description.ifBlank { "${it.count} ${it.troop}" } } + (hero?.let { ", and your hero" } ?: "")
    Row(Modifier.clearAndSetSemantics { contentDescription = "The army: $said" }, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (army.isEmpty() && loading) repeat(4) { SkeletonBlock(Modifier.size(32.dp), dark = true) }
        army.forEach { t ->
            Box(Modifier.size(36.dp)) {
                ArtWell(32.dp, PkwTokens.Colors.charcoal) { PkwIcon(t.portrait, 28.dp) }
                PkwText(t.count.removePrefix("x"), PkwTokens.Type.caption, Modifier.align(Alignment.BottomEnd).offset(x = 2.dp, y = 2.dp),
                    color = PkwTokens.Colors.label, outline = 1.dp)
            }
        }
        hero?.let {
            Box(Modifier.size(32.dp).border(2.dp, PkwTokens.Colors.gold.face).padding(2.dp).background(PkwTokens.Colors.charcoal),
                contentAlignment = Alignment.Center) { PkwIcon(it, 24.dp) }
        }
    }
}

/** TRIES LEFT (96): PS 16 count + "of 3" + the pips (pop in with a 40 ms stagger). "…" when unknown. The frame's "this
 *  week" is dropped: the rules count tries per trial event and name no week. */
@Composable private fun TriesCard(left: Int?, max: Int?, modifier: Modifier) {
    val said = if (left == null || max == null) "Tries left unknown" else "$left of $max tries left"
    Plate(PlateKind.CREAM, modifier.heightIn(min = 96.dp).clearAndSetSemantics { contentDescription = said }, blocksScene = false) {
        Column(Modifier.fillMaxWidth().padding(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            PkwText("TRIES LEFT", PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText(left?.toString() ?: UNKNOWN, PkwTokens.Type.numeralL, color = PkwTokens.Colors.textOnParch)
                PkwText("of ${max?.toString() ?: UNKNOWN}", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            }
            triesFills(left, max)?.let { Pips(it, said, animate = true) }
        }
    }
}

/** YOUR BEST (96): three stars 24 + PS 12 %, VT "Rank 37 of 412"; a new best flashes the card gold 2 × 120 ms. */
@Composable private fun BestCard(best: TrialBestUi?, flash: Boolean, modifier: Modifier) {
    val reduced = LocalReducedMotion.current || LocalInspectionMode.current
    val glow = remember { Animatable(0f) }
    LaunchedEffect(flash) {
        if (flash && !reduced) repeat(2) {
            glow.animateTo(1f, tween(BEST_FLASH_MS / 2)); glow.animateTo(0f, tween(BEST_FLASH_MS / 2)); delay(BEST_FLASH_MS.toLong() / 2)
        }
    }
    val said = if (best == null) "Your best: none yet" else "Your best: ${best.stars ?: UNKNOWN} stars, ${best.pct}, rank ${best.rank} of ${best.of}"
    Plate(PlateKind.CREAM, modifier.heightIn(min = 96.dp).clearAndSetSemantics { contentDescription = said }
        .drawWithContent { drawContent(); if (glow.value > 0f) drawRect(PkwTokens.Colors.gold.face.copy(alpha = 0.35f * glow.value)) }, blocksScene = false) {
        Column(Modifier.fillMaxWidth().padding(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            PkwText("YOUR BEST", PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
            if (best == null) PkwText("No attempt yet", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            else {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    trialStars(best.stars).forEach { lit -> PkwIcon("star", 24.dp, alpha = if (lit) 1f else 0.3f) }
                    PkwText(best.pct.ifBlank { UNKNOWN }, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                }
                PkwText("Rank ${best.rank.ifBlank { UNKNOWN }} of ${best.of.ifBlank { UNKNOWN }}", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            }
        }
    }
}

/** §D: a new best flashes gold twice, 120 ms each. */
private const val BEST_FLASH_MS = 120

/** STANDINGS: the ladder rows, the gold rule before the first rank past the cutoff, your row pinned under the list. */
@Composable private fun StandingsBody(ui: DivineTrialsUi, on: DivineTrialsActions, modifier: Modifier) {
    val ladder = ui.standings
    if (ladder == null || ladder.rows.isEmpty()) {
        ParchLine(if (ui.load == LoadState.Loading) UNKNOWN else "No scores yet this week.", secondary = true, center = true)
        return
    }
    val rule = topCutoffIndex(ladder.rows.map { it.rank }, ui.cutoff)
    LazyColumn(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        itemsIndexed(ladder.rows, key = { _, r -> r.id }) { i, row ->
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (i == rule) CutoffRule(ui.cutoff)
                StandingRow(row) { on.onRow(row.id) }
            }
        }
    }
    ladder.you?.let { you ->
        Box(Modifier.fillMaxWidth().padding(top = 4.dp)) { StandingRow(you) { on.onRow(you.id) } }
    }
}

@Composable private fun CutoffRule(cutoff: Int) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).clearAndSetSemantics { contentDescription = "The top $cutoff hold an area" },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.weight(1f).height(3.dp).background(PkwTokens.Colors.gold.face))
        Tag("TOP $cutoff HOLD AN AREA", Verb.GOLD)
        Box(Modifier.weight(1f).height(3.dp).background(PkwTokens.Colors.gold.face))
    }
}

@Composable private fun StandingRow(row: LadderRowUi, onClick: () -> Unit) {
    val said = listOfNotNull("Rank ${row.rankText}", row.name, "you".takeIf { row.isYou }, "score ${row.trophies}").joinToString(", ")
    CardRow(variant = if (row.isYou) RowVariant.YOU else RowVariant.PLAIN, height = 52.dp, onClick = onClick, description = said) {
        RankMedal(row.rank, row.rankText)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText(row.name, PkwTokens.Type.body, Modifier.weight(1f, fill = false), color = PkwTokens.Colors.textOnParch)
                if (row.isYou) Tag("YOU", Verb.GOLD)
            }
            row.clanTag?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
        }
        PkwText(row.trophies, PkwTokens.Type.label, Modifier.width(72.dp), color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.End)
    }
}

/** The footer: stone BEST 112 × 64 (replay icon + "BEST") and the gold PLAN & FIGHT, both routed by [commandRoute]. */
@Composable private fun TrialsFooter(ui: DivineTrialsUi, on: DivineTrialsActions) {
    val p = ui.primary.copy(state = trialPrimaryState(ui.primary.state, ui.recovery != null),
        reason = if (ui.recovery != null && ui.primary.state == CommandState.ENABLED) "Your attempt is being checked" else ui.primary.reason)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ui.replay?.let { r ->
            val state = commandDrawState(r)
            ChunkyBox(PkwTokens.ramp(if (state == CommandState.ENABLED) Verb.STONE else Verb.OFF), {
                if (commandRoute(r) == CommandRoute.OPEN) on.onWatchBest() else on.onExplain(r.reason ?: r.caption)
            }, "Watch your best attempt", Modifier.size(112.dp, 64.dp)) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    PkwIcon("replay", 24.dp)
                    PkwText(r.caption, PkwTokens.Type.label, color = PkwTokens.Colors.label, outline = 1.dp)
                }
            }
        }
        PrimaryButton(p.caption, {
            when (commandRoute(p)) {
                CommandRoute.OPEN -> on.onPlan()
                CommandRoute.NEED_MORE, CommandRoute.EXPLAIN -> on.onExplain(p.reason ?: p.caption)
                CommandRoute.IGNORE -> Unit
            }
        }, Modifier.weight(1f), sub = p.sub, state = commandDrawState(p), reason = p.reason, badge = p.badge)
    }
}

// ---- Previews (divine-trials.png numbers; every number is a placeholder) ----

private val previewArmy = listOf(
    ArmyTileUi("highlander", "ui_portrait_highlander_t2", "L2", "x8", "8 Highlanders"),
    ArmyTileUi("plunderer", "ui_portrait_plunderer_t2", "L2", "x10", "10 Plunderers"),
    ArmyTileUi("cannon", "ui_portrait_cannon_t2", "L2", "x2", "2 Cannons"),
    ArmyTileUi("mage", "ui_portrait_mage_t2", "L2", "x2", "2 Mages"),
)

private val previewPlan = CommandUi(FeatureId("island.divine.trials.plan"), "trophy", "PLAN & FIGHT", null, true, CommandState.ENABLED, null, null,
    sub = "try 2 of 3 this week")
private val previewBest = CommandUi(FeatureId("island.divine.trials.best"), "replay", "BEST", null, false, CommandState.ENABLED, null, null)

private val previewTrials = DivineTrialsUi("Week 41", "3d 4h", previewArmy, "hero_vex_portrait", 2, 3, TrialBestUi(2, "68%", "37", "412"),
    "A solo area on the Divine Isle held for next week. It earns Crystal Fragments every day.",
    LastWeekUi("Rank 112 · solo area 212", "yours until Mon 00:00 UTC", true), previewPlan, previewBest,
    LadderUi("ALL", emptyList(), listOf(
        LadderRowUi("a", 1, "1", "league-sol", "Valewarden", "[SOL] Sunforge", "98%"),
        LadderRowUi("b", 2, "2", "league-sol", "Mira", "[IRN] Iron Wardens", "97%"),
        LadderRowUi("c", 499, "499", "league-gold", "Old Bramble", null, "41%"),
        LadderRowUi("d", 500, "500", "league-gold", "Seraphine", null, "41%"),
        LadderRowUi("e", 501, "501", "league-gold", "DuneLord", null, "40%")),
        you = LadderRowUi("me", 37, "37", "league-gold", "Rowan", "[IRN] Iron Wardens", "68%", isYou = true)),
    TRIALS_THIS_WEEK, null, LoadState.Ready)

@Composable private fun TrialsHost(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(MapColors.stage).padding(start = 4.dp, end = 4.dp, top = 104.dp)) { content() }
}

@Preview(name = "Solo Trials: THIS WEEK (divine-trials)", widthDp = 412, heightDp = 915)
@Composable private fun TrialsPreview() { TrialsHost { DivineTrialsSheet(previewTrials, DivineTrialsActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Solo Trials: STANDINGS with the top-500 rule", widthDp = 412, heightDp = 915)
@Composable private fun TrialsStandingsPreview() {
    TrialsHost { DivineTrialsSheet(previewTrials.copy(tab = TRIALS_STANDINGS), DivineTrialsActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Solo Trials: no tries left / not qualified", widthDp = 412, heightDp = 915)
@Composable private fun TrialsNoTriesPreview() {
    TrialsHost {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            DivineTrialsSheet(previewTrials.copy(triesLeft = 0, primary = previewPlan.copy(state = CommandState.DISABLED,
                reason = "No tries left · new trial Mon 00:00 UTC", sub = null)), DivineTrialsActions(), Modifier.weight(1f))
            DivineTrialsSheet(previewTrials.copy(primary = previewPlan.copy(state = CommandState.LOCKED, reason = "Needs Keep 8", sub = null), replay = null,
                best = null), DivineTrialsActions(), Modifier.weight(1f))
        }
    }
}

@Preview(name = "Solo Trials: loading, uncertain attempt, sending", widthDp = 412, heightDp = 915)
@Composable private fun TrialsStatesPreview() {
    TrialsHost {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            DivineTrialsSheet(previewTrials.copy(army = emptyList(), triesLeft = null, triesMax = null, best = TrialBestUi(null, UNKNOWN, UNKNOWN, UNKNOWN),
                load = LoadState.Loading, recovery = RecoveryUi("attempt-7", "Your attempt is being checked", "CHECK RESULT")),
                DivineTrialsActions(), Modifier.weight(1f))
            DivineTrialsSheet(previewTrials.copy(primary = previewPlan.copy(caption = "Sending your plan", state = CommandState.BUSY, sub = null)),
                DivineTrialsActions(), Modifier.weight(1f))
        }
    }
}

@Preview(name = "Solo Trials: no trial this week, error", widthDp = 412, heightDp = 915)
@Composable private fun TrialsEmptyPreview() {
    TrialsHost {
        DivineTrialsSheet(previewTrials.copy(emptyLine = "No trial this week · next opens Mon", triesLeft = null, best = null, lastWeek = null,
            load = LoadState.Error("Can't reach the isle.", asOf = "14:02"), primary = previewPlan.copy(state = CommandState.LOCKED,
                reason = "Next trial opens Mon 00:00 UTC", sub = null)), DivineTrialsActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Army minis", widthDp = 412, heightDp = 80)
@Composable private fun ArmyMinisPreview() {
    Row(Modifier.background(PkwTokens.Colors.cream).padding(8.dp)) { ArmyMinis(previewArmy, "hero_vex_portrait", false); Spacer(Modifier.width(8.dp)) }
}
