package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.charter.CharterProtocolPolicy
import gg.pixelkingdomwars.nativeclient.data.ClansState
import gg.pixelkingdomwars.nativeclient.data.charterAppPolicy
import gg.pixelkingdomwars.nativeclient.model.MyClan
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.land.solTextTrimmed
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.*
import kotlinx.serialization.json.JsonObject

/** Projection only. The existing Clans repository remains the sole leave/kick owner. */
internal const val CLAN_JOIN_UNAVAILABLE = "Joining, invitations and promotion are not open in this client. Existing clans are preserved."
internal const val CLAN_OWNER_CONTROLS = "Clan creation and saved payments stay in Clan Charters & Invitations. Open Kingdoms & Activities to continue."
/** CREATE stays locked until the catalogue supplies the charter rules (name and tag lengths, both creation prices). */
internal const val CLAN_RULES_LOADING = "Clan rules are loading. Refresh Clans."
/** The generic Clan Hall portrait: tier 1 stands in while the hall's tier is unknown. */
internal const val CLAN_HALL_GENERIC = "ui_portrait_clanhall_t1"

internal fun clanHubTab(tab: String?, hasClan: Boolean): String {
    val normalized = if (tab == "TOURNAMENT") "TOURNEY" else tab
    val tabs = if (hasClan) setOf("CLAN", "MEMBERS", "CHARTER", "TOURNEY") else setOf("FIND", "CREATE", "INVITES")
    return normalized?.takeIf { it in tabs } ?: if (hasClan) "CLAN" else "FIND"
}

private fun clanRosterCap(catalogue: JsonObject?): Int? =
    ((catalogue?.get("constants") as? JsonObject)?.get("CLANS") as? JsonObject)
        ?.string("rosterCap")?.toIntOrNull()?.takeIf { it > 0 }

/** Use the established catalogue tier rule only when that rule is present. */
private fun knownKeepTier(level: Int, catalogue: JsonObject?): Int? {
    val art = (catalogue?.get("constants") as? JsonObject)?.get("ART_V2") as? JsonObject ?: return null
    if (art.string("levelsPerTier")?.toIntOrNull()?.takeIf { it > 0 } == null ||
        art.string("tiers")?.toIntOrNull()?.takeIf { it > 0 } == null) return null
    return keepTierOf(level, catalogue)
}

/** The Clan Hall portrait for a known hall tier; the generic tier-1 portrait while the tier is unknown. */
internal fun clanHallPortrait(tier: Int?): String = tier?.let { "ui_portrait_clanhall_t${it.coerceIn(1, 4)}" } ?: CLAN_HALL_GENERIC

/** "3 to 16 letters" (or "4 letters" when both ends agree) from the catalogue's own bounds. */
private fun lengthRule(min: Int, max: Int): String = if (min == max) "$min letters" else "$min to $max letters"

/**
 * The clan name rule of the existing Charter owner (`CharterScreen` checks `nameMin..nameMax` from the same catalogue
 * policy); null = fine, nothing typed yet, or the rules are not loaded (CREATE is then locked with [CLAN_RULES_LOADING]).
 */
internal fun clanCreateNameError(name: String, policy: CharterProtocolPolicy?): String? {
    val n = name.trim()
    if (policy == null || n.isEmpty()) return null
    return if (n.length in policy.nameMin..policy.nameMax) null else lengthRule(policy.nameMin, policy.nameMax)
}

/** The clan tag rule from the same catalogue policy (`tagMin..tagMax`); null = fine, empty or rules not loaded. */
internal fun clanCreateTagError(tag: String, policy: CharterProtocolPolicy?): String? {
    val t = tag.trim()
    if (policy == null || t.isEmpty()) return null
    return if (t.length in policy.tagMin..policy.tagMax) null else lengthRule(policy.tagMin, policy.tagMax)
}

/** The creation's Shards price (catalogue `CLANS.createCostShards`); never a local figure. */
internal fun clanCreateShardsPrice(policy: CharterProtocolPolicy?): PriceUi? {
    val amount = policy?.createCostShards?.toBigIntegerOrNull() ?: return null
    return PriceUi(Currency.SHARDS, fmtN(amount.toString()), if (amount.signum() == 0) PriceStatus.SERVER_ZERO else PriceStatus.OK)
}

/** The creation's SOL core fee (catalogue `PHASE_E_CHARTER_PREPARATION.coreCreateFeeLamports`), as trimmed SOL text. */
internal fun clanCreateSolPrice(policy: CharterProtocolPolicy?): PriceUi? {
    val lamports = policy?.coreCreateFeeLamports?.toBigIntegerOrNull() ?: return null
    return PriceUi(Currency.SOL, solTextTrimmed(lamports), if (lamports.signum() == 0) PriceStatus.SERVER_ZERO else PriceStatus.OK)
}

internal fun clanLeaveReason(state: ClansState, wallet: String, landOwned: Boolean, stableBases: Boolean, baseId: String?): String? {
    val clan = state.membership?.clan
    return when {
        state.busy -> "A clan request is still finishing. Please wait."
        !landOwned -> "A Land Deed is required for new clan management."
        !state.supported -> "Clan management needs the server update. Existing standings remain available."
        state.blocking.isNotEmpty() -> "Check the saved clan change before making another change."
        clan == null -> "Refresh your clan membership before continuing."
        stableBases && baseId == null -> "Select a Land Deed before leaving this clan."
        clan.leaderWallet == wallet && clan.roster.size > 1 -> "The leader leaves last. Remove the other members first."
        else -> null
    }
}

internal fun clanLiveUi(
    state: ClansState, wallet: String, landOwned: Boolean, stableBases: Boolean, baseId: String?,
    catalogue: JsonObject?, selectedTab: String?, load: LoadState,
): ClanUi {
    val clan = state.membership?.clan.takeIf { landOwned }
    val cap = clanRosterCap(catalogue)?.toString() ?: UNKNOWN
    val rows = clan?.roster.orEmpty().map { member ->
        MemberRowUi(member.wallet, knownKeepTier(member.keepLevel, catalogue)?.let(::keepPortrait) ?: "building-keep",
            member.name?.takeIf { it.isNotBlank() } ?: member.wallet,
            if (member.wallet == clan?.leaderWallet) MemberRole.LEADER else null,
            member.wallet == wallet, "Keep ${member.keepLevel}", UNKNOWN,
            canKick = clan?.leaderWallet == wallet && member.wallet != wallet)
    }
    // confirm.png: the clan hall → your Keep picture. The hall's tier is not observed (generic portrait); your Keep uses the
    // catalogue tier rule only when the rule and your roster row are present.
    val ownKeep = state.membership?.clan?.roster?.firstOrNull { it.wallet == wallet }
        ?.let { knownKeepTier(it.keepLevel, catalogue) }?.let(::keepPortrait) ?: "building-keep"
    val review = state.review
    // Leave: the frame's chest line ("Your 7 wins stay in this week's chest") cannot be verified from server state, so the
    // dialog keeps the factual payout destination and the last-member rule.
    val confirm = review?.let {
        if (it.target != null) ConfirmUi("Remove this member?", "itm_banner", null,
            "Remove ${it.target}?", "Original clan: ${it.clanName}. This request cannot change clan or member.", "REMOVE")
        else ConfirmUi("LEAVE ${it.clanName.uppercase()}?", clanHallPortrait(null), ownKeep,
            "Any accrued SHARDS: ${it.baseId?.let { id -> "original deed $id" } ?: "your wallet balance"}.",
            "Last member dissolves clan. Server records payout. Joining is closed.", "LEAVE CLAN")
    }
    return ClanUi(
        name = clan?.name, tag = clan?.tag?.let { "[$it]" }, hallTier = null,
        members = clan?.let { "${it.roster.size}/$cap members" },
        inviteMode = clan?.let { if (it.inviteMode == "invite") "INVITE ONLY" else "OPEN" },
        rank = null, chestEndsIn = null, chest = null, top = emptyList(), inviteCode = clan?.inviteCode,
        tabs = if (landOwned) clanTabs() else emptyList(),
        // Membership not read yet (the first frame after tapping the Clan Hall) or a failed read: this is the CLAN card's
        // loading / error state, so its CLAN tab stays lit. A finder tab id is not in this strip and left every tab unlit.
        selectedTab = clanHubTab(selectedTab, clan != null || state.membership == null), chatUnread = 0, noClan = null,
        requiresLand = !landOwned, load = load, allMembers = rows, isLeader = clan?.leaderWallet == wallet,
        confirm = confirm, landLink = HubLink(FeatureId("profile.land")),
        leaveReason = clanLeaveReason(state, wallet, landOwned, stableBases, baseId), chatLabel = "CHAT",
        chestUnavailable = "Weekly chest totals and the reset time are unavailable. Existing chest rewards are preserved.",
    )
}

internal fun clanMembersLiveUi(clan: MyClan, wallet: String, catalogue: JsonObject?, sort: MemberSort, expandedId: String?): ClanMembersUi =
    ClanMembersUi(
        sort = if (sort == MemberSort.TROPHIES) sort else MemberSort.TROPHIES,
        members = clan.roster.map { member -> ClanMemberUi(
            id = member.wallet, name = member.name?.takeIf { it.isNotBlank() } ?: member.wallet,
            role = if (member.wallet == clan.leaderWallet) ClanRole.LEADER else ClanRole.MEMBER,
            isYou = member.wallet == wallet, keepLevel = member.keepLevel.toString(),
            keepTier = knownKeepTier(member.keepLevel, catalogue), lastSeen = UNKNOWN, online = false,
            trophies = member.trophies.toLong(), trophiesText = fmtN(member.trophies.toString()), wins = null,
            leagueCrest = "trophy",
        ) },
        myRole = if (clan.leaderWallet == wallet) ClanRole.LEADER else ClanRole.MEMBER,
        expandedId = expandedId?.takeIf { id -> clan.roster.any { it.wallet == id } },
        sorts = listOf(MemberSort.TROPHIES), onlineKnown = false,
        visitUnavailable = "Member visits are unavailable here. Find their kingdom on the world map.",
        promoteUnavailable = "Promotion is not open in this client. Only the leader can remove a member.",
    )

/**
 * The clanless finder. [name], [tag] and [inviteOnly] are the CREATE drafts the host holds; the name / tag rules and both
 * creation prices come only from the catalogue's charter policy ([charterAppPolicy]). Without that policy CREATE locks
 * with [CLAN_RULES_LOADING]. CREATE CLAN hands off to the existing charter owner ([CLAN_OWNER_CONTROLS]); no banner or
 * minimum-trophies field exists in that owner's create request, so neither is offered.
 */
internal fun clanFinderLiveUi(
    state: ClansState, catalogue: JsonObject?, tab: String?, query: String, filter: String, code: String,
    name: String = "", tag: String = "", inviteOnly: Boolean = false, captain: String = UNKNOWN,
): ClanFinderUi {
    val cap = clanRosterCap(catalogue)
    val policy = charterAppPolicy(catalogue)?.protocol
    val selectedFilter = filter.takeIf { it == "OPEN" } ?: "ALL"
    val results = state.board?.clans.orEmpty().filter { row ->
        (selectedFilter != "OPEN" || row.inviteMode == "open") &&
            (query.isBlank() || row.name.contains(query.trim(), ignoreCase = true) || row.tag.contains(query.trim(), ignoreCase = true))
    }.map { row -> ClanListingUi(
        id = row.id, name = row.name, tag = "[${row.tag}]", bannerIcon = "itm_banner", realmName = UNKNOWN,
        realmThumb = null, members = "${row.members}/${cap?.toString() ?: UNKNOWN}", leagueCrest = "trophy", minTrophies = UNKNOWN,
        join = if (row.inviteMode == "invite") ClanJoinMode.ASK else ClanJoinMode.OPEN,
        joinUnavailable = CLAN_JOIN_UNAVAILABLE,
        // The board carries neither a realm nor a joining minimum: the card hides both instead of drawing "…" forever.
        realmKnown = false, minTrophiesKnown = false,
    ) }
    return ClanFinderUi(
        tab = clanHubTab(tab, hasClan = false),
        search = ClanSearchUi(query, selectedFilter, results, code, loading = state.busy,
            codeUnavailable = CLAN_JOIN_UNAVAILABLE, observationKnown = state.board != null, filters = listOf(FilterChipUi("ALL", "ALL CLANS"), FilterChipUi("OPEN", "OPEN"))),
        create = ClanCreateUi(name, tag, inviteOnly, "itm_banner", emptyList(), 0, UNKNOWN, clanCreateSolPrice(policy),
            nameError = clanCreateNameError(name, policy), tagError = clanCreateTagError(tag, policy),
            captainName = captain, controlsOnlyReason = CLAN_OWNER_CONTROLS,
            nameMax = policy?.nameMax, tagMax = policy?.tagMax,
            nameRule = policy?.let { lengthRule(it.nameMin, it.nameMax) },
            tagRule = policy?.let { if (it.tagMin == it.tagMax) "${it.tagMin}" else "${it.tagMin}-${it.tagMax}" },
            shardsPrice = clanCreateShardsPrice(policy),
            lockedReason = if (policy == null) CLAN_RULES_LOADING else null),
        invites = emptyList(), hallTier = null, minTrophiesStep = 0, minTrophiesMax = 0, invitesKnown = false,
    )
}

/** The separate Charter owner has not supplied registration/history; membership alone never proves either. */
internal fun clanCharterSummaryUi(clan: MyClan, wallet: String, catalogue: JsonObject?): ClanCharterUi {
    val captain = clan.roster.firstOrNull { it.wallet == clan.leaderWallet }
    return ClanCharterUi(
        registered = false, clanName = clan.name, bannerIcon = "itm_banner",
        captainName = captain?.name?.takeIf { it.isNotBlank() } ?: captain?.wallet ?: UNKNOWN,
        captainTier = captain?.let { knownKeepTier(it.keepLevel, catalogue) },
        joining = if (clan.inviteMode == "invite") "By invite" else "Open to all", founded = UNKNOWN,
        roster = "${clan.roster.size} of ${clanRosterCap(catalogue)?.toString() ?: UNKNOWN}",
        amCaptain = clan.leaderWallet == wallet, inviteOnly = clan.inviteMode == "invite",
        // The captain tools live with the existing Charter owner: their padlock explains where.
        pausedReason = CLAN_OWNER_CONTROLS, observationKnown = false,
    )
}

/** Unavailable observation hides every event assertion, including the placeholder enum and entered flag. */
internal fun clanTourneySummaryUi(clan: MyClan, wallet: String): ClanTourneyUi = ClanTourneyUi(
    eventId = "", weekLine = UNKNOWN, phase = TourneyPhase.CLOSED, entered = false, enteredBy = null, enteredByTier = 1,
    rosterLine = UNKNOWN, inRoster = false, amCaptain = clan.leaderWallet == wallet,
    prizes = emptyList(), fightsUsed = null, fightsMax = null, opensIn = null, lastTitle = null, lastSub = null,
    observationKnown = false,
)
