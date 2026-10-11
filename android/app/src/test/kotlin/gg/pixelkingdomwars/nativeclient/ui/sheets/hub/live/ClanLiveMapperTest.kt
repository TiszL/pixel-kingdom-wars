package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.data.ClanReview
import gg.pixelkingdomwars.nativeclient.data.ClansState
import gg.pixelkingdomwars.nativeclient.model.ClanBoard
import gg.pixelkingdomwars.nativeclient.model.ClanMember
import gg.pixelkingdomwars.nativeclient.model.ClanMembership
import gg.pixelkingdomwars.nativeclient.model.ClanRank
import gg.pixelkingdomwars.nativeclient.model.MyClan
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.ClanFinderUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.ClanInviteUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.ClanRole
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.MemberSort
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.PrimaryTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.TOURNEY_UNOBSERVED_REASON
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.charterToolLock
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.clanCreateFormLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.clanCreateTagDraft
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.clanFinderTabsFor
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.clanInvitesNote
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.clanMemberChips
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.clanMemberLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.clanTourneyFooterLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.primaryTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.clanTabs
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.*
import org.junit.Test

class ClanLiveMapperTest {
    private val captain = "11111111111111111111111111111111"
    private val member = "22222222222222222222222222222222"
    private val clanId = "00000000-0000-0000-0000-000000000001"
    private val clan = MyClan(clanId, "Wardens", "WARD", "invite", captain, "saved-code", listOf(
        ClanMember(captain, "2026-10-01T00:00:00Z", "Captain", 12, 1500, true),
        ClanMember(member, "2026-10-02T00:00:00Z", "Member", 3, 42, false)))
    private val state = ClansState(membership = ClanMembership(clan), supported = true)
    private fun shell(value: ClansState = state, wallet: String = member, land: Boolean = true, base: String? = "deed") =
        clanLiveUi(value, wallet, land, true, base, null, "CLAN", LoadState.Ready)
    private val clanless = ClansState(membership = ClanMembership(null), supported = true)
    /** The charter policy as the catalogue ships it (same keys `charterAppPolicy` reads); each test varies what it pins. */
    private fun charterCatalogue(nameMin: Int = 3, nameMax: Int = 16, tagMin: Int = 3, tagMax: Int = 4,
        shards: Long = 5000, lamports: Long = 1_500_000): JsonObject = buildJsonObject { putJsonObject("constants") {
        putJsonObject("CLANS") { put("nameMinLen", nameMin); put("nameMaxLen", nameMax); put("tagMinLen", tagMin); put("tagMaxLen", tagMax); put("createCostShards", shards) }
        putJsonObject("PHASE_E_POLICY") { put("basisPoints", 10000) }
        putJsonObject("PHASE_E_CHARTER_TRANSFER") { put("royaltyBps", 500) }
        putJsonObject("PHASE_E_CHARTER_PREPARATION") { put("computeUnitLimit", 400000); put("coreCreateFeeLamports", lamports) }
        putJsonObject("PHASE_E_CHARTER_ADMISSION") { putJsonObject("v1") { put("issuedPermitTtlSec", 540); put("observationMaxAgeMs", 10000) } }
        putJsonObject("PHASE_E_SEEKER_AUCTION") { put("maxPolicyPermitTtlSec", 600) }
    } }

    @Test fun `membership maps exact clan and invite without invented chest or rank`() {
        val ui = shell()
        assertEquals("Wardens", ui.name)
        assertEquals("[WARD]", ui.tag)
        assertEquals("2/$UNKNOWN members", ui.members)
        assertEquals("INVITE ONLY", ui.inviteMode)
        assertEquals("saved-code", ui.inviteCode)
        assertNull(ui.rank)
        assertNull(ui.chest)
        assertNull(ui.chestEndsIn)
        assertTrue(ui.top.isEmpty())
        assertNull(ui.hallTier)
    }
    @Test fun `roster cap is supplied only by catalogue`() {
        val catalogue = Json.parseToJsonElement("""{"constants":{"CLANS":{"rosterCap":30}}}""").jsonObject
        val ui = clanLiveUi(state, member, true, true, "deed", catalogue, "CLAN", LoadState.Ready)
        assertEquals("2/30 members", ui.members)
    }
    @Test fun `members preserve trophies but do not invent online wins elder or art tier`() {
        val ui = clanMembersLiveUi(clan, member, null, MemberSort.TROPHIES, captain)
        assertEquals(ClanRole.MEMBER, ui.myRole)
        assertEquals(listOf(MemberSort.TROPHIES), ui.sorts)
        assertEquals(1500L, ui.members.first().trophies)
        assertEquals(ClanRole.LEADER, ui.members.first().role)
        assertNull(ui.members.first().wins)
        assertNull(ui.members.first().keepTier)
        assertFalse(ui.onlineKnown)
        assertEquals(UNKNOWN, ui.members.first().lastSeen)
        assertTrue(ui.members.last().isYou)
        assertNotNull(ui.promoteUnavailable)
        assertNotNull(ui.visitUnavailable)
    }
    @Test fun `leader cannot leave while another member remains`() {
        assertTrue(shell(wallet = captain).leaveReason!!.contains("leader leaves last", ignoreCase = true))
        assertNull(shell().leaveReason)
    }
    @Test fun `missing deed and unsupported protocol retain explicit command refusal`() {
        assertTrue(shell(base = null).leaveReason!!.contains("Land Deed"))
        assertTrue(shell(state.copy(supported = false)).leaveReason!!.contains("server update"))
        assertTrue(shell(land = false).requiresLand)
    }
    @Test fun `frozen leave review keeps original payout destination and unknown outcome`() {
        val ui = shell(state.copy(review = ClanReview(clanId, "Original Clan", "original-deed", null, 7)))
        val review = requireNotNull(ui.confirm)
        // Rewritten deliberately (confirm.png): the title is the frame's PS question "LEAVE {CLAN NAME}?", so the frozen
        // original clan name is asserted in upper case. It must still be the review's clan, not the live one.
        assertTrue(review.title.contains("ORIGINAL CLAN"))
        assertTrue(review.line.contains("original-deed"))
        assertTrue(review.subLine!!.contains("last member", ignoreCase = true))
        assertFalse(review.line.contains("nothing was spent", ignoreCase = true))
    }
    @Test fun `frozen kick review carries original clan and exact selected member`() {
        val ui = shell(state.copy(review = ClanReview(clanId, "Original Clan", null, member, 7)))
        assertTrue(ui.confirm!!.line.contains(member))
        assertTrue(ui.confirm!!.subLine!!.contains("Original Clan"))
    }
    @Test fun `finder searches current authoritative board and keeps joining closed`() {
        val board = ClanBoard(listOf(
            ClanRank(clanId, "Wardens", "WARD", "invite", 2, 1542),
            ClanRank("00000000-0000-0000-0000-000000000002", "Sunrise", "SUN", "open", 5, 999)))
        val ui = clanFinderLiveUi(ClansState(membership = ClanMembership(null), board = board), null, "FIND", "ward", "ALL", "")
        assertEquals(listOf(clanId), ui.search.results.map { it.id })
        assertNotNull(ui.search.results.single().joinUnavailable)
        assertEquals(UNKNOWN, ui.search.results.single().minTrophies)
        assertEquals(UNKNOWN, ui.search.results.single().realmName)
        assertFalse(ui.invitesKnown)
        assertNotNull(ui.create.controlsOnlyReason)
        assertNull(ui.create.price)
        assertTrue(ui.create.banners.isEmpty())
    }
    @Test fun `finder open filter does not infer realm or recommendation`() {
        val board = ClanBoard(listOf(ClanRank(clanId, "Wardens", "WARD", "invite", 2, 1542)))
        val ui = clanFinderLiveUi(ClansState(board = board), null, "FIND", "", "OPEN", "")
        assertTrue(ui.search.results.isEmpty())
        assertEquals(listOf("ALL", "OPEN"), ui.search.filters.map { it.id })
    }
    @Test fun `charter summary does not claim registration from ordinary membership`() {
        val ui = clanCharterSummaryUi(clan, captain, null)
        assertFalse(ui.observationKnown)
        assertEquals("Captain", ui.captainName)
        assertEquals("2 of $UNKNOWN", ui.roster)
        assertNotNull(ui.pausedReason)
        assertTrue(ui.pending.isEmpty())
    }
    @Test fun `tournament summary does not invent event entry prizes or fight count`() {
        val ui = clanTourneySummaryUi(clan, captain)
        assertFalse(ui.observationKnown)
        assertTrue(ui.prizes.isEmpty())
        assertNull(ui.fightsUsed)
        assertNull(ui.fightsMax)
        assertFalse(ui.prizeClaimable)
        assertEquals("", ui.eventId)
    }
    @Test fun `clan tabs normalize registry alias and restored invalid tab`() {
        assertEquals("TOURNEY", clanHubTab("TOURNAMENT", hasClan = true))
        assertEquals("MEMBERS", clanHubTab("MEMBERS", hasClan = true))
        assertEquals("CLAN", clanHubTab("unknown", hasClan = true))
        assertEquals("CREATE", clanHubTab("CREATE", hasClan = false))
        assertEquals("FIND", clanHubTab("MEMBERS", hasClan = false))
    }

    // Why: tapping the Clan Hall shows the CLAN card while membership is still being read (and again if the read fails).
    // The shell used to normalise to the finder's FIND, which is not in the member strip, so no tab was lit and the strip
    // stood open over the parchment. It is the CLAN card's loading / error state, so CLAN stays the lit tab.
    @Test fun `before membership is read the clan card lights its CLAN tab`() {
        for (requested in listOf(null, "FIND", "CLAN", "TOURNAMENT")) for (load in listOf(LoadState.Loading, LoadState.Error("Clans could not refresh."))) {
            val ui = clanLiveUi(ClansState(supported = true), member, true, true, "deed", null, requested, load)
            assertEquals(if (requested == "TOURNAMENT") "TOURNEY" else "CLAN", ui.selectedTab)
            assertTrue(ui.selectedTab in ui.tabs.map { it.id })
        }
        // A read clanless membership still belongs to the finder (ClanHub draws ClanFinderSheet), so nothing changes there.
        assertEquals("FIND", clanLiveUi(clanless, member, true, true, "deed", null, "CLAN", LoadState.Ready).selectedTab)
    }

    @Test fun `unobserved finder board is not an observed empty result`() {
        val missing = clanFinderLiveUi(ClansState(membership = ClanMembership(null)), null, "FIND", "", "ALL", "")
        val empty = clanFinderLiveUi(ClansState(membership = ClanMembership(null), board = ClanBoard(emptyList())), null, "FIND", "", "ALL", "")
        assertFalse(missing.search.observationKnown)
        assertTrue(empty.search.observationKnown)
        assertTrue(missing.search.results.isEmpty()); assertTrue(empty.search.results.isEmpty())
    }
    @Test fun `captain portrait remains generic until catalogue supplies the art rule`() {
        assertNull(clanCharterSummaryUi(clan, captain, null).captainTier)
        val catalogue = Json.parseToJsonElement("""{"constants":{"ART_V2":{"levelsPerTier":4,"tiers":4}}}""").jsonObject
        assertEquals(3, clanCharterSummaryUi(clan, captain, catalogue).captainTier)
    }
    @Test fun `existing player chat is not presented as an unavailable Clan channel`() {
        assertEquals("CHAT", shell().chatLabel)
        assertEquals(0, shell().chatUnread)
    }

    // Why: the length rules are the catalogue's, the same policy the Charter owner enforces; a local 3..16 / 3..4 would
    // hand players to Bases with a name that owner refuses, or refuse one it accepts.
    @Test fun `create name and tag limits follow the catalogue charter policy`() {
        val narrow = clanFinderLiveUi(clanless, charterCatalogue(nameMin = 3, nameMax = 16, tagMin = 3, tagMax = 4), "CREATE", "", "ALL", "",
            name = "Twenty Letter Clan Nm", tag = "WARDS")
        val wide = clanFinderLiveUi(clanless, charterCatalogue(nameMin = 2, nameMax = 24, tagMin = 2, tagMax = 5), "CREATE", "", "ALL", "",
            name = "Twenty Letter Clan Nm", tag = "WARDS")
        assertEquals("3 to 16 letters", narrow.create.nameError)
        assertEquals("3 to 4 letters", narrow.create.tagError)
        assertNull(wide.create.nameError)
        assertNull(wide.create.tagError)
        assertEquals(16, narrow.create.nameMax); assertEquals(24, wide.create.nameMax)
        assertEquals("2 to 24 letters", wide.create.nameRule); assertEquals("2-5", wide.create.tagRule)
        // The TAG draft is cut by the Ui's catalogue value, not a fixed four, and keeps only the tag grammar's characters.
        assertEquals("WARDS", clanCreateTagDraft("wa-rds!", wide.create.tagMax))
        assertEquals("WARD", clanCreateTagDraft("wa-rds!", narrow.create.tagMax))
    }

    // Why: CREATE shows what the existing owner will charge (Shards and the SOL core fee); a placeholder would misstate money.
    @Test fun `create prices are the catalogue Shards cost and SOL core fee`() {
        val a = clanFinderLiveUi(clanless, charterCatalogue(shards = 5000, lamports = 1_500_000), "CREATE", "", "ALL", "")
        val b = clanFinderLiveUi(clanless, charterCatalogue(shards = 40000, lamports = 20_000_000), "CREATE", "", "ALL", "")
        assertEquals(PriceUi(Currency.SHARDS, "5,000", PriceStatus.OK), a.create.shardsPrice)
        assertEquals(PriceUi(Currency.SOL, "0.0015", PriceStatus.OK), a.create.price)
        assertEquals("40,000", b.create.shardsPrice!!.amount)
        assertEquals("0.02", b.create.price!!.amount)
        assertNull(a.create.lockedReason)
    }

    // Why: without the catalogue rules nothing can be checked or priced, so CREATE must say why instead of guessing.
    @Test fun `missing charter policy locks create with its reason and no invented price`() {
        val ui = clanFinderLiveUi(clanless, null, "CREATE", "", "ALL", "", name = "Iron Wardens", tag = "IRN")
        assertEquals(CLAN_RULES_LOADING, ui.create.lockedReason)
        assertNull(ui.create.price); assertNull(ui.create.shardsPrice)
        assertNull(ui.create.nameMax); assertNull(ui.create.nameRule)
        val look = clanCreateFormLook(ui.create)
        assertEquals(CommandState.LOCKED, look.state)
        assertEquals("Clan rules are loading. Refresh Clans.", look.reason)
        assertEquals(PrimaryTap.EXPLAIN, primaryTap(look))
    }

    // Why: typing must reach the form (it used to be a constant empty draft), and the hand-off opens only for a valid draft.
    @Test fun `create drafts flow into the form and gate the hand off`() {
        val catalogue = charterCatalogue()
        val typed = clanFinderLiveUi(clanless, catalogue, "CREATE", "", "ALL", "", name = "Iron Wardens", tag = "IRN", inviteOnly = true, captain = "Rowan")
        assertEquals("Iron Wardens", typed.create.name); assertEquals("IRN", typed.create.tag); assertTrue(typed.create.inviteOnly)
        assertEquals("Rowan", typed.create.captainName)
        assertEquals(CommandState.ENABLED, clanCreateFormLook(typed.create).state)
        assertEquals(CLAN_OWNER_CONTROLS, typed.create.controlsOnlyReason)
        assertEquals(CommandState.DISABLED, clanCreateFormLook(clanFinderLiveUi(clanless, catalogue, "CREATE", "", "ALL", "").create).state)
        val tooShort = clanFinderLiveUi(clanless, catalogue, "CREATE", "", "ALL", "", name = "Ir", tag = "IRN")
        assertEquals(CommandState.DISABLED, clanCreateFormLook(tooShort.create).state)
    }

    // Why: the owner's create request has no banner or minimum-trophies field; offering either would invent a setting.
    @Test fun `create offers no banner or minimum trophies without a backing field`() {
        val ui = clanFinderLiveUi(clanless, charterCatalogue(), "CREATE", "", "ALL", "")
        assertTrue(ui.create.banners.isEmpty())
        assertEquals(0, ui.minTrophiesStep); assertEquals(0, ui.minTrophiesMax)
        // A finder built without explicit bounds draws no stepper either (the old 100 / 5000 defaults were game numbers).
        val defaults = ClanFinderUi("FIND", ui.search, ui.create, emptyList(), null)
        assertEquals(0, defaults.minTrophiesStep); assertEquals(0, defaults.minTrophiesMax)
    }

    // Why: the board carries neither a realm nor a joining minimum; drawing "…" for them forever reads as a broken load.
    @Test fun `finder cards hide the realm and joining minimum the board does not carry`() {
        val board = ClanBoard(listOf(ClanRank(clanId, "Wardens", "WARD", "open", 2, 1542)))
        val card = clanFinderLiveUi(ClansState(membership = ClanMembership(null), board = board), null, "FIND", "", "ALL", "").search.results.single()
        assertFalse(card.realmKnown)
        assertFalse(card.minTrophiesKnown)
        assertEquals(CLAN_JOIN_UNAVAILABLE, card.joinUnavailable)
    }

    // Why: no client API lists invitations, so the tab must say so plainly and never show an unread count.
    @Test fun `invites tab says plainly invitations are not open and shows no badge`() {
        val ui = clanFinderLiveUi(clanless, null, "INVITES", "", "ALL", "")
        assertEquals("INVITES", ui.tab)
        assertEquals("Clan invitations are not open yet.", clanInvitesNote(ui))
        assertNull(clanFinderTabsFor(ui).single { it.id == "INVITES" }.badge)
        val known = ui.copy(invitesKnown = true, invites = listOf(ClanInviteUi("i1", "Wardens", "[WARD]", "itm_banner", "Captain")))
        assertNull(clanInvitesNote(known))
        assertNotNull(clanFinderTabsFor(known).single { it.id == "INVITES" }.badge)
    }

    // Why: the roster read has trophies only; sorts, online dots, "seen" text, ELDER or NEW tags would all be invented.
    @Test fun `members expose only provided sorts and make no online claims`() {
        val ui = clanMembersLiveUi(clan, member, null, MemberSort.ONLINE, null)
        assertEquals(MemberSort.TROPHIES, ui.sort)
        assertEquals(listOf("TROPHIES"), clanMemberChips(ui).map { it.id })
        assertTrue(clanMemberChips(ui).all { it.count == null })
        assertTrue(ui.members.none { it.online })
        assertEquals("Keep 12", clanMemberLine(ui.members.first(), ui.onlineKnown))
        assertEquals(listOf(ClanRole.LEADER, ClanRole.MEMBER), ui.members.map { it.role })
        assertTrue(ui.members.none { it.isNew })
        assertEquals("Promotion is not open in this client. Only the leader can remove a member.", ui.promoteUnavailable)
    }

    // Why: confirm.png draws clan hall → your Keep and a red LEAVE CLAN; the Keep tier follows the catalogue rule for YOUR row.
    @Test fun `leave confirm follows the frame with clan hall to keep and a red LEAVE CLAN`() {
        val review = ClanReview(clanId, "Original Clan", "original-deed", null, 7)
        val catalogue = Json.parseToJsonElement("""{"constants":{"ART_V2":{"levelsPerTier":1,"tiers":4}}}""").jsonObject
        val known = requireNotNull(clanLiveUi(state.copy(review = review), member, true, true, "deed", catalogue, "CLAN", LoadState.Ready).confirm)
        assertEquals("LEAVE ORIGINAL CLAN?", known.title)
        assertEquals("LEAVE CLAN", known.confirmLabel)
        assertEquals(Verb.RED, known.tone)
        assertEquals(CLAN_HALL_GENERIC, known.fromIcon)
        assertEquals("ui_portrait_keep_t3", known.toIcon)
        assertEquals("building-keep", requireNotNull(shell(state.copy(review = review)).confirm).toIcon)
    }

    // Why: a tool the clan read cannot observe must still answer: padlock + "captain", and a tap says where it lives.
    @Test fun `unobserved charter tools show the captain padlock and explain the existing owner`() {
        val lock = requireNotNull(charterToolLock(clanCharterSummaryUi(clan, member, null)))
        assertEquals("captain", lock.note)
        assertEquals(CLAN_OWNER_CONTROLS, lock.reason)
        assertEquals(CLAN_OWNER_CONTROLS, requireNotNull(charterToolLock(clanCharterSummaryUi(clan, captain, null))).reason)
    }

    // Why: without an event read FIND MATCH cannot act here, but RANKINGS still opens the owner and the lock says why.
    @Test fun `unobserved tournament foot locks FIND MATCH with its reason`() {
        val look = clanTourneyFooterLook(clanTourneySummaryUi(clan, captain))
        assertEquals("FIND MATCH", look.label)
        assertEquals(CommandState.LOCKED, look.state)
        assertEquals(TOURNEY_UNOBSERVED_REASON, look.reason)
        assertEquals(PrimaryTap.EXPLAIN, primaryTap(look))
    }

    // Why: the stacked member tabs carry the clan-members.png art (crest on CLAN, banner on CHARTER).
    @Test fun `member tabs carry the frame art in order`() {
        assertEquals(listOf("itm_crest", "referral", "itm_banner", "trophy"), clanTabs().map { it.icon })
        assertEquals(listOf("CLAN", "MEMBERS", "CHARTER", "TOURNEY"), shell().tabs.map { it.id })
    }
}
