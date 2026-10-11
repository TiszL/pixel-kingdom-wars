package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.phasee.miningClaimsKeepAmount
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.IslandRewardsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.KingdomPickUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.RewardTermRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.RewardsTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.TaxRoundRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.TermState
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.islandRewardsTabs

/*
 * ISLAND REWARDS (seeker-rewards.png, frame #152; design/final/map/SPEC.md Round 2 section B) over the three existing claim
 * owners. Each Phase E registration owns one tab (MATERIALS = resource shares, SHARDS = Seeker Shards, REALM'S CUT = KEEP
 * tax claims) and draws this as its home body. MATERIALS / SHARDS claim in place (owner 2026-10-06; IslandRewardsInPlace.kt):
 * the primary is CLAIM "no wallet needed", one row per review (CLAIM ALL would be untrue), and its Seal is the home's. REALM'S
 * CUT stays presentation only: its review, wallet steps, saved operation and receipt check stay with MiningTaxClaimsScreen.
 * No current-term tile without a server term id, and no KEEP amount without a denomination.
 */

private val ISLAND_REWARDS_REVIEW = FeatureId("island.seeker.rewards.claim")
private const val ISLAND_REWARDS_PAUSED = "New claims are paused. Saved claims and receipts remain available."
private const val ISLAND_REWARDS_NOTHING_READY = "Nothing is ready to claim on this page."
private const val ISLAND_REWARDS_CHOOSE_KINGDOM = "Choose a kingdom in Your Bases before reviewing a claim."
private const val ISLAND_REWARDS_CHECKING = "Checking your rewards and saved receipts."
private const val ISLAND_REWARDS_UNAVAILABLE = "Reward history is unavailable right now."
private const val ISLAND_REWARDS_SHARES_UNAVAILABLE = "Reward history is unavailable right now. Saved receipts are in History."
private const val ISLAND_REWARDS_FINISH_SAVED = "Finish the saved claim above first."
private const val ISLAND_REWARDS_NO_WALLET = "no wallet needed"

/** REALM'S CUT only (MATERIALS / SHARDS claim in place since 2026-10-06): a saved tax claim or an open review always draws
 *  the original owner, never the designed body. */
internal fun islandRewardsOriginalRequired(recovery: Boolean, review: Boolean): Boolean = recovery || review

/** INTO: the account's selected kingdom. This owner state carries no kingdom name, and the kingdom is chosen in Your Bases,
 *  so the row names it plainly and draws no CHANGE. */
internal fun islandRewardsKingdom(selectedBase: String?): KingdomPickUi? = selectedBase?.let {
    KingdomPickUi("Your selected kingdom", "Choose another in Your Bases", null, changeable = false)
}

/** A routine refresh keeps the view already shown; only a first read with nothing kept draws the loading view. */
internal fun islandRewardsShown(fresh: IslandRewardsUi, kept: IslandRewardsUi?, busy: Boolean): IslandRewardsUi =
    if (busy) kept ?: fresh else fresh

/**
 * The owning [tab]'s body from its existing projection: [shares] on MATERIALS / SHARDS, [cut] on REALM'S CUT. [paused] is
 * the owner's own "new claims are paused" rule; [keepDecimals] the KEEP denomination from the owner's policy, if known.
 * The primary is ENABLED only while a READY row can be reviewed: CLAIM on MATERIALS / SHARDS (the home claims that row in
 * place), REVIEW CLAIM on REALM'S CUT (it opens the original screen). The mapper's "existing flow" hints are not shown on
 * the share tabs, which no longer hop to that flow.
 */
internal fun islandRewardsUi(tab: RewardsTab, shares: SeekerRewardsDisplay?, cut: RealmCutDisplay?, loading: Boolean,
    kingdom: KingdomPickUi?, paused: Boolean = false, keepDecimals: Int? = null, error: String? = null): IslandRewardsUi {
    val cutTab = tab == RewardsTab.REALMS_CUT
    val earlier: List<RewardTermRowUi> = if (cutTab) emptyList() else shares?.earlier.orEmpty()
    val rounds: List<TaxRoundRowUi> = if (cutTab) listOfNotNull(cut?.let { taxRound(it, keepDecimals) }) else emptyList()
    val recovery = shares?.recovery ?: listOfNotNull(cut?.recovery)
    val ownReason = if (cutTab) cut?.primary?.reason else null
    val ready = earlier.any { it.state == TermState.READY } || rounds.any { it.state == TermState.READY }
    val reviewable = ready && !paused && recovery.isEmpty() && (cutTab || kingdom != null)
    // Discovery that does not exist is said plainly, never drawn as "no permits sold" or an empty page.
    val unavailable = !loading && (if (cutTab) rounds.isEmpty() else shares?.sourceUnavailable != false)
    val unavailableLine = ownReason ?: if (cutTab) ISLAND_REWARDS_UNAVAILABLE else ISLAND_REWARDS_SHARES_UNAVAILABLE
    val reason = when {
        paused -> ISLAND_REWARDS_PAUSED
        // A saved share claim is finished, checked or reopened from its own row on this sheet before a new one.
        !cutTab && recovery.isNotEmpty() -> ISLAND_REWARDS_FINISH_SAVED
        reviewable || recovery.isNotEmpty() -> ownReason
        loading -> ISLAND_REWARDS_CHECKING
        ready -> ISLAND_REWARDS_CHOOSE_KINGDOM
        unavailable -> unavailableLine
        else -> ISLAND_REWARDS_NOTHING_READY
    }
    val state = when {
        paused -> CommandState.LOCKED
        reviewable -> CommandState.ENABLED
        else -> CommandState.DISABLED
    }
    return IslandRewardsUi("seeker", tab, islandRewardsTabs(ready = if (reviewable) setOf(tab) else emptySet()), null,
        emptyList(), earlier, rounds, if (cutTab) null else kingdom,
        CommandUi(ISLAND_REWARDS_REVIEW, "ui:ready-status", if (cutTab) "REVIEW CLAIM" else "CLAIM", null, true, state, reason,
            if (reviewable) BadgeUi("!", BadgeTone.READY, "Rewards ready to claim") else null, sub = if (cutTab) null else ISLAND_REWARDS_NO_WALLET),
        null, recovery, when {
            error != null -> LoadState.Error(error, retrying = loading)
            loading -> LoadState.Loading
            else -> LoadState.Ready
        }, paused,
        sectionTitle = if (cutTab) "YOUR SAVED ROUND" else (shares?.scopeLine?.uppercase() ?: UNKNOWN),
        lockedLine = if (unavailable) unavailableLine else null)
}

/** The one original tax operation as a row; a saved claim with no final receipt is still being checked. */
private fun taxRound(cut: RealmCutDisplay, keepDecimals: Int?): TaxRoundRowUi? {
    val round = cut.round ?: return null
    val paid = cut.paidKeepBaseUnits
    return TaxRoundRowUi(cut.recovery?.key ?: round, "Round $round - Spot ${cut.spotNumber ?: UNKNOWN}", cut.phase ?: UNKNOWN,
        keepPrice(paid ?: cut.proposedKeepBaseUnits, keepDecimals), if (paid != null) TermState.CLAIMED else TermState.CHECKING,
        cut.recovery?.key)
}

/** KEEP only through the existing denomination helper; without one the amount is unavailable, never base units as KEEP. */
private fun keepPrice(baseUnits: String?, decimals: Int?): PriceUi {
    val amount = runCatching { miningClaimsKeepAmount(baseUnits, decimals) }.getOrNull()
        ?: return PriceUi(Currency.KEEP, null, PriceStatus.UNAVAILABLE)
    return PriceUi(Currency.KEEP, amount, if (amount == "0") PriceStatus.SERVER_ZERO else PriceStatus.OK, description = "$amount KEEP")
}
