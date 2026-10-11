package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay
import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * Design component: the Founding Kingdoms event (design/final/hub/SPEC.md R2.2 + critic fix; event.png), registry row 10,
 * `Destination.Event(tab)`. A FULL card (WoodFrame y 60..901, world parked under 60 %): the living header (the player's own
 * current base, a dark 56 dp bottom gradient, the authored event banner with PS 11 "FOUNDING KINGDOMS", stone INFO 48
 * (rules) and red close 48, the VeilChip with the red LIVE tag + "day 9 of 21 · ends in 12d"), tabs POINTS · RANKS ·
 * PRIZES (Rule 7: "CAMPAIGN" already means the PvE stage map), then:
 * POINTS: the StandingCard (gold-rimmed, dark RANK well, PS 16 points, active days · best streak, the server's goal line),
 * TODAY with "120 / 300", one ActivityRow per scored activity (light 48 well, VT 20 what to do, a 120 dp meter + "2/5 · 20
 * each", blue GO 58 × 48 to the place that earns it; done rows green-rimmed with DONE), the footnote. No footer while
 * participating; before joining one gold JOIN THE EVENT. RANKS: ladder rows with points · active days · best streak, your
 * row pinned, "Updated 12m ago". PRIZES: prize cards by category; results carry the server's line.
 * Motion: the LIVE tag blinks once per 2 s (static under reduced motion); GO closes the card and flies the camera.
 */

/** Your standing (R2.2 `StandingUi`). */
@Immutable data class StandingUi(
    /** "14"; null reads "…". */
    val rank: String?,
    /** "2,340". */
    val points: String,
    val activeDays: Int,
    val bestStreak: Int,
    /** "Top 50 earn a founding spot" (server copy); null draws none. */
    val goalLine: String?,
)

/** One scored activity (R2.2 `ActivityUi`; `door` is a [HubLink] to the place that earns it). */
@Immutable data class ActivityUi(
    /** 24 / 32 dp art in the light well ("attack", "scout", "star", "r2:cache-chest", "alert"). */
    val icon: String,
    /** "Win a raid". */
    val title: String,
    val count: Int,
    /** 0 = no bar (the [sub] line shows instead). */
    val cap: Int,
    /** "20" (each). */
    val pointsEach: String,
    val done: Boolean,
    /** The place that earns it (`RaidChooser("MATCH")`, `DailyCache`, `Feedback`, …); null draws no GO. */
    val door: HubLink?,
    /** A row without a bar: the short VT 18 line that ends before GO ("scored once reviewed"). */
    val sub: String? = null,
)

/** One RANKS row. */
@Immutable data class RankRowUi(
    val id: String,
    /** 1, 2, 3 draw a medal. */
    val rank: Int?,
    val rankText: String,
    val name: String,
    /** "2,340". */
    val points: String,
    val activeDays: Int,
    val bestStreak: Int,
    val isYou: Boolean = false,
)

/** One PRIZES card (gameplay ladder, Daily Defender, Realm Explorer, Bug Scout, video). No money amounts on the surface. */
@Immutable data class PrizeUi(
    val id: String,
    val icon: String,
    /** "Daily Defender". */
    val title: String,
    /** How it is won ("Most raids defended on 10 days"). */
    val howWon: String,
    /** The server's award result for you ("You placed 3rd"); null before results. */
    val result: String? = null,
)

/** Everything the event card draws (R2.2 `EventUi`; fields after `checkpoint` were added with defaults). */
@Immutable data class EventUi(
    /** "FOUNDING KINGDOMS". */
    val name: String,
    val phase: EventPhase,
    /** "day 9 of 21". */
    val dayLine: String,
    /** "12d"; null hides "· ends in". */
    val endsIn: String?,
    /** "POINTS", "RANKS" or "PRIZES". */
    val tab: String,
    val joined: Boolean,
    /** Null before joining (the explainer shows) or while loading ("…"). */
    val standing: StandingUi?,
    /** "120". */
    val todayPoints: String,
    /** "300" (the daily cap). */
    val todayCap: String,
    val activities: List<ActivityUi>,
    val ranks: List<RankRowUi>,
    val prizes: List<PrizeUi>,
    /** The checkpoint could not be verified: a stone "Being checked" tag on the standing card (server retries). */
    val checkpoint: String?,
    /** The player's own current base, cropped for the 136 dp header; null draws the charcoal fallback. */
    val headerSnapshot: ImageBitmap? = null,
    val load: LoadState = LoadState.Ready,
    /** Disqualified: the blood-rimmed card with the server's reason. */
    val disqualified: String? = null,
    /** "Starts Wed 14 Oct" (UPCOMING). */
    val startsLine: String? = null,
    /** "Updated 12m ago" (RANKS). */
    val ranksUpdated: String? = null,
    /** Your RANKS row, pinned. */
    val you: RankRowUi? = null,
    /** JOIN is sending: stone dots. */
    val joining: Boolean = false,
    /** The JOIN receipt just landed: the small "You're in" banner. */
    val justJoined: Boolean = false,
    /** CLOSED results line (native): "These are the server's award results. This view does not confirm payment." */
    val resultsLine: String = "These are the server's award results. This view does not confirm payment.",
    val tabs: List<TabUi> = eventTabs(),
)

/** POINTS (streak flame) · RANKS (trophy) · PRIZES (banner). */
fun eventTabs(): List<TabUi> = listOf(
    TabUi("POINTS", "streak", "POINTS", null, false),
    TabUi("RANKS", "trophy", "RANKS", null, false),
    TabUi("PRIZES", "itm_banner", "PRIZES", null, false),
)

/** Event callbacks (R2.2 `EventActions`, with the hub's `HubLink` as the door; `onRetry` / `onReport` added). */
@Immutable data class EventActions(
    val onTab: (String) -> Unit = {},
    /** A row's GO: close the card, fly the camera, open the place. */
    val onDoor: (HubLink) -> Unit = {},
    val onJoin: () -> Unit = {},
    /** The header INFO: the rules. */
    val onRules: () -> Unit = {},
    val onClose: () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onReport: () -> Unit = {},
)

/**
 * The event FULL card. [modifier] is the FULL-card area (see [HubCard]).
 *
 * Pointer rule: the root is the plain [HubCard] Column; only the painted frame, tabs, rows and buttons take touches. The
 * 60 % FULL-card scrim is the SheetHost's, under it, only while shown.
 */
@Composable fun EventSheet(ui: EventUi, on: EventActions, modifier: Modifier = Modifier) {
    HubCard(modifier, tabs = ui.tabs, selectedTab = ui.tab, onTab = on.onTab,
        footer = if (!eventShowsJoin(ui.phase, ui.joined)) null else ({
            if (ui.joining) PrimaryButton("Joining", {}, Modifier.weight(1f), state = CommandState.BUSY)
            else PrimaryButton("JOIN THE EVENT", on.onJoin, Modifier.weight(1f), sub = "Participation is optional")
        }),
        header = { EventHeader(ui, on) }) {
        when (ui.tab) {
            "RANKS" -> RanksBody(ui, on)
            "PRIZES" -> PrizesBody(ui)
            else -> PointsBody(ui, on)
        }
    }
}

@Composable private fun EventHeader(ui: EventUi, on: EventActions) {
    LivingHeader(on.onClose, stage = HeaderStage.NONE) {
        val snap = ui.headerSnapshot
        if (snap != null) Canvas(Modifier.fillMaxSize()) {
            val k = maxOf(1, ceil(maxOf(size.width / snap.width, size.height / snap.height)).toInt())
            val w = snap.width * k; val h = snap.height * k
            drawImage(snap, IntOffset.Zero, IntSize(snap.width, snap.height),
                IntOffset(((size.width - w) / 2f).roundToInt(), ((size.height - h) / 2f).roundToInt()), IntSize(w, h), filterQuality = FilterQuality.None)
        } else Box(Modifier.fillMaxSize().background(PkwTokens.Colors.charcoal))
        // The dark 56 dp gradient at the bottom, under the chip.
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(56.dp)
            .background(Brush.verticalGradient(listOf(Color.Transparent, PkwTokens.Colors.ink.copy(alpha = 0.7f)))))
        // The authored event banner (96 × 24) at the largest whole scale that fits 240 × 60, with the event name on it.
        Box(Modifier.align(Alignment.TopStart).padding(start = 8.dp, top = 8.dp).size(240.dp, 60.dp), contentAlignment = Alignment.Center) {
            R2HubArt("r2:banner-event", 240.dp, height = 60.dp)
            PkwText(ui.name, PkwTokens.Type.caption, color = PkwTokens.Colors.ink)
        }
        // INFO sits left of the header's close at right 62 (event.html; LivingHeader draws only a gear there).
        IconSquare("info", Verb.STONE, on.onRules, "Event rules", Modifier.align(Alignment.TopEnd).padding(top = 6.dp, end = 62.dp))
        LiveChip(ui, Modifier.align(Alignment.BottomStart).padding(start = 6.dp, bottom = 6.dp))
    }
}

/** The bottom-left chip: red LIVE (blinks once per 2 s), VT 20 "day 9 of 21 · ends in" + gold-hi "12d". Paint only. */
@Composable private fun LiveChip(ui: EventUi, modifier: Modifier) {
    val reduced = LocalReducedMotion.current || LocalInspectionMode.current
    val blink = remember { Animatable(1f) }
    if (ui.phase == EventPhase.LIVE && !reduced) LaunchedEffect(Unit) {
        while (true) {
            delay(EVENT_LIVE_BLINK_MS - PkwTokens.Motion.BADGE_POP.toLong())
            blink.animateTo(0.35f, tween(PkwTokens.Motion.BADGE_POP / 2)); blink.animateTo(1f, tween(PkwTokens.Motion.BADGE_POP / 2))
        }
    }
    val label = when (ui.phase) { EventPhase.LIVE -> "LIVE"; EventPhase.UPCOMING -> "SOON"; EventPhase.CLOSED -> "ENDED" }
    val line = when (ui.phase) {
        EventPhase.UPCOMING -> ui.startsLine ?: UNKNOWN
        else -> ui.dayLine + if (ui.endsIn != null) " · ends in" else ""
    }
    Plate(PlateKind.VEIL, modifier.heightIn(min = PkwTokens.Dims.timerChipH)
        .clearAndSetSemantics { contentDescription = listOfNotNull(label, line, ui.endsIn).joinToString(" ") },
        contentPadding = PaddingValues(start = 4.dp, top = 2.dp, end = 8.dp, bottom = 2.dp), blocksScene = false) {
        Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Tag(label, if (ui.phase == EventPhase.LIVE) Verb.RED else Verb.STONE, Modifier.graphicsLayer { alpha = blink.value })
            PkwText(line, PkwTokens.Type.body, color = PkwTokens.Colors.text, outline = 1.dp)
            if (ui.phase == EventPhase.LIVE) ui.endsIn?.let { PkwText(it, PkwTokens.Type.body, color = PkwTokens.Colors.gold.hi, outline = 1.dp) }
        }
    }
}

/** R2.2 motion: the LIVE tag blinks once per 2 s. */
private const val EVENT_LIVE_BLINK_MS = 2_000L

@Composable private fun ColumnScope.PointsBody(ui: EventUi, on: EventActions) {
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        (ui.load as? LoadState.Error)?.let { ErrorRow(it, on.onRetry, on.onReport) }
        if (ui.justJoined) CardRow(variant = RowVariant.READY) { RowText("You're in", "Your points start counting today.") }
        StandingCard(ui)
        if (ui.phase == EventPhase.UPCOMING) {
            PkwText("The rules are behind INFO. Points start on day 1.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2)
            return@Column
        }
        // R2.2: the section line "TODAY" with the PS 11 gold-lip daily total, not the VT 18 column label.
        HubSectionLine("TODAY", right = todayPointsLine(ui.todayPoints, ui.todayCap))
        if (ui.activities.isEmpty()) CardRow(variant = RowVariant.DIM) { RowText("No scored activity yet.", null) }
        ui.activities.forEach { ActivityRow(it, ui.load == LoadState.Loading, on) }
        PkwText("Days count in UTC. Points are checked before they count.", PkwTokens.Type.small, Modifier.padding(top = 4.dp),
            color = PkwTokens.Colors.textOnParch2, maxLines = 2)
    }
}

/** The StandingCard (86): gold rim (blood + the server reason when disqualified); dark 64 well RANK / number; PS 16 points;
 *  active days · best streak; the goal line; a stone "Being checked" tag when the checkpoint could not be verified.
 *  Before joining it is the explainer. */
@Composable private fun StandingCard(ui: EventUi) {
    val s = ui.standing
    val dq = ui.disqualified
    val variant = when {
        dq != null -> RowVariant.ERROR
        s != null -> RowVariant.YOU
        else -> RowVariant.PLAIN
    }
    CardRow(variant = variant, height = 86.dp) {
        when {
            dq != null -> RowText("Not counted in this event", dq)
            !ui.joined && ui.phase != EventPhase.CLOSED -> RowText("Join to start earning points", "Daily raids, defences, stages and bug reports all count.")
            else -> {
                Box(Modifier.size(64.dp).background(PkwTokens.Colors.ink).padding(2.dp).background(HubColors.wellDark)
                    .clearAndSetSemantics { contentDescription = "Rank ${s?.rank ?: UNKNOWN}" }, contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        PkwText("RANK", PkwTokens.Type.caption, color = PkwTokens.Colors.muted, outline = 1.dp)
                        PkwText(s?.rank ?: UNKNOWN, PkwTokens.Type.numeralL, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                    }
                }
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PkwText(s?.points ?: UNKNOWN, PkwTokens.Type.numeralL, color = PkwTokens.Colors.textOnParch)
                        PkwText("points", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                    }
                    if (s != null) PkwText("${s.activeDays} active days · best streak ${s.bestStreak}", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                    s?.goalLine?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch) }
                }
                if (ui.checkpoint != null) StatusTag("Being checked", Verb.STONE)
            }
        }
    }
}

/** An ActivityRow (68): light 48 well, VT 20 title, the 120 dp meter (gold, green when done) + "2/5 · 20 each" or the
 *  short sub-line, then the blue GO 58 × 48 (or the green DONE tag; done rows green-rimmed). */
@Composable private fun ActivityRow(a: ActivityUi, loading: Boolean, on: EventActions) {
    val line = if (loading) UNKNOWN else activityLine(a.count, a.cap, a.pointsEach)
    val fill = activityFill(a.count, a.cap)
    CardRow(variant = if (a.done) RowVariant.READY else RowVariant.PLAIN, height = 68.dp) {
        // event.html: the chest at 28, the bug alert (16 art) and 32 px art at 32, the 24 px icons at 36.
        val art = when {
            a.icon.startsWith("r2:") -> 28.dp
            a.icon == "alert" || a.icon.startsWith("ui:") -> 32.dp
            else -> 36.dp
        }
        Well(null, light = true, size = 48.dp) { R2HubArt(a.icon, art) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            PkwText(a.title, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
            if (fill != null && a.sub == null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ProgressBar(if (loading) null else fill, "${a.title}: $line", Modifier.width(120.dp), verb = if (a.done) Verb.GREEN else Verb.GOLD, height = 12.dp)
                PkwText(line, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            } else a.sub?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
        }
        val door = a.door
        when {
            // event.html: DONE is the plain 22 dp green Tag (`.tag green`), not the 30 dp row-end tag.
            a.done -> StatusTag("DONE", Verb.GREEN)
            door != null -> GoButton({ on.onDoor(door) }, contentDescription = "Go: ${a.title}", modifier = Modifier.size(58.dp, 48.dp))
        }
    }
}

@Composable private fun ColumnScope.RanksBody(ui: EventUi, on: EventActions) {
    (ui.load as? LoadState.Error)?.let { ErrorRow(it, on.onRetry, on.onReport, Modifier.padding(bottom = 4.dp)) }
    ui.ranksUpdated?.let { SectionHeader("RANKS", note = it) }
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (ui.ranks.isEmpty()) {
            if (ui.load == LoadState.Loading) repeat(5) { SkeletonRow(height = 52.dp) }
            else CardRow(variant = RowVariant.DIM) { RowText("No ranks yet.", "Ranks show after the first scored day.") }
        }
        ui.ranks.forEach { RankRow(it) }
    }
    ui.you?.let { Box(Modifier.fillMaxWidth().background(PkwTokens.Colors.parchment).padding(top = 4.dp)) { RankRow(it) } }
}

@Composable private fun RankRow(row: RankRowUi) {
    val said = listOfNotNull("Rank ${row.rankText}", row.name, "you".takeIf { row.isYou }, "${row.points} points",
        "${row.activeDays} active days", "best streak ${row.bestStreak}").joinToString(", ")
    Box(Modifier.clearAndSetSemantics { contentDescription = said }) {
        CardRow(variant = if (row.isYou) RowVariant.YOU else RowVariant.PLAIN, height = 52.dp) {
            RankMedal(row.rank, row.rankText)
            RowText(row.name, "${row.activeDays} days · streak ${row.bestStreak}") { if (row.isYou) StatusTag("YOU", Verb.GOLD) }
            PkwText(row.points, PkwTokens.Type.label, Modifier.width(72.dp), color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.End)
        }
    }
}

@Composable private fun ColumnScope.PrizesBody(ui: EventUi) {
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (ui.prizes.isEmpty()) CardRow(variant = RowVariant.DIM) { RowText(UNKNOWN, null) }
        ui.prizes.forEach { p ->
            CardRow(height = 64.dp) {
                Well(p.icon, light = true)
                RowText(p.title, p.result ?: p.howWon)
            }
        }
        if (ui.phase == EventPhase.CLOSED || ui.prizes.any { it.result != null }) {
            PkwText(ui.resultsLine, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2)
        }
    }
}

// ---- Previews (event.png numbers; every number is a placeholder) ----

private val sampleEvent = EventUi(
    name = "FOUNDING KINGDOMS", phase = EventPhase.LIVE, dayLine = "day 9 of 21", endsIn = "12d", tab = "POINTS", joined = true,
    standing = StandingUi("14", "2,340", 9, 6, "Top 50 earn a founding spot"), todayPoints = "120", todayCap = "300",
    activities = listOf(
        ActivityUi("attack", "Win a raid", 2, 5, "20", false, sampleLink("raid.match")),
        ActivityUi("scout", "Answer a raider", 0, 3, "30", false, sampleLink("raid.revenge")),
        ActivityUi("star", "3-star a new stage", 1, 2, "40", false, sampleLink("raid.campaign")),
        ActivityUi("r2:cache-chest", "Claim the Daily Cache", 1, 1, "10", true, sampleLink("hud.dailyCache")),
        ActivityUi("alert", "Report a bug", 0, 0, "", false, sampleLink("settings.feedback"), sub = "scored once reviewed"),
    ),
    ranks = listOf(RankRowUi("a", 1, "1", "Valewarden", "4,120", 9, 9), RankRowUi("b", 2, "2", "Mira", "3,980", 9, 8),
        RankRowUi("c", 3, "3", "kryptoknight", "3,610", 8, 7)),
    prizes = listOf(PrizeUi("ladder", "trophy", "Gameplay ladder", "The top 50 by points earn a founding spot"),
        PrizeUi("defender", "shield", "Daily Defender", "Defend your kingdom on the most days"),
        PrizeUi("bug", "alert", "Bug Scout", "Reports the review team accepts")),
    checkpoint = null, ranksUpdated = "Updated 12m ago", you = RankRowUi("me", 14, "14", "Rowan", "2,340", 9, 6, isYou = true),
)

@Preview(name = "Event: POINTS (event.png)", widthDp = 412, heightDp = 915)
@Composable private fun EventPreview() { HubPreviewStage { EventSheet(sampleEvent, EventActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Event: not joined (JOIN footer)", widthDp = 412, heightDp = 915)
@Composable private fun EventJoinPreview() { HubPreviewStage { EventSheet(sampleEvent.copy(joined = false, standing = null), EventActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Event: RANKS", widthDp = 412, heightDp = 915)
@Composable private fun EventRanksPreview() { HubPreviewStage { EventSheet(sampleEvent.copy(tab = "RANKS"), EventActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Event: PRIZES, closed with results", widthDp = 412, heightDp = 915)
@Composable private fun EventPrizesPreview() {
    HubPreviewStage {
        EventSheet(sampleEvent.copy(tab = "PRIZES", phase = EventPhase.CLOSED, prizes = sampleEvent.prizes.mapIndexed { i, p -> if (i == 0) p.copy(result = "You placed 14th") else p }),
            EventActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Event: upcoming / disqualified / checkpoint being checked", widthDp = 412, heightDp = 915)
@Composable private fun EventStatesPreview() {
    HubPreviewStage {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            EventSheet(sampleEvent.copy(phase = EventPhase.UPCOMING, joined = false, standing = null, startsLine = "Starts Wed 14 Oct"), EventActions(), Modifier.weight(1f))
            EventSheet(sampleEvent.copy(checkpoint = "cp-9"), EventActions(), Modifier.weight(1f))
        }
    }
}

@Preview(name = "Event: loading, error, disqualified, joining", widthDp = 412, heightDp = 915)
@Composable private fun EventLoadingPreview() {
    HubPreviewStage {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            EventSheet(sampleEvent.copy(standing = sampleEvent.standing?.copy(rank = null), load = LoadState.Error("Can't reach the event board.", asOf = "14:02")),
                EventActions(), Modifier.weight(1f))
            EventSheet(sampleEvent.copy(disqualified = "Two kingdoms on one wallet."), EventActions(), Modifier.weight(1f))
            EventSheet(sampleEvent.copy(joined = false, standing = null, joining = true), EventActions(), Modifier.weight(1f))
        }
    }
}
