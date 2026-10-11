package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.TimerUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: Leagues (design/final/hub/leagues.png) with its LADDER tab (ladder.png), the in-card loading
 * (leagues-loading.png) and the error state with kept data (ladder-error.png); SPEC §2.2, §3.4, §3.6.
 * Destination: `Leagues(tab)` (FULL card). Tabs LEAGUE · LADDER · REWARDS. The one primary is red FIND A MATCH on every tab.
 */

/** One league tier row (highest first). */
@Immutable data class LeagueTierRowUi(
    val id: String,
    /** Crest art ("league-sol"), drawn at 40 dp in a dark Well. */
    val crest: String,
    /** "Sol league". */
    val name: String,
    /** "1,500 trophies". */
    val threshold: String,
    /** The weekly reward pill (ok state); null draws none. */
    val reward: PriceUi?,
    /** The player's tier: `you` row, YOU tag, gold meter. */
    val isYou: Boolean,
    /** 0..1 to the next tier for the YOU meter; null draws an empty track. */
    val progress: Float?,
    /** "216 to Sol". */
    val progressLabel: String?,
)

/** One ladder row. */
@Immutable data class LadderRowUi(
    val id: String,
    /** 1, 2, 3 draw a medal; others and null draw [rankText]. */
    val rank: Int?,
    /** "214" or "…". */
    val rankText: String,
    /** The 20 dp league crest. */
    val crest: String,
    val name: String,
    /** "[IRN] Iron Wardens", or null for "no clan". */
    val clanTag: String?,
    /** "2,914". */
    val trophies: String,
    val isYou: Boolean = false,
)

/** The LADDER tab. */
@Immutable data class LadderUi(
    /** The active filter id ("PLAYERS", "CLANS", "FRIENDS"). */
    val filter: String,
    /** The filter chips. */
    val filters: List<FilterChipUi>,
    /** Rows, best first. */
    val rows: List<LadderRowUi>,
    /** The player's own row, pinned at the bottom; null hides the strip. */
    val you: LadderRowUi?,
    /** Shown when [rows] is empty (FRIENDS: "No friends yet" + INVITE). */
    val empty: EmptyStateUi? = null,
)

/** One past week on REWARDS (history only). */
@Immutable data class LeagueWeekUi(
    val id: String,
    /** "Week 41". */
    val week: String,
    val crest: String,
    val shards: PriceUi?,
    val items: List<ItemTileUi>,
    /** "Settled Mon 14 Sep". */
    val settled: String,
)

/** Everything Leagues draws (SPEC §2.2 State; fields after `load` were added with defaults). */
@Immutable data class LeaguesUi(
    /** The crest art of the player's league ("league-gold"), drawn at 80 dp. */
    val tier: String,
    /** "GOLD LEAGUE". */
    val tierName: String,
    /** Trophies; known from the session even while the board loads. "…" when unknown. */
    val trophies: String,
    /** "Sol league at 1,500"; null draws none. */
    val nextLine: String?,
    /** "4d 6h" for the "Week ends" chip; null hides the chip. */
    val weekEnds: String?,
    /** Rated ATTACKS this week (the server counts attacks, never wins: [ratedAttacksLabel]); null = unknown (no pips, "…"). */
    val wins: Int?,
    /** Server `minRatedAttacks`; the pip count. */
    val winsNeeded: Int?,
    /** "12,000" shard reward; null with no reward. */
    val rewardShards: String?,
    /** Item rewards (catalogue icon 32 + count). */
    val rewardItems: List<ItemTileUi>,
    /** "2 more rated attacks earn it. Paid at Keep 12."; null draws none. */
    val rewardNote: String?,
    /** Tier rows, highest first. */
    val tiers: List<LeagueTierRowUi>,
    /** The LADDER tab; null while never loaded. */
    val ladder: LadderUi?,
    /** REWARDS tab rows. */
    val pastWeeks: List<LeagueWeekUi>,
    /** Server footnote ("Paid Mon 00:00 UTC · one kingdom per wallet"). */
    val footnote: String?,
    /** "LEAGUE", "LADDER" or "REWARDS". */
    val selectedTab: String,
    /** The board's data state. */
    val load: LoadState,
    val tabs: List<TabUi> = leaguesTabs(),
    /** SHARDS only (the currency the league pays out). */
    val readouts: List<ResourceChipUi> = emptyList(),
    /** VT beside "ATTACKS 3/5". */
    val winsLine: String = "rated attacks on kingdoms",
    /** False: the reward card says "League rewards are not set on this server yet." */
    val rewardsConfigured: Boolean = true,
    /** FIND A MATCH stays live while the board loads; DISABLED / LOCKED with a reason when the server says so. */
    val findMatchState: CommandState = CommandState.ENABLED,
    val findMatchReason: String? = null,
)

/** Up to this many tabs fit 412 dp with icon + label; more use the compact strip (the active tab keeps its label). */
internal const val LEAGUE_TABS_WITH_LABELS = 3

/** LEAGUE (trophy) · LADDER (star) · REWARDS (replay) · PRIZE (skr; owner 2026-10-06: the live season prize and winners). */
fun leaguesTabs(): List<TabUi> = listOf(
    TabUi("LEAGUE", "trophy", "LEAGUE", null, false),
    TabUi("LADDER", "star", "LADDER", null, false),
    TabUi("REWARDS", "replay", "REWARDS", null, false),
    TabUi("PRIZE", "skr", "PRIZE", null, false),
)

/** Leagues callbacks. */
@Immutable data class LeaguesActions(
    val onTab: (String) -> Unit = {},
    val onFilter: (String) -> Unit = {},
    /** A ladder row: opens the player half sheet (scout link; out of scope tonight). */
    val onRow: (String) -> Unit = {},
    /** FIND A MATCH → `RaidChooser(MATCH)`. */
    val onFindMatch: () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onReport: () -> Unit = {},
    val onClose: () -> Unit = {},
    /** The empty FRIENDS ladder's INVITE. */
    val onEmptyGo: (FeatureId) -> Unit = {},
)

/**
 * The Leagues card. [modifier] is the FULL-card area (see [HubCard]).
 *
 * Pointer rule: the root is the plain [HubCard] Column; only the painted frame, rows, chips and buttons take touches.
 * The FULL-card scrim is the SheetHost's, only while shown.
 */
@Composable fun LeaguesSheet(ui: LeaguesUi, on: LeaguesActions, modifier: Modifier = Modifier) {
    HubCard(modifier, readouts = ui.readouts, tabs = ui.tabs, selectedTab = ui.selectedTab, onTab = on.onTab,
        footer = {
            PrimaryButton("FIND A MATCH", on.onFindMatch, Modifier.weight(1f), verb = Verb.RED, icon = "attack",
                state = ui.findMatchState, reason = ui.findMatchReason)
        },
        header = { LeaguesHeader(ui, on.onClose) }, compactTabs = ui.tabs.size > LEAGUE_TABS_WITH_LABELS) {
        when (ui.selectedTab) {
            "LADDER" -> LadderBody(ui, on)
            "REWARDS" -> RewardsBody(ui)
            else -> LeagueBody(ui, on)
        }
    }
}

@Composable private fun LeaguesHeader(ui: LeaguesUi, onClose: () -> Unit) {
    LivingHeader(onClose, stage = HeaderStage.SUNRAYS, rayCentre = Offset(0.18f, 0.48f),
        timer = ui.weekEnds?.let { TimerUi("Week ends $it", "The league week ends in $it") }) {
        HubArt(ui.tier, 80.dp, Modifier.align(Alignment.CenterStart).padding(start = 28.dp), contentDescription = ui.tierName)
        Column(Modifier.align(Alignment.TopStart).padding(start = 124.dp, top = 12.dp, end = 64.dp)
            .clearAndSetSemantics { contentDescription = listOfNotNull(ui.tierName, "${ui.trophies} trophies", ui.nextLine).joinToString(". ") },
            verticalArrangement = Arrangement.spacedBy(2.dp)) {
            PkwText(ui.tierName, PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                HubArt("trophy", 36.dp)
                PkwText(ui.trophies, PkwTokens.Type.numeralL, color = PkwTokens.Colors.label, outline = 2.dp)
            }
            ui.nextLine?.let { PkwText(it, PkwTokens.Type.body, color = PkwTokens.Colors.text) }
        }
    }
}

@Composable private fun ColumnScope.LeagueBody(ui: LeaguesUi, on: LeaguesActions) {
    val view = boardView(ui.load, ui.tiers.isNotEmpty())
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionHeader("THIS WEEK'S REWARD")
        Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 124.dp), blocksScene = false) {
            when {
                view == BoardView.SKELETON -> Column(Modifier.fillMaxWidth().padding(6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SkeletonBlock(Modifier.fillMaxWidth(0.45f).height(14.dp))
                    SkeletonBlock(Modifier.fillMaxWidth().height(14.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { SkeletonBlock(Modifier.size(116.dp, 58.dp)); SkeletonBlock(Modifier.size(58.dp)) }
                }
                !ui.rewardsConfigured -> PkwText("League rewards are not set on this server yet.", PkwTokens.Type.body,
                    Modifier.align(Alignment.Center).padding(8.dp), color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center, maxLines = 2)
                else -> Column(Modifier.fillMaxWidth().padding(6.dp).graphicsLayer { alpha = boardAlpha(view) }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PkwText(ratedAttacksLabel(ui.wins, ui.winsNeeded), PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                        PkwText(ui.winsLine, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                    }
                    pipFills(ui.wins, ui.winsNeeded)?.let { Pips(it, ratedAttacksSpoken(ui.wins, ui.winsNeeded), height = 18.dp, animate = true) }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ui.rewardShards?.let { shards ->
                            Plate(PlateKind.CREAM, Modifier.size(116.dp, 58.dp).clearAndSetSemantics { contentDescription = "$shards Shards" }, blocksScene = false) {
                                Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    HubArt("shards", 24.dp); PkwText(shards, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                                }
                            }
                        }
                        ui.rewardItems.forEach { item ->
                            Plate(PlateKind.CREAM, Modifier.size(58.dp).clearAndSetSemantics { contentDescription = item.description }, blocksScene = false) {
                                HubArt(item.icon, 32.dp, Modifier.align(Alignment.Center))
                                PkwText(item.count, PkwTokens.Type.caption, Modifier.align(Alignment.BottomEnd), color = PkwTokens.Colors.textOnParch)
                            }
                        }
                        ui.rewardNote?.let { PkwText(it, PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch2, maxLines = 3) }
                    }
                }
            }
        }

        val loadingNote = if (view == BoardView.SKELETON || view == BoardView.REFRESHING) "reading the league board…" else "trophies never reset"
        SectionHeader("LEAGUES", note = loadingNote)
        when (view) {
            BoardView.SKELETON -> repeat(4) { SkeletonRow() }
            BoardView.ERROR_EMPTY -> (ui.load as? LoadState.Error)?.let { ErrorRow(it, on.onRetry, on.onReport) }
            else -> {
                if (view == BoardView.ERROR_KEPT) (ui.load as? LoadState.Error)?.let { ErrorRow(it, on.onRetry, on.onReport) }
                Column(Modifier.graphicsLayer { alpha = boardAlpha(view) }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    ui.tiers.forEach { TierRow(it) }
                }
            }
        }
    }
    ui.footnote?.let { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth().padding(top = 6.dp), color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center) }
}

@Composable private fun TierRow(row: LeagueTierRowUi) {
    val spoken = listOfNotNull(row.name, if (row.isYou) "your league" else row.threshold, row.progressLabel?.takeIf { row.isYou },
        row.reward?.let { "weekly reward ${it.amount ?: UNKNOWN} ${it.currency.name.lowercase()}" }).joinToString(", ")
    Box(Modifier.clearAndSetSemantics { contentDescription = spoken }) {
        CardRow(variant = if (row.isYou) RowVariant.YOU else RowVariant.PLAIN, height = 62.dp) {
            Well(row.crest, iconSize = 40.dp)
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PkwText(row.name, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                    if (row.isYou) StatusTag("YOU", Verb.GOLD)
                }
                if (row.isYou) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    YouMeter(row.progress, row.progressLabel ?: "")
                    row.progressLabel?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
                } else PkwText(row.threshold, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            }
            row.reward?.let { PriceChip(it) }
        }
    }
}

/** The YOU row's gold meter 96 × 12: fills from 0 over 600 ms on first show (none with reduced motion). */
@Composable private fun YouMeter(progress: Float?, label: String) {
    val reduced = LocalReducedMotion.current
    val still = reduced || LocalInspectionMode.current
    val fill = remember { Animatable(if (still) (progress ?: 0f) else 0f) }
    LaunchedEffect(progress) {
        val target = (progress ?: 0f).coerceIn(0f, 1f)
        if (still) fill.snapTo(target) else fill.animateTo(target, tween(PkwTokens.Motion.COUNT_UP, easing = PkwTokens.Motion.Out))
    }
    ProgressBar(if (progress == null) null else fill.value, label, Modifier.width(96.dp), verb = Verb.GOLD, height = 12.dp)
}

@Composable private fun ColumnScope.LadderBody(ui: LeaguesUi, on: LeaguesActions) {
    val ladder = ui.ladder
    if (ladder != null) FilterChipStrip(ladder.filters, ladder.filter, on.onFilter, Modifier.padding(bottom = 6.dp))
    val rows = ladder?.rows.orEmpty()
    val view = boardView(ui.load, rows.isNotEmpty())
    (ui.load as? LoadState.Error)?.let { if (view == BoardView.ERROR_KEPT || view == BoardView.ERROR_EMPTY) ErrorRow(it, on.onRetry, on.onReport, Modifier.padding(bottom = 4.dp)) }
    val empty = ladder?.empty
    Box(Modifier.fillMaxWidth().weight(1f)) {
        when {
            view == BoardView.SKELETON -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) { repeat(5) { SkeletonRow(height = 52.dp) } }
            // SPEC §3.5 hub EmptyState inside the body: no second parchment plate (owner screenshot 8 drew rules above and
            // below it), at most one blue button 220 wide.
            rows.isEmpty() && empty != null -> HubEmptyState(empty.headline, empty.reason, Modifier.align(Alignment.Center).padding(bottom = 40.dp),
                icon = empty.icon, goLabel = empty.goLabel, onGo = empty.go?.let { go -> { on.onEmptyGo(go) } })
            else -> LazyColumn(Modifier.fillMaxSize().graphicsLayer { alpha = boardAlpha(view) }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                items(rows, key = { it.id }) { row -> LadderRow(row) { on.onRow(row.id) } }
                item { Spacer(Modifier.height(24.dp)) }
            }
        }
        // The 24 dp parchment fade above the pinned row.
        if (ladder?.you != null) Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(24.dp)
            .background(Brush.verticalGradient(listOf(Color.Transparent, PkwTokens.Colors.parchment))))
    }
    // The player's pinned row stays at full strength, even under an error.
    ladder?.you?.let { you ->
        Box(Modifier.fillMaxWidth().background(PkwTokens.Colors.parchment).padding(top = 4.dp)) { LadderRow(you) { on.onRow(you.id) } }
    }
}

@Composable private fun LadderRow(row: LadderRowUi, onClick: () -> Unit) {
    val spoken = listOfNotNull("Rank ${row.rankText}", row.name, if (row.isYou) "you" else null, row.clanTag ?: "no clan", "${row.trophies} trophies").joinToString(", ")
    CardRow(variant = if (row.isYou) RowVariant.YOU else RowVariant.PLAIN, height = 52.dp, onClick = onClick, description = spoken) {
        RankMedal(row.rank, row.rankText)
        HubArt(row.crest, 20.dp)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText(row.name, PkwTokens.Type.body, Modifier.weight(1f, fill = false), color = PkwTokens.Colors.textOnParch)
                if (row.isYou) StatusTag("YOU", Verb.GOLD)
            }
            PkwText(row.clanTag ?: "no clan", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
        }
        HubArt("trophy", 24.dp)
        PkwText(row.trophies, PkwTokens.Type.label, Modifier.width(64.dp), color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.End)
    }
}

@Composable private fun ColumnScope.RewardsBody(ui: LeaguesUi) {
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionHeader("PAST WEEKS", note = "history only")
        if (ui.pastWeeks.isEmpty()) CardRow(variant = RowVariant.DIM) { RowText("No weeks settled yet", "Rewards show here after Monday's payout.") }
        ui.pastWeeks.forEach { week ->
            Box(Modifier.clearAndSetSemantics { contentDescription = listOfNotNull(week.week, week.settled, week.shards?.amount?.let { "$it Shards" }).joinToString(", ") }) {
                CardRow(height = 58.dp) {
                    Well(week.crest, iconSize = 40.dp)
                    RowText(week.week, week.settled)
                    week.items.take(2).forEach { HubArt(it.icon, 24.dp) }
                    week.shards?.let { PriceChip(it) }
                }
            }
        }
    }
}

// ---- Previews (leagues.png, ladder.png, leagues-loading.png, ladder-error.png numbers) ----

private fun ladderRow(rank: Int, name: String, tag: String?, trophies: String, crest: String = "league-sol", you: Boolean = false) =
    LadderRowUi("p$rank", rank, rank.toString(), crest, name, tag, trophies, you)

private val sampleLeagues = LeaguesUi(
    tier = "league-gold", tierName = "GOLD LEAGUE", trophies = "1,284", nextLine = "Sol league at 1,500", weekEnds = "4d 6h",
    wins = 3, winsNeeded = 5, rewardShards = "12,000",
    rewardItems = listOf(ItemTileUi("crownsteel", "ui:crystal-fragments", "2", "Crownsteel, 2")),
    rewardNote = "2 more rated attacks earn it. Paid at Keep 12.",
    tiers = listOf(
        LeagueTierRowUi("sol", "league-sol", "Sol league", "1,500 trophies", PriceUi(Currency.SHARDS, "20,000", PriceStatus.OK), false, null, null),
        LeagueTierRowUi("gold", "league-gold", "Gold league", "1,000 trophies", PriceUi(Currency.SHARDS, "12,000", PriceStatus.OK), true, 0.57f, "216 to Sol"),
        LeagueTierRowUi("silver", "league-silver", "Silver league", "400 trophies", PriceUi(Currency.SHARDS, "6,000", PriceStatus.OK), false, null, null),
        LeagueTierRowUi("bronze", "league-bronze", "Bronze league", "0 trophies", PriceUi(Currency.SHARDS, "2,000", PriceStatus.OK), false, null, null),
    ),
    ladder = LadderUi("PLAYERS", listOf(FilterChipUi("PLAYERS", "PLAYERS"), FilterChipUi("CLANS", "CLANS", icon = "itm_banner"), FilterChipUi("FRIENDS", "FRIENDS")),
        listOf(ladderRow(1, "Valewarden", "[SOL] Sunforge", "2,914"), ladderRow(2, "Mira", "[IRN] Iron Wardens", "2,770"),
            ladderRow(3, "kryptoknight", null, "2,655"), ladderRow(4, "Old Bramble", "[OAK] Oakmoot", "2,401", "league-gold"),
            ladderRow(5, "Seraphine", "[IRN] Iron Wardens", "2,388", "league-gold"), ladderRow(6, "DuneLord", "[SOL] Sunforge", "2,301", "league-gold")),
        you = ladderRow(214, "Rowan", "[IRN] Iron Wardens", "1,284", "league-gold", you = true)),
    pastWeeks = listOf(LeagueWeekUi("w40", "Week 40", "league-gold", PriceUi(Currency.SHARDS, "12,000", PriceStatus.OK), emptyList(), "Settled Mon 28 Sep")),
    footnote = "Paid Mon 00:00 UTC · one kingdom per wallet", selectedTab = "LEAGUE", load = LoadState.Ready,
    readouts = sampleShardsReadout,
)

@Preview(name = "Leagues (leagues.png)", widthDp = 412, heightDp = 915)
@Composable private fun LeaguesPreview() { HubPreviewStage { LeaguesSheet(sampleLeagues, LeaguesActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Leagues: loading keeps trophies (leagues-loading.png)", widthDp = 412, heightDp = 915)
@Composable private fun LeaguesLoadingPreview() {
    HubPreviewStage {
        LeaguesSheet(sampleLeagues.copy(tiers = emptyList(), wins = null, winsNeeded = null, rewardShards = null, rewardItems = emptyList(),
            rewardNote = null, load = LoadState.Loading), LeaguesActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Leagues: refreshing keeps the last good view", widthDp = 412, heightDp = 915)
@Composable private fun LeaguesRefreshingPreview() { HubPreviewStage { LeaguesSheet(sampleLeagues.copy(load = LoadState.Loading), LeaguesActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Ladder (ladder.png)", widthDp = 412, heightDp = 915)
@Composable private fun LadderPreview() { HubPreviewStage { LeaguesSheet(sampleLeagues.copy(selectedTab = "LADDER"), LeaguesActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Ladder: error with kept rows (ladder-error.png)", widthDp = 412, heightDp = 915)
@Composable private fun LadderErrorPreview() {
    HubPreviewStage {
        LeaguesSheet(sampleLeagues.copy(selectedTab = "LADDER", load = LoadState.Error("Can't reach the league board.", asOf = "14:02",
            safeLine = "Your trophies are safe.")), LeaguesActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Ladder: FRIENDS empty", widthDp = 412, heightDp = 915)
@Composable private fun LadderFriendsEmptyPreview() {
    HubPreviewStage {
        LeaguesSheet(sampleLeagues.copy(selectedTab = "LADDER", ladder = sampleLeagues.ladder?.copy(filter = "FRIENDS", rows = emptyList(),
            empty = EmptyStateUi("referral", "No friends yet", "Invite a friend and race them up the ladder.", "INVITE", FeatureId("profile.invite")))),
            LeaguesActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Leagues: no rewards configured, REWARDS tab", widthDp = 412, heightDp = 915)
@Composable private fun LeaguesNoRewardsPreview() {
    HubPreviewStage { LeaguesSheet(sampleLeagues.copy(rewardsConfigured = false), LeaguesActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Leagues: REWARDS tab", widthDp = 412, heightDp = 915)
@Composable private fun LeaguesRewardsPreview() { HubPreviewStage { LeaguesSheet(sampleLeagues.copy(selectedTab = "REWARDS"), LeaguesActions(), Modifier.fillMaxSize()) } }
