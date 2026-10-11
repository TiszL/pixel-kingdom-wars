package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.data.CommunityState
import gg.pixelkingdomwars.nativeclient.model.LeaguePresentationMode
import gg.pixelkingdomwars.nativeclient.model.LeagueSettlement
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.groupedAmount
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.craftItemIcon
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.FilterChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubMotion
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkrLineUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.HubLeagueScope
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.HubLeagueUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.liveLeagueUi
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject

/** The four Leagues tab ids (SPEC §2.2 + part two §A, plus PRIZE for the owner's live season prize, 2026-10-06);
 *  a host's tab state uses exactly these. */
internal val LEAGUE_HUB_TABS = setOf("LEAGUE", "LADDER", "REWARDS", "PRIZE")

/** The one ladder the server supplies: by trophies. CLANS and FRIENDS are drawn (SPEC §2.2) but have no server board. */
internal const val LEAGUE_LADDER_SUPPLIED = "TROPHIES"

internal fun leagueHubScopeCurrent(expected: HubLeagueScope, actual: HubLeagueScope?): Boolean =
    actual != null && expected.session === actual.session && expected.baseId == actual.baseId &&
        expected.selectionGeneration == actual.selectionGeneration

/** A read is GET-only through the existing repository. A late result cannot acquire a new owner. */
internal suspend fun readCurrentLeagues(expected: HubLeagueScope, current: () -> HubLeagueScope?,
    read: suspend () -> CommunityState): CommunityState {
    if (!leagueHubScopeCurrent(expected, current())) throw CancellationException("League owner changed")
    val observed = read()
    if (!leagueHubScopeCurrent(expected, current())) throw CancellationException("League owner changed")
    check(observed.leagueBaseId == expected.baseId && observed.leagueSelectionGeneration == expected.selectionGeneration) {
        "League data belongs to a different kingdom selection. Refresh leagues."
    }
    return observed
}

/**
 * SPEC §3.4: an in-card read that has not answered after [timeoutMs] (8 s) ends, and the card switches to its error
 * state. True when [read] finished in time; false when it was stopped. The read is a GET, so stopping it is safe.
 */
internal suspend fun readBeforeLoadingTimeout(timeoutMs: Long = HubMotion.LOADING_TIMEOUT.toLong(), read: suspend () -> Unit): Boolean =
    withTimeoutOrNull(timeoutMs) { read(); true } ?: false

/** Why a league read ended without an answer. */
/** [NOT_SUPPLIED]: the server answered 404 (it has no season board yet; GET /leagues/season is new on 2026-10-06). */
internal enum class LeagueReadFailure { PAUSED, TIMED_OUT, FAILED, NOT_SUPPLIED }

/**
 * SPEC §3.6: what failed in plain words, what is safe, and when the kept board is from ([keptAsOf], null when nothing
 * is kept). The kept board stays on screen at 60 % under this error; it is never blanked.
 */
internal fun leagueReadError(failure: LeagueReadFailure, keptAsOf: String?): LoadState.Error = LoadState.Error(
    when (failure) {
        LeagueReadFailure.PAUSED -> "Leagues is waiting for the current action to finish."
        LeagueReadFailure.TIMED_OUT -> "The league board is taking too long to answer."
        LeagueReadFailure.FAILED -> "Can't reach the league board."
        LeagueReadFailure.NOT_SUPPLIED -> "This server has no season board yet."
    }, asOf = keptAsOf, safeLine = "Your trophies are safe.")

/**
 * SPEC §3.6: retry is automatic once after 5 s, then manual. Returns the wait before the one automatic retry, or null.
 * [automaticUsed] is set when that retry is scheduled and cleared only by a successful read, so a board that keeps
 * failing gets exactly one automatic retry and never a loop.
 */
internal fun leagueAutoRetryDelay(automaticUsed: Boolean, failed: Boolean): Long? =
    if (failed && !automaticUsed) HubMotion.AUTO_RETRY.toLong() else null

/**
 * The load state while a read runs. After an error the ErrorRow stays, with its RETRY as busy dots (SPEC §3.6), over the
 * kept board; otherwise Loading, which keeps a shown board (REFRESHING) and draws skeletons only when nothing is kept.
 */
internal fun leagueReadStarting(previous: LoadState): LoadState =
    if (previous is LoadState.Error) previous.copy(retrying = true) else LoadState.Loading

/** Where the card stands once a read ends: its load state, the wait before the one automatic retry, and whether it is spent. */
internal data class LeagueReadSettled(val load: LoadState, val retryAfterMs: Long?, val autoRetryUsed: Boolean)

/**
 * A read ended ([failure] null = the board was accepted). Success is Ready and re-arms the automatic retry; a failure is
 * the error state over the board kept from [keptAsOf], with the automatic retry only if it is not already spent.
 */
internal fun leagueReadSettled(failure: LeagueReadFailure?, keptAsOf: String?, autoRetryUsed: Boolean): LeagueReadSettled {
    if (failure == null) return LeagueReadSettled(LoadState.Ready, null, autoRetryUsed = false)
    val wait = leagueAutoRetryDelay(autoRetryUsed, failed = true)
    return LeagueReadSettled(leagueReadError(failure, keptAsOf), wait, autoRetryUsed || wait != null)
}

/** What one Back does in Leagues, innermost layer first: a row or item's facts, then History, then the card. */
internal enum class LeagueBackStep { CLOSE_DETAIL, CLOSE_HISTORY, CLOSE_CARD }

internal fun leagueBackStep(detailOpen: Boolean, historyOpen: Boolean): LeagueBackStep = when {
    detailOpen -> LeagueBackStep.CLOSE_DETAIL
    historyOpen -> LeagueBackStep.CLOSE_HISTORY
    else -> LeagueBackStep.CLOSE_CARD
}

/** Hosted in a Home sheet, closing the card is the host's Back; Leagues takes Back only for its own open facts view. */
internal fun leagueConsumesHostedBack(step: LeagueBackStep): Boolean = step != LeagueBackStep.CLOSE_CARD

/** Null when the ladder filter is the server's own; otherwise the reason the chip cannot change the board. */
internal fun leagueLadderFilterRefusal(filter: String): String? =
    if (filter == LEAGUE_LADDER_SUPPLIED) null else "This ladder filter is not supplied by the server."

internal fun leagueHubControl(expected: HubLeagueScope, current: () -> HubLeagueScope?, canUse: () -> Boolean,
    explain: (String) -> Unit, action: () -> Unit): Boolean {
    val reason = when {
        !leagueHubScopeCurrent(expected, current()) -> "This league card belongs to a previous kingdom. Reopen Leagues."
        !canUse() -> "Leagues is waiting for the current action to finish."
        else -> null
    }
    if (reason != null) { explain(reason); return false }
    action()
    return true
}

internal fun leagueHubCloseLine(timestamp: String?): String = timestamp?.let {
    runCatching {
        "Week closes " + DateTimeFormatter.ofPattern("EEE HH:mm 'UTC'", Locale.ENGLISH)
            .withZone(ZoneId.of("UTC")).format(Instant.parse(it))
    }.getOrNull()
} ?: "Week close unavailable"

/**
 * Enhances the already reviewed amount mapper with usable navigation and explicit eligibility copy.
 * [fallbackTrophies] is the selected kingdom's own trophies from its Home read (a decimal string): the header shows it
 * while the league standing is not yet read (SPEC §2.2 Loading), and the standing wins once it is.
 */
internal fun leaguesHubUi(state: CommunityState, captured: HubLeagueScope?, current: HubLeagueScope,
    catalogue: JsonObject?, selectedTab: String, nowMillis: Long, load: LoadState,
    landOwned: Boolean, canNavigate: Boolean, fallbackTrophies: String? = null,
    /** The current owner's GET /leagues/season answer; null while unread. */
    season: LeagueSeasonView? = null): HubLeagueUi {
    val admitted = captured != null && leagueHubScopeCurrent(captured, current) &&
        state.leagueBaseId == current.baseId && state.leagueSelectionGeneration == current.selectionGeneration
    val visible = if (captured == null && load == LoadState.Loading) state.copy(leagues = null) else state
    val mapped = liveLeagueUi(visible, captured, current, catalogue, selectedTab, nowMillis, load, ::craftItemIcon)
    val overview = state.leagues?.takeIf { admitted && it.presentationMode != LeaguePresentationMode.UNAVAILABLE }
    val standing = overview?.you?.takeIf { it.baseId == current.baseId }
    val eligibility = standing?.let {
        val reason = when {
            it.blockedByHigherBase -> "Another kingdom is the reward candidate for this wallet."
            it.rewardCandidate -> "This kingdom is the wallet's current reward candidate."
            it.trophies <= 0 -> "Earn a trophy to become reward-eligible."
            !it.participationMet -> "Complete the rated attack requirement before the window closes."
            else -> "This kingdom is not currently a reward candidate."
        }
        val needed = groupedAmount(overview?.rewards?.minRatedAttacks?.toString()) ?: "…"
        "Rated attacks ${groupedAmount(it.currentWeekRatedAttacks.toString())} / $needed. $reason"
    } ?: overview?.let { "Select a kingdom with land to enter the league ladder." }
    val firstSettlement = overview?.rewards?.takeIf { it.status == "scheduled" }?.let {
        "First settlement ${communityDate(it.firstSettlementAt, ZoneId.of("UTC"))} UTC."
    }
    // A cumulative-league (legacy) server pays the four-league Shards + items table: the season answer carries it for
    // the selected kingdom's Keep level, so LEAGUE and REWARDS draw the designed rows instead of "not set".
    val legacy = season?.takeIf { overview?.presentationMode == LeaguePresentationMode.LEGACY }
    val tables = legacy?.let { seasonTierTables(it, standing?.tier, standing?.trophies, ::craftItemIcon) { id -> communityItemName(catalogue, id) } }
    val legacyPaying = tables != null && overview?.rewards?.status != "disabled"
    // The eligibility line already carries a reason the mapper also states; say it once.
    val baseNote = (if (tables != null) "League rewards are disabled on this server.".takeUnless { legacyPaying } else mapped.league.rewardNote)
        ?.takeUnless { note -> eligibility?.contains(note) == true }
    val skrLine = season?.standings?.you?.takeIf { it.baseId == current.baseId }?.place?.let {
        SkrLineUi("#${groupedAmount(it.toString())}", "A share of the season prize", "weekly trophies · in SKR")
    }
    // The server board carries no clan per row: a row shows no clan, never a constant standing in for one.
    val ladder = mapped.league.ladder?.let { board ->
        board.copy(
            filter = LEAGUE_LADDER_SUPPLIED,
            filters = listOf(
                FilterChipUi(LEAGUE_LADDER_SUPPLIED, "PLAYERS", description = "Players by trophies"),
                // Drawn locked (SPEC §1 Locked tab grammar): a tap says why, never an empty board that looks broken.
                FilterChipUi("CLANS", "CLANS", icon = "itm_banner", description = "Clans ladder, not supplied by the server", locked = true),
                FilterChipUi("FRIENDS", "FRIENDS", description = "Friends ladder, not supplied by the server", locked = true),
            ),
            rows = board.rows.map { it.copy(clanTag = null) },
            you = board.you?.copy(clanTag = null),
            empty = if (board.rows.isEmpty()) leagueLadderEmpty(landOwned) else board.empty,
        )
    }
    val trophies = if (standing != null) mapped.league.trophies else groupedAmount(fallbackTrophies) ?: mapped.league.trophies
    // Server facts in plain words (the raw status line is not player copy).
    val footnote = overview?.let {
        listOfNotNull("Rewards go to up to ${groupedAmount(it.rewards.maxRewardedBasesPerWallet.toString())} kingdom(s) per wallet.",
            "SKR payout is deferred; no payment is confirmed.".takeIf { _ -> it.skr?.status == "payout_deferred" }).joinToString(" ")
    }
    val league = mapped.league.copy(
        // The shared live mapper knows three tabs; PRIZE is this card's fourth.
        selectedTab = selectedTab.takeIf { it in LEAGUE_HUB_TABS } ?: mapped.league.selectedTab,
        trophies = trophies,
        ladder = ladder,
        footnote = footnote,
        rewardNote = listOfNotNull(baseNote, eligibility, firstSettlement).joinToString(" ").ifBlank { null },
        // FIND A MATCH is a navigation door to the raid chooser: live while the board loads or fails (SPEC §2.2).
        findMatchState = if (canNavigate) CommandState.ENABLED else CommandState.DISABLED,
        findMatchReason = if (canNavigate) null else "Leagues is waiting for the current action to finish.",
    )
    val rewards = mapped.rewards.copy(
        closesLine = leagueHubCloseLine(overview?.week?.closesAt),
        footnote = footnote,
        landGate = if (admitted && !landOwned) HubLink(FeatureId("profile.land")) else null,
        skrLine = skrLine,
    )
    if (tables == null) return mapped.copy(league = league, rewards = rewards)
    return mapped.copy(league = league.copy(
        tiers = tables.league,
        nextLine = tables.nextLine ?: league.nextLine,
        rewardShards = tables.yourShards.takeIf { legacyPaying && standing != null },
        rewardItems = if (legacyPaying && standing != null) tables.yourItems else emptyList(),
        rewardsConfigured = legacyPaying,
    ), rewards = rewards.copy(
        tiers = tables.rewards,
        configured = legacyPaying,
        earning = standing?.takeIf { legacyPaying }?.let { it.participationMet && it.rewardCandidate && !it.blockedByHigherBase },
        everyWeekNote = listOfNotNull("by league", "trophies", tables.keepLevel?.let { "Keep $it" }).joinToString(" · "),
    ))
}

/** The land door the empty ladder offers (SPEC §3.5: one blue button to the place that produces the content). */
internal const val LEAGUE_LADDER_LAND_DOOR = "profile.land"

/**
 * The empty PLAYERS ladder (owner screenshot 8, 2026-10-06). The server ranks only kingdoms with land, so a kingdom
 * without land is told how to join and gets the one GET LAND door; a landed kingdom is told how to climb (FIND A MATCH
 * is the card's own footer, so no second button).
 */
internal fun leagueLadderEmpty(landOwned: Boolean): EmptyStateUi =
    if (landOwned) EmptyStateUi("trophy", "No ranked kingdoms yet", "Kingdoms with land rank here by trophies. Win rated raids to climb.", null, null)
    else EmptyStateUi("trophy", "No ranked kingdoms yet", "Kingdoms with land rank here by trophies. Get land to join the ladder.",
        "GET LAND", FeatureId(LEAGUE_LADDER_LAND_DOOR))

/** Every original settlement field remains available; additions are shown only for a valid v2 payload. */
internal fun leagueHubSettlementFacts(value: LeagueSettlement?, catalogue: JsonObject?, mode: LeaguePresentationMode): List<Pair<String, String>> {
    if (value == null || mode == LeaguePresentationMode.UNAVAILABLE) return emptyList()
    return buildList {
        add("Week" to value.week)
        add("League" to (if (mode == LeaguePresentationMode.V2) value.tierV2 ?: "…" else value.tier).uppercase(Locale.ROOT))
        add("Trophies" to (groupedAmount(value.trophies.toString()) ?: "…"))
        add("Keep level" to value.keepLevel.toString())
        add("Shards" to (groupedAmount(value.cacheShards) ?: "…"))
        value.items.forEach { add(communityItemName(catalogue, it.itemId) to (groupedAmount(it.qty.toString()) ?: "…")) }
        if (mode == LeaguePresentationMode.V2) {
            value.gems?.let { add("Gems" to (groupedAmount(it) ?: "…")) }
            value.pack.orEmpty().forEach { add(communityItemName(catalogue, it.resourceId) to (groupedAmount(it.qty) ?: "…")) }
        }
        add("Settled" to "${communityDate(value.settledAt, ZoneId.of("UTC"))} UTC")
    }
}
