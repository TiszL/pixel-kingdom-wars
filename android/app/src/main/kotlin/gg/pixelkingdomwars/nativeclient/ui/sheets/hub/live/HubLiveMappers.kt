package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.data.ChatLauncherState
import gg.pixelkingdomwars.nativeclient.data.ChatState
import gg.pixelkingdomwars.nativeclient.data.CommunityState
import gg.pixelkingdomwars.nativeclient.data.DeviceSettings
import gg.pixelkingdomwars.nativeclient.data.FeedbackState
import gg.pixelkingdomwars.nativeclient.data.StoredDevicePreferences
import gg.pixelkingdomwars.nativeclient.data.leagueProgressV2
import gg.pixelkingdomwars.nativeclient.data.leagueThresholdsV2
import gg.pixelkingdomwars.nativeclient.data.leagueTiersV2
import gg.pixelkingdomwars.nativeclient.model.LeaguePresentationMode
import gg.pixelkingdomwars.nativeclient.model.LeagueRewardV2
import gg.pixelkingdomwars.nativeclient.model.QuestBoard
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.groupedAmount
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.ui.chrome.ToastItem
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ToastKind
import gg.pixelkingdomwars.nativeclient.ui.model.ToastUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ChapterUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ChatPeekUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ClaimAllUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.FeedbackReportsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.FilterChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LadderRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LadderUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LeagueRewardRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LeagueRewardsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LeagueTierRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LeagueWeekUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LeaguesUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LetterRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.MailUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.MyReportRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.QuestBonusUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.QuestRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.QuestState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.QuestsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ReportStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SettingsHelpUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SettingsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ToggleRowUi
import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode
import java.time.Duration
import java.time.Instant
import java.util.Locale
import kotlinx.serialization.json.JsonObject

/** Display-only adapters. Controllers own admission, reconciliation, navigation and all effects. */
private fun exactUnsigned(value: String?): String? = value?.takeIf { it.matches(Regex("0|[1-9][0-9]*")) }
private fun price(currency: Currency, value: String?): PriceUi? = exactUnsigned(value)?.let {
    PriceUi(currency, groupedAmount(it), if (it == "0") PriceStatus.SERVER_ZERO else PriceStatus.OK)
}
private fun cosmeticProgress(have: String?, need: String?): Float? {
    val numerator = exactUnsigned(have)?.toBigDecimalOrNull() ?: return null
    val denominator = exactUnsigned(need)?.toBigDecimalOrNull()?.takeIf { it > BigDecimal.ZERO } ?: return null
    return numerator.divide(denominator, 6, RoundingMode.DOWN).coerceIn(BigDecimal.ZERO, BigDecimal.ONE).toFloat()
}
private fun title(value: String) = value.replace('_', ' ').replaceFirstChar { it.titlecase(Locale.ROOT) }

/** Bound means the host routes a single id to the existing quest controller, including its receipt recovery. */
internal fun liveQuestsUi(
    board: QuestBoard?, tab: String = "DAILY", busy: Boolean = false,
    claimFlowBound: Boolean = false, labels: Map<String, String> = emptyMap(),
    destinations: Map<String, HubLink> = emptyMap(),
    load: LoadState = if (board == null) LoadState.Loading else LoadState.Ready,
    claimAllBound: Boolean = false, claimUnavailable: String? = null,
    icons: Map<String, String> = emptyMap(),
): QuestsUi {
    val selected = if (tab == "KINGDOM") "KINGDOM" else "DAILY"
    val quests = board?.quests.orEmpty()
    val identities = quests.mapNotNull { it.questIdentity?.takeIf(String::isNotBlank) }.groupingBy { it }.eachCount()
    fun validId(id: String?) = !id.isNullOrBlank() && identities[id] == 1
    fun bucket(scope: String?) = if (scope == "daily") "DAILY" else "KINGDOM"
    val claimReason = claimUnavailable ?: when (load) {
        LoadState.Ready -> null
        LoadState.Loading -> "Quests are refreshing. Wait for the current read."
        is LoadState.Stale -> "Refresh quests before claiming rewards."
        is LoadState.Error -> "Quests could not be refreshed. Try again before claiming rewards."
    }
    // The existing controller claims every ready quest, regardless of the selected display tab.
    val ready = quests.filter { it.completed && !it.claimed }
    val invalidReady = ready.any { !validId(it.questIdentity) }
    val claimAll = if (claimFlowBound && claimAllBound && claimReason == null && !invalidReady && ready.isNotEmpty()) {
        val amounts = ready.map { exactUnsigned(it.rewardShards) }
        val total = if (amounts.all { it != null }) amounts.fold(BigInteger.ZERO) { sum, amount ->
            sum + requireNotNull(amount).toBigInteger()
        } else null
        ClaimAllUi(ready.size, if (total == null) "Reward total unavailable · all quests"
            else "${groupedAmount(total.toString())} Shards · all quests")
    } else null
    val reservedIds = identities.keys.toMutableSet()
    fun unavailableId(index: Int): String {
        var candidate = "unavailable:$index"
        while (!reservedIds.add(candidate)) candidate += ":missing"
        return candidate
    }
    val rows = quests.mapIndexedNotNull { index, quest ->
        if (bucket(quest.scope) != selected) return@mapIndexedNotNull null
        val id = quest.questIdentity
        val valid = validId(id)
        val destination = destinations[quest.templateCode]
        val reason = when {
            !valid -> "Quest identity is unavailable. Refresh quests."
            quest.claimed -> null
            quest.completed && claimReason != null -> claimReason
            quest.completed && !claimFlowBound -> "Open the existing quests screen to claim this reward."
            !quest.completed && destination == null -> "This quest destination is not connected yet."
            else -> null
        }
        val state = when {
            !valid -> QuestState.LOCKED
            quest.claimed -> QuestState.DONE
            reason != null -> QuestState.LOCKED
            quest.completed -> QuestState.READY
            else -> QuestState.GO
        }
        QuestRowUi(if (valid) id!! else unavailableId(index), icons[quest.templateCode] ?: "quest",
            labels[quest.templateCode] ?: title(quest.templateCode).ifBlank { "Quest" },
            groupedAmount(quest.progress) ?: "…", groupedAmount(quest.target) ?: "…",
            cosmeticProgress(quest.progress, quest.target), price(Currency.SHARDS, quest.rewardShards), state,
            destination.takeIf { state == QuestState.GO }, reason,
            goLabel = if (quest.templateCode == "first_land") "BUY" else "GO")
    }
    return QuestsUi(selected, listOf("DAILY", "KINGDOM").associateWith { key ->
        quests.count { bucket(it.scope) == key && validId(it.questIdentity) && it.completed && !it.claimed && claimFlowBound && claimReason == null }
    }, QuestBonusUi(null, null, price(Currency.SHARDS, board?.allThreeBonus), null), rows,
        claimAll = claimAll, busyIds = if (busy) rows.map { it.id }.toSet() else emptySet(),
        claimAllBusy = busy && claimAll != null, load = load,
        notice = claimReason ?: when {
            busy -> "A quest request is in progress. Wait for it to finish."
            claimAllBound && invalidReady -> "Some quest identities are unavailable. Refresh quests before claiming all."
            else -> null
        })
}

/** List-only. onOpen must use the existing mail detail/reconciliation flow; no batch claim is synthesized. */
internal fun liveMailUi(
    state: CommunityState, filter: String = "ALL",
    load: LoadState = if (state.mailbox == null) LoadState.Loading else LoadState.Ready,
): MailUi {
    val selected = filter.takeIf { it in setOf("ALL", "REWARDS", "NEWS") } ?: "ALL"
    val letters = state.mailbox?.messages.orEmpty().filter {
        when (selected) { "REWARDS" -> it.kind == "reward"; "NEWS" -> it.kind == "info"; else -> true }
    }.map { letter ->
        val attachment = letter.attachments.singleOrNull().takeIf { letter.rewardState == "pending" }
        val reward = when (attachment?.kind) {
            "SHARDS" -> price(Currency.SHARDS, attachment?.amount)
            "KEEP" -> price(Currency.KEEP, attachment?.amount)
            else -> null
        }
        LetterRowUi(letter.id, "shape:mail", letter.subject, title(letter.sender), letter.readAt == null, reward)
    }
    // REWARDS filters all reward letters, whereas status.pendingRewards counts only pending rewards.
    val counts = if (state.archived) emptyMap() else state.status?.let { mapOf("ALL" to it.total) }.orEmpty()
    val incomplete = state.mailbox?.nextCursor != null
    val empty = EmptyStateUi("shape:mail", if (incomplete) "No matching letters loaded" else "No matching letters",
        if (incomplete) "Choose ALL and load more letters to search older mail."
        else if (selected == "ALL") "There are no letters in this mailbox." else "No letters match this filter.", null, null)
    return MailUi(selected, counts, letters, claimAll = null, hasMore = state.mailbox?.nextCursor != null,
        load = load, empty = empty, footnote = null, loadingMore = state.busy && state.mailbox != null)
}

/** Server unread is a presence flag; the numeric UI badge means reply count, so use truthful text instead. */
internal fun liveFeedbackReportsUi(
    state: FeedbackState, testerPoints: String? = null, reviewedCount: Int? = null,
    load: LoadState = if (state.loaded) LoadState.Ready else LoadState.Loading,
): FeedbackReportsUi = FeedbackReportsUi(state.reports.map { report ->
    val status = when {
        report.status == "fixed" -> ReportStatus.FIXED
        report.closed || report.status in setOf("rejected", "duplicate") -> ReportStatus.CLOSED
        report.status in setOf("reviewed", "accepted") -> ReportStatus.READING
        else -> ReportStatus.SENT
    }
    val points = report.points.takeIf { it > 0 }?.let { "+${groupedAmount(it.toString())}" }
    val stateLine = listOfNotNull("Unread update".takeIf { report.unread }, title(report.status), report.fixedRef?.takeIf { report.status == "fixed" },
        points?.let { "$it points" }).joinToString(" · ")
    MyReportRowUi(report.id, report.category.uppercase(Locale.ROOT), report.title, stateLine, status,
        0, points)
}, groupedAmount(testerPoints), reviewedCount?.takeIf { it >= 0 }, load)

/** Projection only. Existing preference/consent handlers still own changes, including KEEP confirmations. */
internal fun liveSettingsUi(
    state: DeviceSettings, version: String, tab: String = "GAME",
    accountRows: List<RowUi> = emptyList(), helpRows: List<RowUi> = emptyList(),
): SettingsUi {
    fun toggle(key: String, section: String, label: String, consequence: String, on: Boolean, tab: String = "GAME") =
        ToggleRowUi(key, section, label, consequence, on, null, tab)
    return SettingsUi(tab.takeIf { it in setOf("GAME", "ACCOUNT", "HELP") } ?: "GAME", listOf(
        toggle(StoredDevicePreferences.MUSIC_KEY, "SOUND & FEEL", "Music", "Game music", state.music),
        toggle(StoredDevicePreferences.SFX_KEY, "SOUND & FEEL", "Sound effects", "Game sounds", state.soundFx),
        toggle(StoredDevicePreferences.HAPTICS_KEY, "SOUND & FEEL", "Haptics", "Touch feedback", state.haptics),
        toggle(StoredDevicePreferences.REDUCE_MOTION_KEY, "PLAY", "Reduce motion", "Reduce interface movement", state.reduceMotion),
        toggle(StoredDevicePreferences.LANDSCAPE_KEY, "PLAY", "Landscape", "Use landscape orientation", state.landscape),
        toggle(StoredDevicePreferences.KEEP_CONFIRM_KEY, "PLAY", "KEEP confirmation", "Ask before a speed-up. Economy transfers always require their own review.", state.keepConfirm),
        toggle(StoredDevicePreferences.DIAGNOSTICS_KEY, "FOR TESTERS", "Diagnostics", "Use the existing diagnostic consent controls", state.diagnostics, "HELP"),
        toggle(StoredDevicePreferences.LOCAL_REPORTS_KEY, "FOR TESTERS", "Local battle reports", "Keep battle reports on this device", state.localBattleReports, "HELP"),
    ), version, accountRows, helpRows)
}

internal fun liveSettingsHelpUi(
    state: DeviceSettings, version: String, chapters: List<ChapterUi>, feedback: HubLink,
    feedbackUnread: Int? = null, feedbackLoading: Boolean = false,
    about: HubLink? = null, terms: HubLink? = null,
): SettingsHelpUi = SettingsHelpUi(chapters, feedbackUnread?.takeIf { it >= 0 }, version, feedback, about, terms,
    liveSettingsUi(state, version).toggles.filter { it.tab == "HELP" }, feedbackLoading)

/** review bb11c2cc: current feed is GLOBAL; host CLAN tab stays disabled with this reason. */
internal const val CLAN_CHAT_UNAVAILABLE_REASON = "Clan chat is not available on this server."
internal fun liveChatPeekUi(state: ChatState, launcher: ChatLauncherState, crest: String = "shape:chat"): ChatPeekUi? {
    if (launcher.open || !launcher.enabled || state.status?.enabled != true) return null
    val message = state.messages.filter { it.id in launcher.unreadMessages }.maxByOrNull { it.id.toBigInteger() } ?: return null
    return ChatPeekUi(crest, message.author.name, "GLOBAL", message.text, "global:${message.id}", message.id)
}

/** Preserve the existing queue's clock and identity; this mapper does not create a second timer/queue. */
internal fun liveToastUi(item: ToastItem, reportFlowBound: Boolean = false): ToastUi = ToastUi(
    "toast:${item.id}", item.message, null, if (item.error) ToastKind.ERROR else ToastKind.INFO,
    go = null, goLabel = null, report = item.error && reportFlowBound, postedAtMs = item.postedAt)

/** Capture at read admission, not at recomposition. Equal wallet text is insufficient after a session replacement. */
internal data class HubLeagueScope(val session: AccountSession, val baseId: String?, val selectionGeneration: Long)
internal data class HubLeagueUi(val league: LeaguesUi, val rewards: LeagueRewardsUi)
private fun crest(tier: String?) = when (tier) {
    "bronze", "silver", "gold", "sol" -> "league-$tier"
    else -> "trophy"
}
private fun until(timestamp: String, nowMillis: Long?): String? = nowMillis?.let { now ->
    runCatching {
        fmtDur(Duration.between(Instant.ofEpochMilli(now), Instant.parse(timestamp)).seconds)
    }.getOrNull()
}
private fun rewardItems(reward: LeagueRewardV2?, itemIcon: (String) -> String?): List<ItemTileUi> = buildList {
    reward ?: return@buildList
    add(ItemTileUi("gems", "gem-32", groupedAmount(reward.gems) ?: "…", "Gems, ${groupedAmount(reward.gems) ?: "…"}"))
    reward.pack.forEach { row -> add(ItemTileUi(row.resourceId, itemIcon(row.resourceId) ?: "shape:chest", groupedAmount(row.qty) ?: "…", "${row.resourceId}, ${groupedAmount(row.qty) ?: "…"}")) }
}

/** Requires M1's four source inputs plus the AppGraph generation hunk; runtime acceptance remains pending. */
internal fun liveLeagueUi(
    state: CommunityState, captured: HubLeagueScope?, current: HubLeagueScope,
    catalogue: JsonObject? = null, selectedTab: String = "LEAGUE", nowMillis: Long? = null,
    load: LoadState = if (state.leagues == null) LoadState.Loading else LoadState.Ready,
    itemIcon: (String) -> String? = { null },
): HubLeagueUi {
    val admitted = captured != null && captured.session === current.session && captured.baseId == current.baseId &&
        captured.selectionGeneration == current.selectionGeneration && state.leagueBaseId == current.baseId &&
        state.leagueSelectionGeneration == current.selectionGeneration
    val payload = state.leagues.takeIf { admitted }
    val overview = payload?.takeUnless { it.presentationMode == LeaguePresentationMode.UNAVAILABLE }
    val v2 = overview?.presentationMode == LeaguePresentationMode.V2
    val standing = overview?.you?.takeIf { it.baseId == current.baseId }
    val tier = if (v2) standing?.tierV2 else standing?.tier
    val reward = standing?.rewardV2?.takeIf { v2 && overview?.rewards?.status != "disabled" }
    val progress = if (v2 && tier != null && standing != null) leagueProgressV2(catalogue, tier, standing.trophies) else null
    val tiers = if (v2) leagueTiersV2(catalogue).orEmpty() else emptyList()
    val thresholds = if (v2) leagueThresholdsV2(catalogue) else null
    val table = if (thresholds != null) tiers.mapIndexed { index, id ->
        LeagueTierRowUi(id, crest(id), title(id), "${groupedAmount(thresholds[index].toString())} trophies",
            price(Currency.SHARDS, reward?.shards).takeIf { id == tier }, id == tier,
            progress?.fraction.takeIf { id == tier },
            progress?.remaining?.let { "${groupedAmount(it.toString())} to ${title(progress?.nextTier.orEmpty())}" }.takeIf { id == tier })
    }.reversed() else emptyList()
    val ladderRows = overview?.board.orEmpty().map { row ->
        LadderRowUi(row.baseId, row.rank, groupedAmount(row.rank.toString()) ?: "…", crest(if (v2) row.tierV2 else row.tier),
            row.name ?: "…", "Clan unavailable", groupedAmount(row.trophies.toString()) ?: "…", row.you)
    }
    val actualLoad = when {
        state.leagues == null -> load
        !admitted -> LoadState.Error("League read no longer matches this account and kingdom. Refresh leagues.")
        payload?.presentationMode == LeaguePresentationMode.UNAVAILABLE -> LoadState.Error("League data is incompatible. Refresh leagues.")
        else -> load
    }
    val configured = v2 && overview?.rewards?.status != "disabled"
    val note = when {
        overview == null -> "League rewards are unavailable."
        !v2 -> "This server has not supplied v2 league rewards."
        overview.rewards.status == "disabled" -> "League rewards are disabled on this server."
        reward == null -> "Current reward amounts are unavailable."
        standing?.blockedByHigherBase == true -> "Another kingdom is the reward candidate for this wallet."
        standing?.participationMet != true -> "Participation requirement is not met yet."
        standing?.rewardCandidate != true -> "This kingdom is not the reward candidate."
        else -> "Current server reward projection; settlement has not been confirmed."
    }
    val footnote = overview?.let {
        "Rewards status: ${it.rewards.status}. First settlement: ${it.rewards.firstSettlementAt}. " +
            "Up to ${groupedAmount(it.rewards.maxRewardedBasesPerWallet.toString())} kingdom(s) per wallet." +
            if (it.skr?.status == "payout_deferred") " SKR payout is deferred; no payment is confirmed." else ""
    }
    val items = rewardItems(reward, itemIcon)
    val history = overview?.lastSettlement?.let { settled -> listOf(LeagueWeekUi(settled.week, settled.week,
        crest(if (v2) settled.tierV2 else settled.tier), price(Currency.SHARDS, settled.cacheShards),
        buildList {
            addAll(settled.items.map { ItemTileUi(it.itemId, itemIcon(it.itemId) ?: "shape:chest", groupedAmount(it.qty.toString()) ?: "…", "${it.itemId}, ${groupedAmount(it.qty.toString()) ?: "…"}") })
            if (v2) {
                settled.gems?.let { add(ItemTileUi("gems", "gem-32", groupedAmount(it) ?: "…", "Gems, ${groupedAmount(it) ?: "…"}")) }
                settled.pack.orEmpty().forEach { row ->
                    add(ItemTileUi(row.resourceId, itemIcon(row.resourceId) ?: "shape:chest", groupedAmount(row.qty) ?: "…", "${row.resourceId}, ${groupedAmount(row.qty) ?: "…"}"))
                }
            }
        },
        "Settled ${settled.settledAt}")) }.orEmpty()
    val league = LeaguesUi(crest(tier), tier?.let { "${it.uppercase(Locale.ROOT)} LEAGUE" } ?: "LEAGUE",
        groupedAmount(standing?.trophies?.toString()) ?: "…", progress?.remaining?.let { "${groupedAmount(it.toString())} to ${title(progress?.nextTier.orEmpty())}" },
        overview?.week?.closesAt?.let { until(it, nowMillis) },
        wins = standing?.currentWeekRatedAttacks, winsNeeded = overview?.rewards?.minRatedAttacks,
        rewardShards = groupedAmount(reward?.shards), rewardItems = items, rewardNote = note, tiers = table,
        ladder = overview?.let { LadderUi("TROPHIES", listOf(FilterChipUi("TROPHIES", "TROPHIES")), ladderRows, ladderRows.firstOrNull { row -> row.isYou }) },
        pastWeeks = history, footnote = footnote, selectedTab = selectedTab.takeIf { it in setOf("LEAGUE", "LADDER", "REWARDS") } ?: "LEAGUE",
        load = actualLoad, winsLine = standing?.let { "Rated attacks ${groupedAmount(it.currentWeekRatedAttacks.toString())} / ${groupedAmount(overview?.rewards?.minRatedAttacks?.toString()) ?: "…"}" } ?: "Rated attacks unavailable",
        rewardsConfigured = configured, findMatchState = CommandState.DISABLED,
        findMatchReason = "Use the existing raid screen to find a match.")
    val rewards = LeagueRewardsUi(overview?.week?.settlesAt?.let { until(it, nowMillis) },
        overview?.week?.closesAt?.let { "Week closes $it" } ?: "Week close unavailable",
        standing?.currentWeekRatedAttacks, overview?.rewards?.minRatedAttacks,
        standing?.takeIf { configured }?.let { it.participationMet && it.rewardCandidate && !it.blockedByHigherBase },
        table.map { row -> LeagueRewardRowUi(row.crest, row.name, row.threshold.removeSuffix(" trophies"),
            row.reward ?: PriceUi(Currency.SHARDS, null, PriceStatus.UNAVAILABLE), if (row.isYou) items else emptyList(), row.isYou) },
        skrLine = null, footnote = footnote, load = actualLoad, paid = false, configured = configured)
    return HubLeagueUi(league, rewards)
}
