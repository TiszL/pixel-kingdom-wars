package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.miningcontribution.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteIdentity
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.phasee.islandShareTime
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.*
import java.time.ZoneOffset
import java.util.Locale
import org.junit.Assert.*
import org.junit.Test

/** Authored first; UNRUN. Only Cedar3 may execute the composed candidate. */
class GoldForgeHomeAdapterTest {
    private val wallet = "11111111111111111111111111111112"
    private val other = "11111111111111111111111111111113"
    private val base = "00000000-0000-4000-8000-000000000001"
    private val identity = HomeRouteIdentity(Any(), base, 3)
    private val miningIdentity = MiningContributionIdentity("https://example.invalid", "devnet", wallet)
    private val policy = MiningClaimsProtocolPolicy(3, 1, 71)
    private fun data() = GoldForgeHomeData(identity, wallet)
    private fun map(value: GoldForgeHomeData = data(), requested: String? = null, selected: String? = null,
        keep: Long? = null) = goldForgeHomeUi(value, identity, requested, selected, keep)
    private fun funds(value: String? = "23.5") = WalletFunds(null, mapOf("KEEP" to value), 0)
    private fun gems(value: String = "73") = GemsState(supported = true, enabled = true,
        overview = GemsOverview(BalanceFeatures(GemsFeature(1, 1)), value, emptyList(), emptyList(),
            minConvertKeep = 3, maxConvertKeepPerTx = 91, gemsPerKeep = 1, shardsPerGem = 17,
            serverNow = "2026-10-04T07:00:00.000Z"))
    private fun buy() = GemsBuyState(available = true,
        capability = GemsCapability(true, listOf("wallet-keep"), other, 1, 17, 3, 91))
    private fun status() = MiningClaimStatusView(MiningClaimFeatures(MiningClaimFeature(1, 1)), wallet,
        "shardkeep-economy", other, wallet, "ready", null, "1", "9007199254740993", "0",
        "9007199254740993", 3, 5, "200", "100", false, false, true, false,
        "2026-10-04T07:00:00.000Z")
    private fun claimData() = data().copy(claimStatus = status(), claimPolicy = policy, claimsCurrent = true)
    private fun buyData() = data().copy(buy = buy(), buyCurrent = true, walletFunds = funds(), walletCurrent = true)
    private fun contribution() = MiningContributionState(
        MiningContributionJournal(1, miningIdentity, 0, null, emptyList()),
        MiningContributionView(wallet, base, 3, "2026-10-04", "2026-10-04T07:00:00.000Z", true,
            "free", "100000", "9007199254740993", "0", true,
            miningContributionResourceIds(3).map { MiningContributionStock(it, "17", "23") },
            MiningConsistencyPolicy(7, 17, 119)), advertised = true)

    @Test fun `missing reads are honest unavailable bridges with unknown balances`() {
        val out = map()
        assertNull(out.sheet.smelt); assertNull(out.sheet.claim); assertNull(out.sheet.gems)
        assertEquals(listOf("…", "…"), out.sheet.stack.map { it.value })
        assertEquals(setOf("SMELT", "CLAIM", "GEMS"), out.notices.keys)
        assertTrue(out.notices.values.all { it.isNotBlank() && !it.startsWith("Checking") })
        assertFalse(out.sheet.history); assertNull(out.sheet.legacy)
    }

    @Test fun `retained values need independent current witnesses`() {
        val out = map(data().copy(building = Building("forge", "goldforge", 3, 1, 2), contribution = contribution(),
            gems = gems(), buy = buy(), walletFunds = funds(), claimStatus = status(), claimPolicy = policy))
        assertEquals("…", out.sheet.level); assertFalse(out.sheet.sceneWorking)
        assertNull(out.sheet.smelt); assertNull(out.sheet.claim); assertNull(out.sheet.gems)
        assertEquals(listOf("…", "…"), out.sheet.stack.map { it.value })
        assertTrue(out.sheet.tabs.all { it.badge == null })
    }

    @Test fun `session base and generation changes retire every old projection`() {
        val value = claimData().copy(building = Building("forge", "goldforge", 3, 1, 2), buildingCurrent = true,
            gems = gems(), gemsCurrent = true, walletFunds = funds(), walletCurrent = true)
        listOf(null, HomeRouteIdentity(Any(), base, 3), HomeRouteIdentity(identity.session, "other-base", 3),
            HomeRouteIdentity(identity.session, base, 4)).forEach { current ->
            val out = goldForgeHomeUi(value, current)
            assertNull(out.sheet.claim); assertFalse(out.sheet.sceneWorking)
            assertEquals(listOf("…", "…"), out.sheet.stack.map { it.value })
            assertTrue(out.sheet.tabs.all { it.badge == null })
        }
    }

    @Test fun `current building and exact wallet amounts use existing shell projection`() {
        val out = map(data().copy(building = Building("forge", "goldforge", 3, 1, 2), buildingCurrent = true,
            gems = gems("0"), gemsCurrent = true, walletFunds = funds("9007199254740993.123"), walletCurrent = true))
        assertEquals("LV 3", out.sheet.level); assertTrue(out.sheet.sceneWorking)
        assertEquals("0", out.sheet.stack.first().value)
        assertEquals("Wallet KEEP 9,007,199,254,740,993.123", out.sheet.stack.last().exactDescription)
        assertTrue(out.sheet.stack.all { it.gain == null })
    }

    @Test fun `custodial KEEP never substitutes for wallet KEEP`() {
        val out = map(data().copy(gems = gems().copy(balances = Balances("12", "999999", gems = "73")), gemsCurrent = true))
        assertEquals("…", out.sheet.stack.last().value); assertNull(out.sheet.gems)
    }

    @Test fun `validated claim status is exact read only and determines default tab`() {
        val out = map(claimData()); val ui = requireNotNull(out.sheet.claim)
        assertEquals("9007199254740.993", ui.ready)
        assertEquals(ClaimPhase.READY, ui.phase); assertEquals(MoneyStage.READY, ui.stage)
        assertFalse(ui.actionsAllowed); assertFalse(ui.canResumeSaved); assertNull(ui.seal)
        // Rewritten (S3, 2026-10-06): this pinned the old quiet read-only CLAIM (action NONE). The new rule: no claim
        // owner can act from this sheet, so the ready CLAIM stays off on its face and a tap explains that collecting is
        // not open yet. It still never becomes a CLAIM action.
        val look = claimPrimaryLook(ui)
        assertEquals(ForgeAction.EXPLAIN_LOCK, look.action); assertEquals(CommandState.DISABLED, look.state)
        assertEquals(GOLD_FORGE_CLAIM_CLOSED, ui.closedReason); assertEquals(GOLD_FORGE_CLAIM_CLOSED, look.reason)
        assertEquals("CLAIM", out.sheet.selectedTab)
        assertEquals("!", out.sheet.tabs.single { it.id == "CLAIM" }.badge?.text)
    }

    @Test fun `selected tab then requested tab override automatic claim default`() {
        assertEquals("GEMS", map(claimData(), "smelt", "gems").sheet.selectedTab)
        assertEquals("SMELT", map(claimData(), "smelt").sheet.selectedTab)
        assertEquals("CLAIM", map(claimData(), "LEGACY").sheet.selectedTab)
        assertEquals(listOf("SMELT", "CLAIM", "GEMS"), map().sheet.tabs.map { it.id })
    }

    @Test fun `claim rejects wrong wallet policy and malformed status`() {
        listOf(claimData().copy(claimStatus = status().copy(wallet = other)),
            claimData().copy(claimPolicy = policy.copy(tokenDecimals = 2)),
            claimData().copy(claimStatus = status().copy(claimableBaseUnits = "1e9")),
            claimData().copy(wallet = "")).forEach { value ->
            val out = map(value); assertNull(out.sheet.claim)
            assertNull(out.sheet.tabs.single { it.id == "CLAIM" }.badge)
        }
    }

    // Rewritten (S3, 2026-10-06): this pinned the island-share timestamp (year, time and zone). The new rule is the
    // frame's day ("Wed 14 Oct", claim-locked.png), still taken only from the server's unlock second. The server reason
    // is a technical code, so the tray's reason line stays hidden.
    @Test fun `delayed claim uses only authoritative timestamp and stays locked`() {
        val out = map(claimData().copy(claimStatus = status().copy(state = "delayed", preparationAllowed = false,
            chainUnixTimestamp = "50", claimableAfterUnixTimestamp = "100")))
        val ui = requireNotNull(out.sheet.claim)
        assertEquals(ClaimPhase.LOCKED, ui.phase)
        assertEquals(goldForgeClaimLockDate(100L), ui.lock?.date)
        assertNotEquals("1970-01-01T00:01:40Z", ui.lock?.date)
        assertNotEquals(islandShareTime("1970-01-01T00:01:40Z"), ui.lock?.date)
        assertFalse(ui.lock!!.date.contains("1970")); assertFalse(ui.lock!!.date.contains(":"))
        assertNull(ui.lock?.reason); assertFalse(ui.actionsAllowed); assertNull(ui.seal)
        assertNull(ui.closedReason)
    }

    // claim-locked.png writes the opening day as "Wed 14 Oct" in the player's own zone: a late-UTC unlock is already
    // the next day further east, and the year or a clock time never shows.
    @Test fun `lock date reads like the frame in the player zone`() {
        assertEquals("Wed 14 Oct", goldForgeClaimLockDate(1_791_979_200L, ZoneOffset.UTC, Locale.ENGLISH))
        assertEquals("Tue 13 Oct", goldForgeClaimLockDate(1_791_934_200L, ZoneOffset.UTC, Locale.ENGLISH))
        assertEquals("Wed 14 Oct", goldForgeClaimLockDate(1_791_934_200L, ZoneOffset.ofHours(2), Locale.ENGLISH))
        val out = map(claimData().copy(claimStatus = status().copy(state = "delayed", preparationAllowed = false,
            chainUnixTimestamp = "50", claimableAfterUnixTimestamp = "1791979200")))
        assertEquals(goldForgeClaimLockDate(1_791_979_200L), out.sheet.claim?.lock?.date)
        assertEquals(CommandState.LOCKED, claimPrimaryLook(requireNotNull(out.sheet.claim)).state)
    }

    // SPEC §1 hero: "next coins in 6h 20m" counts from the server's own clock to 00:00 UTC after the server's mining
    // day. A device clock would make two phones disagree; an unadmitted view must read "…", never a guess.
    @Test fun `next coins time comes from the admitted server view only`() {
        val view = contribution().view!!.copy(day = "2026-10-05", serverNow = "2026-10-05T17:40:00.000Z")
        val built = data().copy(building = Building("forge", "goldforge", 3, 1, 2), buildingCurrent = true,
            contribution = contribution().copy(view = view), contributionCurrent = true)
        val hero = map(built).sheet.heroStatus
        assertEquals(HeroStatusKind.FORGING, hero.kind); assertEquals("6h 20m", hero.time)
        assertEquals("6h 20m", heroStatusLine(hero).emphasis)
        listOf(built.copy(contributionCurrent = false), built.copy(contribution = null),
            built.copy(contribution = contribution().copy(view = view.copy(baseId = "00000000-0000-4000-8000-000000000009"))),
            built.copy(contribution = contribution().copy(view = view.copy(serverNow = "2026-10-06T01:00:00.000Z")))).forEach {
            val unknown = map(it).sheet.heroStatus
            assertEquals(HeroStatusKind.FORGING, unknown.kind); assertNull(unknown.time)
            assertEquals("…", heroStatusLine(unknown).emphasis)
        }
        assertEquals("30s", goldForgeNextCoinsIn("2026-10-05", "2026-10-05T23:59:30.000Z"))
        assertEquals("1d", goldForgeNextCoinsIn("2026-10-05", "2026-10-05T00:00:00.000Z"))
        assertNull(goldForgeNextCoinsIn("5 Oct", "2026-10-05T17:40:00.000Z"))
        assertNull(goldForgeNextCoinsIn("2026-10-05", "later"))
    }

    // error.png: a finished read pass that lost the server says "Reconnecting to the forge…" on the hero; a pass that is
    // still reading keeps the building's status, so a routine refresh never flashes an error.
    @Test fun `hero reconnects after a failed read and not while reading`() {
        val built = data().copy(building = Building("forge", "goldforge", 3, 1, 2), buildingCurrent = true)
        assertEquals(HeroStatusKind.FORGING, map(built).sheet.heroStatus.kind)
        listOf("GEMS", "buy", "WALLET", "LEGACY", "SMELT", "CLAIM").forEach { read ->
            val failed = built.copy(failures = mapOf(read to "The forge could not refresh. Try again."))
            assertEquals(read, HeroStatusKind.RECONNECTING, map(failed).sheet.heroStatus.kind)
            assertEquals(read, HeroStatusKind.FORGING, map(failed.copy(loading = true)).sheet.heroStatus.kind)
        }
    }

    // claim.png keeps the ready face, but collecting cannot start from this sheet: the CLAIM says so plainly, keeps the
    // server amount on its face, and never becomes an action or a Seal.
    @Test fun `ready claim carries the closed reason with the server amount`() {
        val ui = requireNotNull(map(claimData()).sheet.claim)
        assertEquals(ClaimPhase.READY, ui.phase); assertEquals(GOLD_FORGE_CLAIM_CLOSED, ui.closedReason)
        val look = claimPrimaryLook(ui)
        assertEquals("9007199254740.993 KEEP to your wallet", look.sub)
        assertEquals(ForgeAction.EXPLAIN_LOCK, look.action); assertNotEquals(ForgeAction.CLAIM, look.action)
        assertFalse(ui.actionsAllowed); assertNull(ui.seal); assertEquals(MoneyStage.READY, ui.stage)
    }

    // SPEC §4d: an empty tray says when the next coins come; it is not "not open yet", because nothing is waiting.
    @Test fun `collected tray reads the next coins time and is not called closed`() {
        val view = contribution().view!!.copy(day = "2026-10-05", serverNow = "2026-10-05T17:40:00.000Z")
        val ui = requireNotNull(map(claimData().copy(contribution = contribution().copy(view = view), contributionCurrent = true,
            claimStatus = status().copy(state = "claimed", claimedBaseUnits = "9007199254740993", claimableBaseUnits = "0",
                preparationAllowed = false))).sheet.claim)
        assertEquals(ClaimPhase.COLLECTED, ui.phase); assertEquals("6h 20m", ui.nextCoinsIn); assertNull(ui.closedReason)
        val look = claimPrimaryLook(ui)
        assertEquals(ForgeAction.NONE, look.action); assertEquals("Next coins in 6h 20m", look.reason)
    }

    @Test fun `paused and unavailable status do not become zero or collected`() {
        val paused = map(claimData().copy(claimStatus = status().copy(state = "paused", preparationAllowed = false)))
        assertNull(paused.sheet.claim); assertTrue(paused.notices.getValue("CLAIM").contains("paused", ignoreCase = true))
        val unavailable = status().copy(state = "unavailable", reason = "SOURCE_UNAVAILABLE", rootSequence = null,
            cumulativeKeepBaseUnits = null, claimedBaseUnits = null, claimableBaseUnits = null, observedSlot = null,
            chainUnixTimestamp = null, claimableAfterUnixTimestamp = null, needsAta = null, needsMinerRecords = null,
            preparationAllowed = false)
        val out = map(claimData().copy(claimStatus = unavailable))
        assertNull(out.sheet.claim); assertTrue(out.notices.getValue("CLAIM").isNotBlank())
    }

    @Test fun `claimed status shows collected observation without a success event`() {
        val ui = requireNotNull(map(claimData().copy(claimStatus = status().copy(state = "claimed",
            claimedBaseUnits = "9007199254740993", claimableBaseUnits = "0", preparationAllowed = false))).sheet.claim)
        assertEquals(ClaimPhase.COLLECTED, ui.phase); assertEquals("0", ui.ready)
        assertEquals(MoneyStage.READY, ui.stage); assertNull(ui.seal); assertFalse(ui.actionsAllowed)
    }

    @Test fun `read failures replace current bodies and clear related badges`() {
        val out = map(claimData().copy(failures = mapOf("claims" to "Status read failed")))
        assertEquals(ClaimPhase.ERROR, out.sheet.claim?.phase)
        assertEquals("…", out.sheet.claim?.ready)
        assertNull(out.sheet.tabs.single { it.id == "CLAIM" }.badge)
        assertTrue(out.notices.getValue("CLAIM").contains("Status read failed"))
    }

    @Test fun `loading is transient and distinct from unavailable`() {
        assertTrue(map(data().copy(loading = true)).notices.values.all { it.startsWith("Checking") })
        assertTrue(map().notices.values.none { it.startsWith("Checking") })
    }

    @Test fun `current smelt uses accepted read projection with no basket command`() {
        val out = map(data().copy(contribution = contribution(), contributionCurrent = true))
        val ui = requireNotNull(out.sheet.smelt)
        assertEquals("9007199254740993", ui.committed); assertEquals("100000", ui.cap)
        assertTrue(ui.tiles.all { !it.canAdd && it.chosen == 0 })
        assertEquals(CommandState.DISABLED, ui.primary.state)
        assertTrue(ui.primary.reason.orEmpty().contains("read-only"))
        assertNull(ui.seal); assertNull(ui.result); assertNull(ui.held)
    }

    @Test fun `smelt rejects different base or wallet and busy or failed reads`() {
        val s = contribution()
        listOf(s.copy(view = s.view!!.copy(baseId = "another")), s.copy(view = s.view!!.copy(wallet = other)),
            s.copy(journal = s.journal.copy(identity = miningIdentity.copy(wallet = other))), s.copy(busy = true)).forEach {
            assertNull(map(data().copy(contribution = it, contributionCurrent = true)).sheet.smelt)
        }
        assertNull(map(data().copy(contribution = s, contributionCurrent = true,
            failures = mapOf("contribution" to "Read failed"))).sheet.smelt)
    }

    @Test fun `saved smelt is a neutral original receipt notice never fake HELD`() {
        val s = contribution(); val v = s.view!!.copy(pool = "deed", dailyCapValue = null, remainingValue = null)
        val command = MiningContributionCommand.review(miningIdentity, v,
            "00000000-0000-4000-8000-000000000002", listOf(MiningContributionLine(v.resources.first().resourceId, "1")))
        val saved = s.copy(view = v, journal = s.journal.copy(operation = MiningContributionOperation(command, null, null, null)))
        val out = map(data().copy(contribution = saved, contributionCurrent = true))
        assertNull(out.sheet.smelt); assertTrue(out.notices.getValue("SMELT").contains("saved", ignoreCase = true))
        assertFalse(out.notices.getValue("SMELT").contains("held", ignoreCase = true))
    }

    @Test fun `Gems preview uses server minimum or explicit bounded amount and exact wallet`() {
        val minimum = requireNotNull(map(buyData()).sheet.gems)
        assertEquals("3", minimum.pay); assertEquals("3", minimum.amount)
        val ui = requireNotNull(map(buyData(), keep = 7).sheet.gems)
        assertEquals("7", ui.pay); assertEquals("16.5", ui.walletAfter)
        assertFalse(ui.actionsAllowed); assertFalse(ui.pendingRecovery); assertFalse(ui.toShardsAvailable)
        assertFalse(ui.swapOffered); assertTrue(ui.quick.isEmpty()); assertNull(ui.seal)
        assertEquals(ForgeAction.NONE, gemsPrimaryLook(ui)?.action)
    }

    @Test fun `Gems rejects bounds unknown wallet ambiguous symbols and arithmetic overflow`() {
        assertNull(map(buyData(), keep = 2).sheet.gems); assertNull(map(buyData(), keep = 92).sheet.gems)
        listOf(null, "-1", "1e9", "NaN").forEach {
            assertNull(map(buyData().copy(walletFunds = funds(it))).sheet.gems)
        }
        assertNull(map(buyData().copy(walletCurrent = false)).sheet.gems)
        assertNull(map(buyData().copy(walletFunds = WalletFunds(null, mapOf("keep" to "2", "KEEP" to "7"), 0))).sheet.gems)
        val largeRate = buy().capability!!.copy(gemsPerKeep = (1L shl 53) - 1, maxConvertKeepPerTx = 4096)
        assertNull(map(buyData().copy(buy = buy().copy(capability = largeRate)), keep = 2048).sheet.gems)
    }

    @Test fun `short wallet stays exact and read only`() {
        val ui = requireNotNull(map(buyData().copy(walletFunds = funds("6.9")), keep = 7).sheet.gems)
        assertTrue(ui.walletShort); assertEquals("6.9", ui.walletKeep); assertEquals("…", ui.walletAfter)
        assertEquals(CommandState.DISABLED, gemsPrimaryLook(ui)?.state); assertFalse(ui.actionsAllowed)
    }

    @Test fun `saved Gems stays neutral even after wallet attempt and lost capability`() {
        val saved = SavedGemsBuy(GemsBuyDraft(wallet, miningIdentity.origin, miningIdentity.cluster, "saved-key-123", 7), attempted = true)
        val out = map(data().copy(buy = GemsBuyState(saved = saved), buyCurrent = true))
        assertNull(out.sheet.gems)
        assertEquals("1", out.sheet.tabs.single { it.id == "GEMS" }.badge?.text)
        val notice = out.notices.getValue("GEMS")
        assertTrue(notice.contains("saved", ignoreCase = true)); assertFalse(notice.contains("approve", ignoreCase = true))
        assertFalse(notice.contains("waiting for your wallet", ignoreCase = true))
        assertTrue(out.sheet.stack.all { it.gain == null })
        val wrong = map(data().copy(buy = GemsBuyState(saved = saved.copy(draft = saved.draft.copy(wallet = other))), buyCurrent = true))
        assertNull(wrong.sheet.tabs.single { it.id == "GEMS" }.badge)
    }

    @Test fun `capability lost or failed wallet refresh cannot reuse a purchase preview`() {
        assertNull(map(buyData().copy(buy = buy().copy(available = false))).sheet.gems)
        assertNull(map(buyData().copy(buyCurrent = false)).sheet.gems)
        val out = map(buyData().copy(failures = mapOf("wallet" to "Balance read failed")))
        assertNull(out.sheet.gems); assertEquals("…", out.sheet.stack.last().value)
    }

    @Test fun `failed Gems balance read preserves independently current wallet purchase preview`() {
        val out = map(buyData().copy(gems = gems(), gemsCurrent = true,
            failures = mapOf("GEMS" to "Gems balance read failed")), keep = 7)
        assertEquals("…", out.sheet.stack.first().value)
        assertEquals("23.5", out.sheet.stack.last().value)
        val preview = requireNotNull(out.sheet.gems)
        assertEquals("7", preview.pay); assertEquals("16.5", preview.walletAfter)
        assertFalse(preview.actionsAllowed); assertNull(preview.seal)
        assertEquals(ForgeAction.NONE, gemsPrimaryLook(preview)?.action)
    }

    @Test fun `failed wallet purchase read preserves independently current Gems balance`() {
        val out = map(buyData().copy(gems = gems(), gemsCurrent = true,
            failures = mapOf("buy" to "Wallet purchase read failed")))
        assertEquals("73", out.sheet.stack.first().value)
        assertEquals("23.5", out.sheet.stack.last().value)
        assertNull(out.sheet.gems)
        assertEquals("Wallet purchase read failed", out.notices.getValue("GEMS"))
        assertNull(out.sheet.tabs.single { it.id == "GEMS" }.badge)
    }

    @Test fun `explicit current normal capability observation shows Gems off without an action`() {
        val out = map(data().copy(buy = GemsBuyState(), buyCurrent = true, buyCapabilityObserved = true))
        val ui = requireNotNull(out.sheet.gems)
        assertEquals(GemsPhase.OFF, ui.phase)
        assertEquals("Wallet Gems purchases are unavailable on this server.", ui.offReason)
        assertEquals(ui.offReason, out.notices.getValue("GEMS"))
        assertNull(gemsPrimaryLook(ui)); assertNull(ui.seal); assertFalse(ui.actionsAllowed)
        assertFalse(ui.pendingRecovery); assertFalse(ui.toShardsAvailable); assertFalse(ui.swapOffered)
        assertEquals(listOf("…", "…", "…"), listOf(ui.rate, ui.amount, ui.pay))
        assertEquals(listOf("…", "…"), out.sheet.stack.map { it.value })
        assertTrue(out.sheet.tabs.all { it.badge == null })
    }

    @Test fun `unobserved stale busy or retained capability state never becomes Gems off`() {
        val observed = data().copy(buy = GemsBuyState(), buyCurrent = true, buyCapabilityObserved = true)
        listOf(observed.copy(buyCapabilityObserved = false), observed.copy(buyCurrent = false),
            observed.copy(buy = null), observed.copy(buy = GemsBuyState(busy = true)),
            observed.copy(buy = buy().copy(available = false)),
            observed.copy(buy = GemsBuyState(available = true))).forEach {
            assertNull(map(it).sheet.gems)
        }
        assertNull(goldForgeHomeUi(observed, identity.copy(baseSelectionGeneration = 4)).sheet.gems)
    }

    @Test fun `capability read failures remain retryable even with an old off witness`() {
        for (failure in listOf("Network read failed. Try again.", "API read failed. Try again.",
            "Capability request timed out. Try again.", "A wallet purchase is already in progress.")) {
            val out = map(data().copy(buy = GemsBuyState(), buyCurrent = true, buyCapabilityObserved = true,
                failures = mapOf("buy" to failure)))
            assertNull(out.sheet.gems)
            assertEquals(failure, out.notices.getValue("GEMS"))
        }
    }

    @Test fun `saved Gems recovery is not classified off after a capability observation`() {
        val saved = SavedGemsBuy(GemsBuyDraft(wallet, miningIdentity.origin, miningIdentity.cluster, "saved-key-123", 7), attempted = true)
        val out = map(data().copy(buy = GemsBuyState(saved = saved), buyCurrent = true, buyCapabilityObserved = true))
        assertNull(out.sheet.gems)
        assertEquals("1", out.sheet.tabs.single { it.id == "GEMS" }.badge?.text)
        assertTrue(out.notices.getValue("GEMS").contains("saved", ignoreCase = true))
        assertFalse(out.notices.getValue("GEMS").contains("approve", ignoreCase = true))
    }

    @Test fun `no allocation is a neutral empty tray notice without ready or collected claims`() {
        val noAllocation = status().copy(state = "no_allocation", cumulativeKeepBaseUnits = null,
            claimedBaseUnits = null, claimableBaseUnits = "0", claimableAfterUnixTimestamp = null,
            needsAta = null, needsMinerRecords = null, preparationAllowed = false)
        val out = map(claimData().copy(claimStatus = noAllocation))
        assertNull(out.sheet.claim)
        assertEquals("The tray is empty. No KEEP is ready to collect.", out.notices.getValue("CLAIM"))
        assertNull(out.sheet.tabs.single { it.id == "CLAIM" }.badge)
        assertEquals("SMELT", out.sheet.selectedTab)
    }

    @Test fun `current first read waits truthfully without admitting retained balances`() {
        val out = map(data().copy(loading = true, gems = gems(), buy = buy(), walletFunds = funds(),
            claimStatus = status(), claimPolicy = policy))
        assertTrue(out.notices.values.all { it == "Checking the forge…" })
        assertEquals(listOf("…", "…"), out.sheet.stack.map { it.value })
        assertNull(out.sheet.smelt); assertNull(out.sheet.claim); assertNull(out.sheet.gems)
        assertTrue(out.sheet.tabs.all { it.badge == null })
    }

    @Test fun `initial loading cannot describe a retired identity as the current forge`() {
        for (current in listOf(null, identity.copy(baseSelectionGeneration = 4))) {
            val out = goldForgeHomeUi(data().copy(loading = true), current)
            assertTrue(out.notices.values.all { it == "Open the Gold Forge for the current kingdom." })
            assertEquals(listOf("…", "…"), out.sheet.stack.map { it.value })
        }
    }
}
