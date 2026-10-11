package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.data.PlaytestState
import gg.pixelkingdomwars.nativeclient.data.TesterState
import gg.pixelkingdomwars.nativeclient.model.CampaignPrize
import gg.pixelkingdomwars.nativeclient.model.CampaignStanding
import gg.pixelkingdomwars.nativeclient.model.PlaytestCampaign
import gg.pixelkingdomwars.nativeclient.model.TesterCampaign
import gg.pixelkingdomwars.nativeclient.model.TesterProgress
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.GateFact
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.EdgeButtonUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.shortAddress
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ActivityUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.EventPhase
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.EventUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.PrizeUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RankRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StandingUi
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The Founding Kingdoms card (event.png, SPEC R2.2) from the existing tester and playtest reads only. Points, ranks,
 * caps and results are the server's; nothing here adds, ranks or estimates. Rules kept from the old TesterScreen and
 * PlaytestCampaignScreen: participation needs the server's `canEnter`, a saved request is resolved on the rules page,
 * a disqualification shows the server reason, and results carry the server's award wording.
 */

/** The only doors an event row may hand to its host (EventHub's `onDoor`). */
internal val EVENT_DOOR_FEATURES: Set<String> = setOf("hud.quests", "hud.attack", "settings.feedback", "profile.kingdoms")

private val EVENT_TAB_IDS = setOf("POINTS", "RANKS", "PRIZES")

/** The server's campaign phase as the card's three states. */
internal fun eventPhaseOf(phase: String): EventPhase = when (phase) {
    "running" -> EventPhase.LIVE
    "ended", "finalized", "cancelled" -> EventPhase.CLOSED
    else -> EventPhase.UPCOMING
}

/** The tester program's own day counter, used only before the campaign itself is read. Null = dates not announced. */
private fun testerEventPhase(program: TesterCampaign): EventPhase? {
    val day = program.dayIndex ?: return null
    return when {
        day < 1 -> EventPhase.UPCOMING
        day > program.totalDays -> EventPhase.CLOSED
        else -> EventPhase.LIVE
    }
}

/** JOIN may run only when the server says this player can enter and no request is in flight or saved. */
internal fun eventCanJoin(campaign: PlaytestCampaign?, playtest: PlaytestState): Boolean =
    campaign != null && campaign.canEnter && playtest.canAct

/** The place that earns a scored activity, by the server's key or category; null draws no GO. Never another door. */
internal fun eventActivityDoor(key: String, category: String?): HubLink? {
    val text = "$key ${category.orEmpty()}".lowercase(Locale.ROOT)
    val feature = when {
        listOf("raid", "attack", "battle", "revenge", "stage").any { it in text } -> "hud.attack"
        listOf("feedback", "report", "bug").any { it in text } -> "settings.feedback"
        "quest" in text -> "hud.quests"
        listOf("land", "deed", "kingdom").any { it in text } -> "profile.kingdoms"
        else -> return null
    }
    return HubLink(FeatureId(feature)).takeIf { feature in EVENT_DOOR_FEATURES }
}

private fun eventActivityIcon(key: String, door: HubLink?): String = when {
    door?.feature?.value == "hud.attack" -> "attack"
    door?.feature?.value == "settings.feedback" -> "alert"
    "cache" in key.lowercase(Locale.ROOT) -> "r2:cache-chest"
    else -> "star"
}

/** TODAY rows: the catalogue's capped sources and streak rewards with today's server counts; unknown keys are skipped. */
private fun eventActivities(progress: TesterProgress?): List<ActivityUi> {
    val daily = progress?.daily ?: return emptyList()
    val today = daily.byKey.associateBy { it.key }
    val sources = daily.catalog.sources.map { entry ->
        val count = today[entry.key]?.count ?: 0
        val cap = entry.cap ?: 0
        val done = cap > 0 && count >= cap
        val door = if (done) null else eventActivityDoor(entry.key, entry.category)
        ActivityUi(eventActivityIcon(entry.key, door), entry.title, count, cap, exactAmount(entry.points.toString()), done, door,
            sub = if (cap > 0) null else entry.hint)
    }
    val streaks = daily.catalog.streaks.map { entry ->
        ActivityUi("star", entry.title, today[entry.key]?.count ?: 0, 0, exactAmount(entry.points.toString()),
            done = (today[entry.key]?.count ?: 0) > 0, door = null,
            sub = entry.days?.let { "$it day streak reward · ${exactAmount(entry.points.toString())} points" } ?: entry.hint)
    }
    return sources + streaks
}

private fun eventRankRow(row: CampaignStanding): RankRowUi = RankRowUi(
    id = "standing:${row.rank}", rank = row.rank, rankText = row.rank.toString(),
    name = row.username.ifBlank { shortAddress(row.wallet) }, points = exactAmount(row.points.toString()),
    activeDays = row.activeDays, bestStreak = row.longestStreak, isYou = row.isYou,
)

private fun eventPrizeIcon(category: String): String = when (category) {
    "gameplay" -> "trophy"
    "report" -> "alert"
    else -> "star"
}

/** How a prize is won, in the old rules' words. No amounts: the surface never shows money. */
private fun eventHowWon(prize: CampaignPrize): String = when (prize.metric) {
    "score" -> "Ranked by event points"
    "revenge" -> "Most qualifying revenge wins"
    "activeDays" -> "Most active days, then longest streak"
    "stages" -> "Most distinct three-star stages"
    "judged" -> if (prize.category == "video") "An original gameplay video, judged on feedback and evidence"
        else "Private reports the review team accepts"
    else -> prize.title
}

private fun eventPrizes(c: PlaytestCampaign, program: TesterCampaign?, ownWallet: String?): List<PrizeUi> {
    val mine = c.winners.filter { ownWallet != null && it.wallet == ownWallet }
    if (c.prizes.isEmpty()) {
        if (c.kind != "founding") return emptyList()
        val you = c.standings.firstOrNull { it.isYou }
        return listOf(PrizeUi("founding", "trophy", "Founding spot", program?.rewardCopy ?: "Ranked by event points",
            result = when {
                mine.isNotEmpty() -> "Awarded to you"
                you?.guaranteed == true -> "Guaranteed spot"
                else -> null
            }))
    }
    return c.prizes.groupBy { it.title }.map { (title, group) ->
        val ids = group.map { it.id }.toSet()
        val won = c.winners.filter { it.prizeId in ids }
        PrizeUi(group.first().id, eventPrizeIcon(group.first().category), title, eventHowWon(group.first()), result = when {
            won.any { ownWallet != null && it.wallet == ownWallet } -> "Awarded to you"
            won.isNotEmpty() -> "Awarded to " + won.joinToString(", ") { it.username.ifBlank { shortAddress(it.wallet) } }
            else -> null
        })
    }
}

private fun eventRequestNoun(kind: String): String = when (kind) {
    "participate" -> "join request"
    "video" -> "video entry"
    "report" -> "report entry"
    else -> "event request"
}

/**
 * The card for [campaign] (the last accepted read; null while the first read runs) and the tester program's TODAY.
 * [load] is the host's read state; a saved request outranks it because only the rules page can resolve it.
 */
internal fun liveEventUi(
    campaign: PlaytestCampaign?, tester: TesterState, playtest: PlaytestState,
    tab: String = "POINTS", name: String = "FOUNDING KINGDOMS", ownWallet: String? = null, nowMillis: Long? = null,
    load: LoadState = LoadState.Ready, joining: Boolean = false, justJoined: Boolean = false,
): EventUi {
    val progress = tester.progress
    val program = (progress?.campaign ?: tester.board?.campaign)?.takeIf { campaign == null || it.id == campaign.id }
    val phase = campaign?.let { eventPhaseOf(it.phase) } ?: program?.let { testerEventPhase(it) } ?: EventPhase.UPCOMING
    val now = nowMillis?.let { Instant.ofEpochMilli(it) }
    val day = program?.dayIndex
    val total = program?.totalDays
    val dayLine = when (phase) {
        EventPhase.LIVE -> if (day != null && total != null && day in 1..total) "day $day of $total" else "day $UNKNOWN"
        EventPhase.UPCOMING -> "opens soon"
        EventPhase.CLOSED -> when (campaign?.phase) {
            "finalized" -> "results are final"
            "cancelled" -> "cancelled"
            else -> "scores are being checked"
        }
    }
    val endsIn = if (phase != EventPhase.LIVE || now == null) null else campaign?.endAt?.let { end ->
        runCatching { Duration.between(now, Instant.parse(end)).seconds }.getOrNull()?.takeIf { it > 0 }?.let(::fmtDur)
    }
    val startsLine = if (phase != EventPhase.UPCOMING) null else campaign?.startAt?.let { start ->
        runCatching { "Starts " + DateTimeFormatter.ofPattern("EEE d MMM", Locale.ENGLISH).withZone(ZoneOffset.UTC).format(Instant.parse(start)) }.getOrNull()
    } ?: "Dates to be announced"
    val mine = campaign?.standings?.firstOrNull { it.isYou }
    val participant = campaign?.participant
    val reconciledAt = campaign?.reconciledAt
    val ranksUpdated = when {
        campaign == null -> null
        campaign.stale -> "Score update is delayed"
        reconciledAt == null -> "Scores have not been updated yet"
        now == null -> null
        else -> runCatching { "Updated ${fmtDur(Duration.between(Instant.parse(reconciledAt), now).seconds)} ago" }.getOrNull()
    }
    // Founding only: the checkpoint tag shows until the server reports an available, counted checkpoint.
    val checkpoint = campaign?.takeIf { it.kind == "founding" }?.let { c ->
        val cp = c.checkpoint
        if (cp != null && cp.available && cp.count != null) null
        else "Checkpoint verification is unavailable. The server will retry verification."
    }
    val saved = playtest.pending?.let { pending ->
        LoadState.Error("A saved ${eventRequestNoun(pending.kind)} is waiting. Tap RETRY to check it on the rules page.",
            asOf = (load as? LoadState.Error)?.asOf)
    }
    return EventUi(
        name = name,
        phase = phase,
        dayLine = dayLine,
        endsIn = endsIn,
        tab = tab.takeIf { it in EVENT_TAB_IDS } ?: "POINTS",
        // Founding participation is automatic; only the server's canEnter opens the JOIN footer.
        joined = campaign?.canEnter != true,
        standing = mine?.let {
            StandingUi(it.rank.toString(), exactAmount(it.points.toString()), it.activeDays, it.longestStreak, when {
                it.guaranteed -> "Guaranteed spot"
                !it.eligible -> "Not eligible"
                else -> program?.rewardCopy
            })
        },
        todayPoints = progress?.daily?.todayPoints?.let { exactAmount(it.toString()) } ?: UNKNOWN,
        // The server sends per-activity caps but no total daily cap: never a summed or zero cap.
        todayCap = UNKNOWN,
        activities = eventActivities(progress),
        ranks = campaign?.standings?.map(::eventRankRow).orEmpty(),
        prizes = campaign?.let { eventPrizes(it, program, ownWallet) }.orEmpty(),
        checkpoint = checkpoint,
        load = saved ?: load,
        disqualified = participant?.takeIf { it.disqualifiedAt != null }?.let { it.disqualificationReason?.takeIf { r -> r.isNotBlank() } ?: "See the campaign rules." },
        startsLine = startsLine,
        ranksUpdated = ranksUpdated,
        you = mine?.let(::eventRankRow),
        joining = joining,
        justJoined = justJoined,
    )
}

/** `tester.campaignLive`: Allowed only when the server says the Founding campaign runs; Unknown until either read lands. */
internal fun homeEventFeatureFact(tester: TesterState, playtest: PlaytestState): GateFact {
    playtest.campaign?.takeIf { it.kind == "founding" }?.let { c ->
        return when (eventPhaseOf(c.phase)) {
            EventPhase.LIVE -> GateFact.Allowed
            EventPhase.UPCOMING -> GateFact.Denied("Founding Kingdoms has not started yet.")
            EventPhase.CLOSED -> GateFact.Denied("Founding Kingdoms has ended.")
        }
    }
    val program = tester.progress?.campaign ?: tester.board?.campaign ?: return GateFact.Unknown
    return when (testerEventPhase(program)) {
        EventPhase.LIVE -> GateFact.Allowed
        EventPhase.CLOSED -> GateFact.Denied("Founding Kingdoms has ended.")
        EventPhase.UPCOMING -> GateFact.Denied("Founding Kingdoms has not started yet.")
        null -> GateFact.Denied("Founding Kingdoms dates are not announced yet.")
    }
}

/** The EVENT edge button exists only while the server says the campaign is live; its "!" is that live state, never a count. */
internal fun homeEventEdgeButton(tester: TesterState, playtest: PlaytestState): EdgeButtonUi? =
    if (homeEventFeatureFact(tester, playtest) != GateFact.Allowed) null
    else EdgeButtonUi(HudIds.EVENT, "ui_banner_event", "EVENT", BadgeUi("!", BadgeTone.READY, "Founding Kingdoms is live"), true)
