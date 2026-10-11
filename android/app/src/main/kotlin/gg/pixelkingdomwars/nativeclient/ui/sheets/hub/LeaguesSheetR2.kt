package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.TimerUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: the Leagues card with the round-2 REWARDS tab (design/final/hub/SPEC.md part two §A;
 * leagues-rewards.png), composed WITHOUT editing the committed `LeaguesSheet.kt`: LEAGUE and LADDER render the committed
 * [LeaguesSheet] unchanged; REWARDS renders the same frame (the [HubCard] with the SHARDS readout, the same sunray living
 * header with the crest at 80, the same tabs and the red FIND A MATCH footer) around [LeagueRewardsTab], plus the stone
 * History in the header for the settled past weeks.
 *
 * Replaces: the committed REWARDS branch (`RewardsBody`, "PAST WEEKS") of `LeaguesSheet`. The header here duplicates the
 * private `LeaguesHeader` (+ History); the cleaner merge is the one-line slot change in MOUNT-r2-r2-map-hub.md, after
 * which this wrapper can be deleted.
 *
 * Pointer rule: the root is the plain [HubCard] Column (or the committed sheet's); only the painted frame, tabs, rows
 * and buttons take touches. The 60 % FULL-card scrim is the SheetHost's, under it, only while shown.
 */
@Composable fun LeaguesSheetR2(ui: LeaguesUi, rewards: LeagueRewardsUi, on: LeaguesActions, rewardsOn: LeagueRewardsActions,
    modifier: Modifier = Modifier, prize: LeaguePrizeUi? = null) {
    if (ui.selectedTab != "REWARDS" && !(ui.selectedTab == "PRIZE" && prize != null)) {
        LeaguesSheet(ui, on, modifier)
        return
    }
    HubCard(modifier, readouts = ui.readouts, tabs = ui.tabs, selectedTab = ui.selectedTab, onTab = on.onTab,
        footer = {
            PrimaryButton("FIND A MATCH", on.onFindMatch, Modifier.weight(1f), verb = Verb.RED, icon = "attack",
                state = ui.findMatchState, reason = ui.findMatchReason)
        },
        header = { RewardsHeader(ui, on.onClose, rewardsOn.onHistory) }, compactTabs = ui.tabs.size > LEAGUE_TABS_WITH_LABELS) {
        // PRIZE (owner 2026-10-06): the same frame, header and footer around the live season prize and winners.
        if (ui.selectedTab == "PRIZE" && prize != null) LeaguesPrizeTab(prize, on.onRetry, on.onReport)
        else LeagueRewardsTab(rewards, rewardsOn)
    }
}

/** The Leagues living header (same as the committed one) plus the stone History left of close (settled past weeks). */
@Composable private fun RewardsHeader(ui: LeaguesUi, onClose: () -> Unit, onHistory: () -> Unit) {
    LivingHeader(onClose, stage = HeaderStage.SUNRAYS, rayCentre = Offset(0.18f, 0.48f),
        timer = ui.weekEnds?.let { TimerUi("Week ends $it", "The league week ends in $it") }) {
        HubArt(ui.tier, 80.dp, Modifier.align(Alignment.CenterStart).padding(start = 28.dp), contentDescription = ui.tierName)
        Column(Modifier.align(Alignment.TopStart).padding(start = 124.dp, top = 12.dp, end = 120.dp)
            .clearAndSetSemantics { contentDescription = listOfNotNull(ui.tierName, "${ui.trophies} trophies", ui.nextLine).joinToString(". ") },
            verticalArrangement = Arrangement.spacedBy(2.dp)) {
            PkwText(ui.tierName, PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                HubArt("trophy", 36.dp)
                PkwText(ui.trophies, PkwTokens.Type.numeralL, color = PkwTokens.Colors.label, outline = 2.dp)
            }
            ui.nextLine?.let { PkwText(it, PkwTokens.Type.body, color = PkwTokens.Colors.text) }
        }
        IconSquare("replay", Verb.STONE, onHistory, "Settled weeks", Modifier.align(Alignment.TopEnd).padding(top = 6.dp, end = 8.dp + 48.dp + 14.dp))
    }
}

// ---- Previews (leagues-rewards.png numbers; every number is a placeholder) ----

private fun shards(amount: String) = PriceUi(Currency.SHARDS, amount, PriceStatus.OK)
private val seal = ItemTileUi("finishers-seal", "streak", "1", "Finisher's Seal")
private val keg = ItemTileUi("keg-of-haste", "timer", "2", "Keg of Haste")

private val sampleLeagueRewards = LeagueRewardsUi("4d 6h", "Week closes Mon 00:00 UTC", 3, 3, earning = true,
    tiers = listOf(
        LeagueRewardRowUi("league-sol", "Sol", "1,500", shards("24,000"), listOf(seal, keg), false),
        LeagueRewardRowUi("league-gold", "Gold", "1,000", shards("16,000"), listOf(seal), true),
        LeagueRewardRowUi("league-silver", "Silver", "500", shards("8,000"), listOf(keg), false),
        LeagueRewardRowUi("league-bronze", "Bronze", "0", shards("4,000"), listOf(keg.copy(count = "1")), false),
    ),
    skrLine = SkrLineUi("#37"), footnote = "Rewards go to one kingdom per wallet.", load = LoadState.Ready,
    everyWeekNote = "by league · trophies · Keep 12")

private val sampleLeaguesForRewards = LeaguesUi(tier = "league-gold", tierName = "GOLD LEAGUE", trophies = "1,284", nextLine = "Sol league at 1,500",
    weekEnds = "4d 6h", wins = 3, winsNeeded = 5, rewardShards = "12,000", rewardItems = emptyList(), rewardNote = null, tiers = emptyList(),
    ladder = null, pastWeeks = emptyList(), footnote = null, selectedTab = "REWARDS", load = LoadState.Ready, readouts = sampleShardsReadout)

@Preview(name = "Leagues: REWARDS (leagues-rewards.png)", widthDp = 412, heightDp = 915)
@Composable private fun LeaguesRewardsR2Preview() {
    HubPreviewStage { LeaguesSheetR2(sampleLeaguesForRewards, sampleLeagueRewards, LeaguesActions(), LeagueRewardsActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Leagues: PRIZE (live season prize and winners)", widthDp = 412, heightDp = 915)
@Composable private fun LeaguesPrizePreview() {
    HubPreviewStage {
        LeaguesSheetR2(sampleLeaguesForRewards.copy(selectedTab = "PRIZE"), sampleLeagueRewards, LeaguesActions(), LeagueRewardsActions(),
            Modifier.fillMaxSize(), prize = samplePrize)
    }
}

@Preview(name = "Leagues PRIZE: no pot set / loading", widthDp = 412, heightDp = 915)
@Composable private fun LeaguesPrizeStatesPreview() {
    HubPreviewStage {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            LeaguesSheetR2(sampleLeaguesForRewards.copy(selectedTab = "PRIZE"), sampleLeagueRewards, LeaguesActions(), LeagueRewardsActions(),
                Modifier.weight(1f), prize = samplePrize.copy(pot = null, potTest = false, winners = samplePrize.winners.map { it.copy(prize = null) },
                    bands = samplePrize.bands.map { it.copy(prizeEach = null) }, you = samplePrize.you?.copy(prize = null)))
            LeaguesSheetR2(sampleLeaguesForRewards.copy(selectedTab = "PRIZE"), sampleLeagueRewards, LeaguesActions(), LeagueRewardsActions(),
                Modifier.weight(1f), prize = samplePrize.copy(winners = emptyList(), load = LoadState.Loading))
        }
    }
}

@Preview(name = "Leagues REWARDS: not yet earning / paid / loading", widthDp = 412, heightDp = 915)
@Composable private fun LeaguesRewardsStatesPreview() {
    HubPreviewStage {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            LeaguesSheetR2(sampleLeaguesForRewards, sampleLeagueRewards.copy(raidsDone = 1, earning = false, skrLine = null), LeaguesActions(),
                LeagueRewardsActions(), Modifier.weight(1f))
            LeaguesSheetR2(sampleLeaguesForRewards, sampleLeagueRewards.copy(load = LoadState.Loading), LeaguesActions(), LeagueRewardsActions(), Modifier.weight(1f))
        }
    }
}

@Preview(name = "Leagues REWARDS: not configured / deed gate / error", widthDp = 412, heightDp = 915)
@Composable private fun LeaguesRewardsEmptyPreview() {
    HubPreviewStage {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            LeaguesSheetR2(sampleLeaguesForRewards, sampleLeagueRewards.copy(configured = false, landGate = sampleLink("profile.land")), LeaguesActions(),
                LeagueRewardsActions(), Modifier.weight(1f))
            LeaguesSheetR2(sampleLeaguesForRewards, sampleLeagueRewards.copy(paid = true, load = LoadState.Error("Can't reach the league board.", asOf = "14:02")),
                LeaguesActions(), LeagueRewardsActions(), Modifier.weight(1f))
        }
    }
}
