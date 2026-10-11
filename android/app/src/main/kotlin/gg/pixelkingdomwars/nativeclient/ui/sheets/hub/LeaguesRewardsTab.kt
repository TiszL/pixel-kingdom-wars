package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: Leagues › REWARDS (design/final/hub/SPEC.md part two §A + critic fix; leagues-rewards.png). REWARDS
 * is now "what every league pays each week" (a fixed table); the settled past weeks move behind the header History.
 * Body: the payout card 92 (timer 36; "NEXT REWARDS IN", PS 16 "4d 6h", "Week closes Mon 00:00 UTC"; right: "raids" +
 * PS 12 "3/3" + green EARNING / stone NOT YET / moss PAID), "EVERY WEEK · by league · trophies · Keep 12" with four
 * CardRows 62 (crest 40 in a Well, name + "from n", the Shards CostPill, item tiles 44 — your league is the `you` row with
 * YOU), the item legend (flame = Finisher's Seal, hourglass = Keg of Haste), "TOP 500 · on the ladder" (a `you` row with
 * SKR 36, "A share of the Seeker prize / Seeker Island · in SKR", "#37 you now"; hidden when the server sends none) and
 * the footnote. The red FIND A MATCH footer and the living header are the Leagues card's (see [LeaguesSheetR2]).
 *
 * Honest notes (SPEC): the top-500 SKR row has no repo source (owner must confirm; it renders only when the server
 * sends [LeagueRewardsUi.skrLine]); the Keg of Haste and Finisher's Seal icons do not exist (ART ASK) and the frames'
 * stand-ins must not ship: the mapper passes whatever item art the catalogue has.
 */

/** One league row (part two §A `LeagueRewardRowUi`). */
@Immutable data class LeagueRewardRowUi(
    /** Crest art ("league-sol"), 40 in a Well. */
    val crest: String,
    /** "Sol". */
    val name: String,
    /** "1,500" (critic fix: trophies, from the server's league table). */
    val fromTrophies: String,
    /** The weekly Shards (ok state; CHECKING "…" while loading). */
    val shards: PriceUi,
    /** Item tiles (icon 24 + count). */
    val items: List<ItemTileUi>,
    val isYou: Boolean,
)

/** The top-500 line (owner-unconfirmed; null hides the section). */
@Immutable data class SkrLineUi(
    /** "#37". */
    val rank: String,
    /** "A share of the Seeker prize". */
    val title: String = "A share of the Seeker prize",
    /** "Seeker Island · in SKR". */
    val note: String = "Seeker Island · in SKR",
)

/** Everything REWARDS draws (part two §A `LeagueRewardsUi`; fields after `load` were added with defaults). */
@Immutable data class LeagueRewardsUi(
    /** "4d 6h"; null reads "…". */
    val nextPayout: String?,
    /** "Week closes Mon 00:00 UTC". */
    val closesLine: String,
    /** Rated raids this week / the minimum (`LEAGUES.rewardMinAttackerRaids`); null = unknown ("…"). */
    val raidsDone: Int?,
    val raidsNeeded: Int?,
    /** True EARNING, false NOT YET, null no tag ([earningTag]). */
    val earning: Boolean?,
    /** Highest league first. */
    val tiers: List<LeagueRewardRowUi>,
    val skrLine: SkrLineUi?,
    /** "Rewards go to one kingdom per wallet."; null draws none. */
    val footnote: String?,
    val load: LoadState,
    /** The week's payout landed: the tag flips to moss PAID (the payout itself arrives as a Mail letter + herald). */
    val paid: Boolean = false,
    /** False: "League rewards are not set on this server yet." in the card, rows hidden. */
    val configured: Boolean = true,
    /** The deed gate (no landed kingdom): the stone row "Rewards need a kingdom with land · GET LAND"; null = no gate. */
    val landGate: HubLink? = null,
    /** "by league · trophies · Keep 12". */
    val everyWeekNote: String = "by league · trophies",
)

/** REWARDS callbacks (part two §A; `onItem` / `onGetLand` added). The tab, FIND A MATCH and close are the card's. */
@Immutable data class LeagueRewardsActions(
    /** Settled past weeks (the header History). */
    val onHistory: () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onReport: () -> Unit = {},
    /** An item tile (tap or long-press): its item card. */
    val onItem: (String) -> Unit = {},
    /** The deed gate's GET LAND. */
    val onGetLand: (HubLink) -> Unit = {},
)

/**
 * The REWARDS tab body (scrolls inside the card's parchment). Wire it as the Leagues card's REWARDS branch (see
 * [LeaguesSheetR2] or the one-line change in MOUNT-r2-r2-map-hub.md).
 *
 * Pointer rule: paint and the item tiles / GET LAND only; nothing here is full-screen or a scrim.
 */
@Composable fun ColumnScope.LeagueRewardsTab(ui: LeagueRewardsUi, on: LeagueRewardsActions) {
    val view = boardView(ui.load, ui.tiers.isNotEmpty())
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        (ui.load as? LoadState.Error)?.let { ErrorRow(it, on.onRetry, on.onReport) }
        val gate = ui.landGate
        if (gate != null) CardRow(variant = RowVariant.DIM) {
            RowText("Rewards need a kingdom with land", null)
            SecondaryButton("GET LAND", { on.onGetLand(gate) }, verb = Verb.BLUE, contentDescription = "Get land for league rewards")
        }
        PayoutCard(ui, view)
        if (!ui.configured) return@Column
        SectionHeader("EVERY WEEK", note = ui.everyWeekNote)
        when (view) {
            BoardView.SKELETON -> repeat(4) { SkeletonRow() }
            else -> Column(Modifier.graphicsLayer { alpha = boardAlpha(view) }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                ui.tiers.forEach { RewardRow(it, view == BoardView.REFRESHING, on) }
            }
        }
        val legend = itemLegend(ui.tiers.map { it.items })
        if (legend.isNotEmpty()) Row(Modifier.fillMaxWidth().padding(top = 4.dp).clearAndSetSemantics {
            contentDescription = "Items: " + legend.joinToString(", ") { it.description }
        }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            legend.forEachIndexed { i, item ->
                if (i > 0) PkwText("·", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                HubArt(item.icon, 24.dp)
                PkwText(item.description, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            }
        }
        ui.skrLine?.let { skr ->
            SectionHeader("TOP 500", note = "on the ladder")
            Box(Modifier.clearAndSetSemantics { contentDescription = "${skr.title}, ${skr.note}. You are ${skr.rank} now" }) {
                CardRow(variant = RowVariant.YOU, height = 62.dp) {
                    Well("skr", light = true, iconSize = 36.dp)
                    RowText(skr.title, skr.note)
                    Column(horizontalAlignment = Alignment.End) {
                        PkwText(skr.rank, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                        PkwText("you now", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                    }
                }
            }
        }
        ui.footnote?.let { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth().padding(top = 6.dp), color = PkwTokens.Colors.textOnParch2,
            textAlign = TextAlign.Center) }
    }
}

/** The payout card 92: timer 36, NEXT REWARDS IN / PS 16 time / closes line; raids n/m + the EARNING tag. */
@Composable private fun PayoutCard(ui: LeagueRewardsUi, view: BoardView) {
    val loading = view == BoardView.SKELETON || view == BoardView.REFRESHING
    val time = if (loading) UNKNOWN else ui.nextPayout ?: UNKNOWN
    val raids = if (loading) "$UNKNOWN/$UNKNOWN" else fractionText(ui.raidsDone, ui.raidsNeeded)
    val tag = earningTag(ui.earning, ui.paid)
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 92.dp)
        .clearAndSetSemantics { contentDescription = listOfNotNull("Next rewards in $time", ui.closesLine, "raids $raids", tag?.label).joinToString(". ") },
        blocksScene = false) {
        if (!ui.configured) {
            PkwText("League rewards are not set on this server yet.", PkwTokens.Type.body, Modifier.align(Alignment.Center).padding(8.dp),
                color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center, maxLines = 2)
            return@Plate
        }
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            HubArt("timer", 36.dp)
            Column(Modifier.weight(1f)) {
                PkwText("NEXT REWARDS IN", PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
                PkwText(time, PkwTokens.Type.numeralL, color = PkwTokens.Colors.textOnParch)
                PkwText(ui.closesLine, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                PkwText("raids", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                PkwText(raids, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                tag?.let { StatusTag(it.label, it.verb) }
            }
        }
    }
}

/** One league row (62): crest Well, name (+ YOU) and "from n", the Shards pill, then the item tiles 44. */
@Composable private fun RewardRow(row: LeagueRewardRowUi, refreshing: Boolean, on: LeagueRewardsActions) {
    val shards = if (refreshing) row.shards.copy(status = PriceStatus.CHECKING) else row.shards
    CardRow(variant = if (row.isYou) RowVariant.YOU else RowVariant.PLAIN, height = 62.dp) {
        Well(row.crest, iconSize = 40.dp)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText(row.name, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                if (row.isYou) StatusTag("YOU", Verb.GOLD)
            }
            PkwText("from ${row.fromTrophies.ifBlank { UNKNOWN }}", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
        }
        PriceChip(shards)
        row.items.forEach { RewardItemTile(it, on.onItem) }
    }
}

/** A 44 dp item tile (icon 24 + PS 11 count); a tap or a long press opens the item's card (≥ 48 dp target). */
@Composable private fun RewardItemTile(item: ItemTileUi, onItem: (String) -> Unit) {
    val open by rememberUpdatedState(onItem)
    Box(Modifier.size(48.dp).sceneInputRegion()
        .clearAndSetSemantics {
            contentDescription = item.description; role = Role.Button
            this.onClick(label = "Show the item", action = { open(item.id); true })
            this.onLongClick(label = "Show the item", action = { open(item.id); true })
        }
        .pointerInput(item.id) { detectTapGestures(onTap = { open(item.id) }, onLongPress = { open(item.id) }) },
        contentAlignment = Alignment.Center) {
        Plate(PlateKind.CREAM, Modifier.size(44.dp), blocksScene = false) {
            HubArt(item.icon, 24.dp, Modifier.align(Alignment.Center))
            PkwText(item.count, PkwTokens.Type.caption, Modifier.align(Alignment.BottomEnd), color = PkwTokens.Colors.textOnParch)
        }
    }
}
