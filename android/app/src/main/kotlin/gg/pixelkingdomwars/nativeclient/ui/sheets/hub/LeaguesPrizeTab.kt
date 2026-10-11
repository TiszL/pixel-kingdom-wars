package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: Leagues › PRIZE (owner 2026-10-06: "show live prize and potential winners before season ends").
 * No frame was drawn for it, so it is composed only from the hub kit used by `leagues-rewards.png` and `ladder.png`:
 * - the payout card 92 of REWARDS, re-labelled "SEASON ENDS IN" (timer 36, PS 16 countdown, VT 18 close line; right:
 *   "your place" + PS 12 place + green PLACED / stone NOT YET);
 * - "PRIZE POT · live · in SKR": a cream card with SKR 36, PS 16 pot and a stone TEST POT tag on a devnet test pot, the
 *   share line under it; with no pot, the designed not-available line ("The prize pot is not set yet."), never a number;
 * - "WINNERS NOW · if the week closed now": ten CardRows 52 in the LADDER row shape (RankMedal, crest 20, VT name +
 *   YOU tag, VT 18 score line, the SKR CostPill); an unfilled place is a `dim` row "Open place";
 * - the shared bands (places 11–100, 101–500) as CardRows 56 with the per-place SKR pill and "each";
 * - the player's own row pinned in an opaque parchment strip with the 24 dp fade above it (LADDER pinning);
 * - footnote VT 18.
 * Loading: skeleton rows inside the real shells and "…" values; error: ErrorRow (§3.6) over the kept view at 60 %.
 * Every number is a server string from the mapper. The red FIND A MATCH footer and the header are the Leagues card's.
 */

/** One of places 1..10. */
@Immutable data class PrizeWinnerRowUi(
    val id: String,
    val place: Int,
    /** Crest art at 20, null for an open place. */
    val crest: String?,
    /** Kingdom name, or "Open place". */
    val name: String,
    /** "+27 this week · 400 trophies". */
    val line: String?,
    /** The place's SKR; null when no pot is set (no pill). */
    val prize: PriceUi?,
    val isYou: Boolean,
    /** No kingdom qualifies for this place yet: the `dim` row. */
    val open: Boolean,
)

/** A shared band ("Places 11–100"): every place in it is paid the same. */
@Immutable data class PrizeBandRowUi(val id: String, val title: String, val sub: String, val prizeEach: PriceUi?)

/** The player's pinned row. */
@Immutable data class PrizeYouRowUi(
    /** "#14" or "—". */
    val placeText: String,
    val crest: String,
    val name: String,
    /** What the place is, or what the kingdom still needs (server reason). */
    val line: String,
    val prize: PriceUi?,
)

/** Everything PRIZE draws. */
@Immutable data class LeaguePrizeUi(
    /** "4d 6h" ticking; null reads "…". */
    val endsIn: String?,
    /** "Week closes Mon 00:00 UTC". */
    val closesLine: String,
    /** "#14" / "—"; null reads "…". */
    val yourPlace: String?,
    val placeTag: StatusLook?,
    /** "10,000"; null = no pot set (the not-available line). */
    val pot: String?,
    /** A devnet test pot: the stone TEST POT tag. */
    val potTest: Boolean,
    /** "Top 10 share 30% · 11–100 share 35% · 101–500 share 35%". */
    val shareLine: String?,
    val winners: List<PrizeWinnerRowUi>,
    val bands: List<PrizeBandRowUi>,
    val you: PrizeYouRowUi?,
    /** "37 placed now". */
    val note: String?,
    val footnote: String,
    val load: LoadState,
)

/** The PRIZE tab body. Paint and the error row's RETRY / Report only; nothing here is a scrim. */
@Composable fun ColumnScope.LeaguesPrizeTab(ui: LeaguePrizeUi, onRetry: () -> Unit, onReport: () -> Unit) {
    val view = boardView(ui.load, ui.winners.isNotEmpty())
    // Nothing read yet (or a first read failed): values are unknown, never "not set".
    val loading = view == BoardView.SKELETON || view == BoardView.ERROR_EMPTY
    Box(Modifier.fillMaxWidth().weight(1f)) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            (ui.load as? LoadState.Error)?.let { ErrorRow(it, onRetry, onReport) }
            CountdownCard(ui, loading)
            SectionHeader("PRIZE POT", note = "live · in SKR")
            PotCard(ui, loading)
            SectionHeader("WINNERS NOW", note = if (view == BoardView.REFRESHING || loading) "reading the season board…" else "if the week closed now",
                right = ui.note.takeUnless { loading })
            when (view) {
                BoardView.SKELETON -> repeat(5) { SkeletonRow(height = 52.dp) }
                BoardView.ERROR_EMPTY -> Unit
                else -> Column(Modifier.graphicsLayer { alpha = boardAlpha(view) }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    ui.winners.forEach { WinnerRow(it) }
                    if (ui.bands.isNotEmpty()) SectionHeader("SHARED PLACES", note = "same prize for each place")
                    ui.bands.forEach { BandRow(it) }
                }
            }
            PkwText(ui.footnote, PkwTokens.Type.small, Modifier.fillMaxWidth().padding(top = 6.dp), color = PkwTokens.Colors.textOnParch2,
                textAlign = TextAlign.Center)
            if (ui.you != null) Spacer(Modifier.height(64.dp))
        }
        // The player's row is pinned (LADDER rule), full strength even under an error, with the 24 dp fade above it.
        ui.you?.let { you ->
            Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
                Box(Modifier.fillMaxWidth().height(24.dp).background(Brush.verticalGradient(listOf(Color.Transparent, PkwTokens.Colors.parchment))))
                Box(Modifier.fillMaxWidth().background(PkwTokens.Colors.parchment).padding(top = 4.dp)) { YouRow(you) }
            }
        }
    }
}

/** The payout card shape of REWARDS: timer 36, "SEASON ENDS IN", PS 16 countdown, close line; your place + tag. */
@Composable private fun CountdownCard(ui: LeaguePrizeUi, loading: Boolean) {
    val time = if (loading) UNKNOWN else ui.endsIn ?: UNKNOWN
    val place = if (loading) UNKNOWN else ui.yourPlace ?: UNKNOWN
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 92.dp).clearAndSetSemantics {
        contentDescription = listOfNotNull("Season ends in $time", ui.closesLine, "your place $place", ui.placeTag?.label).joinToString(". ")
    }, blocksScene = false) {
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            HubArt("timer", 36.dp)
            Column(Modifier.weight(1f)) {
                PkwText("SEASON ENDS IN", PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
                PkwText(time, PkwTokens.Type.numeralL, color = PkwTokens.Colors.textOnParch)
                PkwText(ui.closesLine, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                PkwText("your place", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                PkwText(place, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                if (!loading) ui.placeTag?.let { StatusTag(it.label, it.verb) }
            }
        }
    }
}

/** SKR 36, PS 16 pot (+ TEST POT), the share line; or the designed not-available line. */
@Composable private fun PotCard(ui: LeaguePrizeUi, loading: Boolean) {
    val spoken = when {
        loading -> "Prize pot loading"
        ui.pot == null -> "The prize pot is not set yet."
        else -> listOfNotNull("Prize pot ${ui.pot} SKR", "test pot".takeIf { ui.potTest }, ui.shareLine).joinToString(". ")
    }
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 72.dp).clearAndSetSemantics { contentDescription = spoken }, blocksScene = false) {
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Well("skr", light = true, iconSize = 36.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                when {
                    loading -> { SkeletonBlock(Modifier.fillMaxWidth(0.5f).height(18.dp)); SkeletonBlock(Modifier.fillMaxWidth(0.8f).height(12.dp)) }
                    ui.pot == null -> {
                        PkwText("The prize pot is not set yet.", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2, maxLines = 2)
                        ui.shareLine?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2) }
                    }
                    else -> {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            PkwText("${ui.pot} SKR", PkwTokens.Type.numeralL, color = PkwTokens.Colors.textOnParch)
                            if (ui.potTest) StatusTag("TEST POT", Verb.STONE)
                        }
                        ui.shareLine?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2) }
                    }
                }
            }
        }
    }
}

/** A place 1..10 in the LADDER row shape; the prize pill on the right; an open place is `dim`. */
@Composable private fun WinnerRow(row: PrizeWinnerRowUi) {
    val spoken = listOfNotNull("Place ${row.place}", row.name, "you".takeIf { row.isYou }, row.line,
        row.prize?.let { "prize ${it.amount} SKR" }).joinToString(", ")
    Box(Modifier.clearAndSetSemantics { contentDescription = spoken }) {
        CardRow(variant = when { row.isYou -> RowVariant.YOU; row.open -> RowVariant.DIM; else -> RowVariant.PLAIN }, height = 52.dp) {
            RankMedal(row.place, row.place.toString())
            if (row.crest != null) HubArt(row.crest, 20.dp) else Spacer(Modifier.width(20.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PkwText(row.name, PkwTokens.Type.body, Modifier.weight(1f, fill = false),
                        color = if (row.open) PkwTokens.Colors.textOnParch2 else PkwTokens.Colors.textOnParch)
                    if (row.isYou) StatusTag("YOU", Verb.GOLD)
                }
                row.line?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
            }
            row.prize?.let { PriceChip(it) }
        }
    }
}

/** A shared band: title + "90 places · 23 filled now", the per-place pill and "each". */
@Composable private fun BandRow(row: PrizeBandRowUi) {
    Box(Modifier.clearAndSetSemantics {
        contentDescription = listOfNotNull(row.title, row.sub, row.prizeEach?.let { "${it.amount} SKR each" }).joinToString(", ")
    }) {
        CardRow(height = 56.dp) {
            Well("trophy", light = true, iconSize = 24.dp)
            RowText(row.title, row.sub)
            row.prizeEach?.let {
                Column(horizontalAlignment = Alignment.End) {
                    PriceChip(it)
                    PkwText("each", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                }
            }
        }
    }
}

/** The pinned `you` row: place text, crest, name + YOU, the line, the prize pill when placed. */
@Composable private fun YouRow(row: PrizeYouRowUi) {
    Box(Modifier.clearAndSetSemantics {
        contentDescription = listOfNotNull("Your place ${row.placeText}", row.name, row.line, row.prize?.let { "prize ${it.amount} SKR" }).joinToString(", ")
    }) {
        CardRow(variant = RowVariant.YOU, height = 52.dp) {
            RankMedal(null, row.placeText)
            HubArt(row.crest, 20.dp)
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PkwText(row.name, PkwTokens.Type.body, Modifier.weight(1f, fill = false), color = PkwTokens.Colors.textOnParch)
                    StatusTag("YOU", Verb.GOLD)
                }
                PkwText(row.line, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 1)
            }
            row.prize?.let { PriceChip(it) }
        }
    }
}

// ---- Previews (every number is a placeholder) ----

private fun skr(amount: String) = PriceUi(Currency.SKR, amount, PriceStatus.OK)

internal val samplePrize = LeaguePrizeUi(
    endsIn = "4d 6h", closesLine = "Week closes Mon 00:00 UTC", yourPlace = "#14", placeTag = StatusLook("PLACED", Verb.GREEN, false),
    pot = "10,000", potTest = true, shareLine = "Top 10 share 30% · 11–100 share 35% · 101–500 share 35%",
    winners = listOf(
        PrizeWinnerRowUi("a", 1, "league-sol", "Valewarden", "+42 this week · 2,914 trophies", skr("600"), false, false),
        PrizeWinnerRowUi("b", 2, "league-sol", "Mira", "+37 this week · 2,770 trophies", skr("450"), false, false),
        PrizeWinnerRowUi("c", 3, "league-gold", "kryptoknight", "+31 this week · 1,655 trophies", skr("360"), false, false),
        PrizeWinnerRowUi("open:4", 4, null, "Open place", "No kingdom qualifies yet", skr("300"), false, true),
    ),
    bands = listOf(PrizeBandRowUi("band:2", "Places 11–100", "90 places · 4 filled now", skr("38.88")),
        PrizeBandRowUi("band:3", "Places 101–500", "400 places · 0 filled now", skr("8.75"))),
    you = PrizeYouRowUi("#14", "league-gold", "Rowan", "+5 trophies this week", skr("38.88")),
    note = "14 placed now", footnote = "Projected from this week's rated raids. Places are set when the week closes. One kingdom per wallet.",
    load = LoadState.Ready,
)
