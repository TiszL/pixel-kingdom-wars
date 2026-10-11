package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.GemsBuyDraft
import gg.pixelkingdomwars.nativeclient.data.GemsBuyState
import gg.pixelkingdomwars.nativeclient.data.GemsState
import gg.pixelkingdomwars.nativeclient.data.MiningClaimsState
import gg.pixelkingdomwars.nativeclient.data.SavedGemsBuy
import gg.pixelkingdomwars.nativeclient.mining.MiningClaimFeature
import gg.pixelkingdomwars.nativeclient.mining.MiningClaimFeatures
import gg.pixelkingdomwars.nativeclient.mining.MiningClaimStatusView
import gg.pixelkingdomwars.nativeclient.model.BalanceFeatures
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.GemsBuyDeposit
import gg.pixelkingdomwars.nativeclient.model.GemsBuyFunding
import gg.pixelkingdomwars.nativeclient.model.GemsBuyIntent
import gg.pixelkingdomwars.nativeclient.model.GemsBuyReceipt
import gg.pixelkingdomwars.nativeclient.model.GemsBuyResult
import gg.pixelkingdomwars.nativeclient.model.GemsFeature
import gg.pixelkingdomwars.nativeclient.model.GemsOverview
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GoldForgeTabs
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.HeroStatusKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Source-only regression contract. The shell must not replace the existing money review/recovery bodies. */
class GoldForgeMoneyMapperTest {
    @Test fun `unobserved shell shows unknown balances and keeps every money body bridged`() {
        val ui = goldForgeMoneySheetUi()
        assertEquals("…", ui.level)
        assertEquals(HeroStatusKind.RECONNECTING, ui.heroStatus.kind)
        assertFalse(ui.sceneWorking)
        assertEquals(listOf(GoldForgeTabs.SMELT, GoldForgeTabs.CLAIM, GoldForgeTabs.GEMS), ui.tabs.map { it.id })
        assertEquals(GoldForgeTabs.SMELT, ui.selectedTab)
        assertEquals(listOf("gem", "keep"), ui.stack.map { it.icon })
        assertEquals(listOf("…", "…"), ui.stack.map { it.value })
        assertTrue(ui.tabs.all { it.badge == null })
        assertNull(ui.smelt)
        assertNull(ui.claim)
        assertNull(ui.gems)
        assertNull(ui.legacy)
        assertFalse(ui.history)
    }

    @Test fun `retained snapshots alone never establish a current balance or claim badge`() {
        val ui = goldForgeMoneySheetUi(building = forge(), gems = gems(), claims = readyClaims(), walletFunds = funds("4321"))
        assertEquals("…", ui.level)
        assertEquals(listOf("…", "…"), ui.stack.map { it.value })
        assertFalse(ui.sceneWorking)
        assertNull(ui.tabs.single { it.id == GoldForgeTabs.CLAIM }.badge)
        assertEquals(GoldForgeTabs.SMELT, ui.selectedTab)
    }

    @Test fun `wallet KEEP never comes from custodial KEEP or missing RPC data`() {
        val ledger = GemsState(supported = true, enabled = true, balances = Balances("12", "999999999", gems = "456"))
        listOf(null, WalletFunds(null, emptyMap(), 1), WalletFunds(null, mapOf("KEEP" to null), 1)).forEach { wallet ->
            val ui = goldForgeMoneySheetUi(gems = ledger, gemsCurrent = true, walletFunds = wallet, walletCurrent = true)
            assertEquals("…", ui.stack.last().value)
            assertEquals("Wallet KEEP …", ui.stack.last().exactDescription)
        }
    }

    @Test fun `observed amounts keep every decimal in accessibility and show actual zero`() {
        val ui = goldForgeMoneySheetUi(gems = gems("0"), gemsCurrent = true,
            walletFunds = funds("9007199254740993.123456789"), walletCurrent = true)
        assertEquals("0", ui.stack.first().value)
        assertEquals("Gems 0", ui.stack.first().exactDescription)
        assertEquals("Wallet KEEP 9,007,199,254,740,993.123456789", ui.stack.last().exactDescription)
        assertTrue(ui.stack.all { !it.plus && it.gain == null && it.fill == null })
    }

    @Test fun `wallet token lookup accepts one KEEP symbol and refuses ambiguous case variants`() {
        val lower = goldForgeMoneySheetUi(walletFunds = WalletFunds(null, mapOf("keep" to "12.5"), 1), walletCurrent = true)
        assertEquals("12.5", lower.stack.last().value)
        val ambiguous = goldForgeMoneySheetUi(walletFunds = WalletFunds(null, mapOf("KEEP" to "12", "keep" to "99"), 1), walletCurrent = true)
        assertEquals("…", ambiguous.stack.last().value)
    }

    @Test fun `invalid or negative wallet amounts remain unknown`() {
        listOf("-1", "NaN", "1e6", "1,234", "").forEach { amount ->
            val ui = goldForgeMoneySheetUi(walletFunds = funds(amount), walletCurrent = true)
            assertEquals(amount, "…", ui.stack.last().value)
        }
    }

    @Test fun `Gems display uses the current overview and hides failed or refreshing reads`() {
        val current = gems("73").copy(balances = Balances("1", "900", gems = "999"))
        assertEquals("73", goldForgeMoneySheetUi(gems = current, gemsCurrent = true).stack.first().value)
        listOf(current.copy(busy = true), current.copy(unavailable = "Refresh the original account"),
            current.copy(supported = false), current.copy(overview = null)).forEach { state ->
            assertEquals("…", goldForgeMoneySheetUi(gems = state, gemsCurrent = true).stack.first().value)
        }
    }

    @Test fun `only current ready positive claim status earns the claim badge and default tab`() {
        val ui = goldForgeMoneySheetUi(claims = readyClaims(), claimsCurrent = true)
        assertEquals("!", ui.tabs.single { it.id == GoldForgeTabs.CLAIM }.badge?.text)
        assertEquals(GoldForgeTabs.CLAIM, ui.selectedTab)
        val ready = readyClaims()
        listOf(ready.copy(loaded = false), ready.copy(busy = true), ready.copy(error = "Status read failed"),
            ready.copy(status = null), ready.copy(status = ready.status!!.copy(preparationAllowed = false)),
            ready.copy(status = ready.status!!.copy(claimableBaseUnits = "0")),
            ready.copy(status = ready.status!!.copy(claimableBaseUnits = null)),
            ready.copy(status = ready.status!!.copy(claimableBaseUnits = "-1")),
            ready.copy(status = ready.status!!.copy(state = "delayed"))).forEach { state ->
            val blocked = goldForgeMoneySheetUi(claims = state, claimsCurrent = true)
            assertNull(blocked.tabs.single { it.id == GoldForgeTabs.CLAIM }.badge)
            assertEquals(GoldForgeTabs.SMELT, blocked.selectedTab)
        }
    }

    @Test fun `saved purchase remains visible after discovery disappears and never creates a Seal`() {
        val saved = SavedGemsBuy(GemsBuyDraft("test-wallet", "https://example.invalid", "devnet", "original-purchase", 12))
        val ui = goldForgeMoneySheetUi(buy = GemsBuyState(saved = saved, available = false, fresh = false))
        assertEquals("1", ui.tabs.single { it.id == GoldForgeTabs.GEMS }.badge?.text)
        assertNull(ui.smelt)
        assertNull(ui.claim)
        assertNull(ui.gems)
        assertTrue(ui.stack.all { it.gain == null })
    }

    @Test fun `selected tab wins then requested tab then the current claim fallback`() {
        assertEquals(GoldForgeTabs.GEMS, goldForgeMoneySheetUi(selectedTab = "gems", requestedTab = "claim",
            claims = readyClaims(), claimsCurrent = true).selectedTab)
        assertEquals(GoldForgeTabs.CLAIM, goldForgeMoneySheetUi(selectedTab = "missing", requestedTab = "claim").selectedTab)
        assertEquals(GoldForgeTabs.CLAIM, goldForgeMoneySheetUi(requestedTab = "legacy", claims = readyClaims(), claimsCurrent = true).selectedTab)
        assertEquals(GoldForgeTabs.SMELT, goldForgeMoneySheetUi(requestedTab = "missing").selectedTab)
    }

    @Test fun `built current Gold Forge has its server level and owner supplied countdown`() {
        val ui = goldForgeMoneySheetUi(building = forge(), buildingCurrent = true, nextCoinsIn = "6h 20m")
        assertEquals("LV 3", ui.level)
        assertTrue(ui.sceneWorking)
        assertEquals(HeroStatusKind.FORGING, ui.heroStatus.kind)
        assertEquals("6h 20m", ui.heroStatus.time)
    }

    @Test fun `construction stops the scene and never invents a completion time`() {
        val ui = goldForgeMoneySheetUi(building = forge().copy(underConstruction = true), buildingCurrent = true, nextCoinsIn = "6h 20m")
        assertFalse(ui.sceneWorking)
        assertEquals(HeroStatusKind.UNDER_CONSTRUCTION, ui.heroStatus.kind)
        assertNull(ui.heroStatus.time)
        val timed = goldForgeMoneySheetUi(building = forge().copy(underConstruction = true), buildingCurrent = true, constructionRemaining = "1h 12m")
        assertEquals("1h 12m", timed.heroStatus.time)
    }

    @Test fun `missing or wrong building never appears to be a working Gold Forge`() {
        listOf(null, forge().copy(type = "workshop"), forge().copy(level = 0)).forEach { building ->
            val ui = goldForgeMoneySheetUi(building = building, buildingCurrent = true)
            assertFalse(ui.sceneWorking)
            assertFalse(ui.heroStatus.kind == HeroStatusKind.FORGING)
        }
    }

    @Test fun `history appears only with an explicitly bound owner destination`() {
        assertFalse(goldForgeMoneySheetUi().history)
        assertTrue(goldForgeMoneySheetUi(historyAvailable = true).history)
    }

    @Test fun `attempted purchase badge never implies that another wallet approval is needed`() {
        val saved = savedPurchaseForBadge(credited = false)
        listOf(saved.copy(signature = null), saved).forEach { original ->
            val ui = goldForgeMoneySheetUi(buy = GemsBuyState(saved = original, available = false, fresh = false))
            val badge = ui.tabs.single { it.id == GoldForgeTabs.GEMS }.badge
            assertEquals("1", badge?.text)
            assertEquals("A saved Gems purchase needs attention.", badge?.description)
            assertNull(ui.gems)
        }
    }

    @Test fun `credited saved purchase retains a neutral recovery badge before and after hydration`() {
        val saved = savedPurchaseForBadge(credited = true)
        listOf(false, true).forEach { hydrated ->
            val ui = goldForgeMoneySheetUi(buy = GemsBuyState(saved = saved, hydrated = hydrated))
            val badge = ui.tabs.single { it.id == GoldForgeTabs.GEMS }.badge
            assertEquals("1", badge?.text)
            assertEquals("A saved Gems purchase needs attention.", badge?.description)
            assertNull(ui.gems)
            assertTrue(ui.stack.all { it.gain == null })
        }
    }

    private fun savedPurchaseForBadge(credited: Boolean): SavedGemsBuy {
        val wallet = "1".repeat(32)
        val signature = "6".repeat(64)
        val quote = GemsBuyIntent("00000000-0000-4000-8000-000000000012", "gems_buy", wallet,
            "original-purchase", "2".repeat(32), "3".repeat(32), "4".repeat(32), "5".repeat(32),
            9, 12, 12, "2026-10-03T07:30:00Z")
        val receipt = if (credited) GemsBuyReceipt(1, "00000000-0000-4000-8000-000000000013",
            "2026-10-03T07:01:00Z", wallet, quote.id, signature,
            GemsBuyFunding("KEEP", "12", quote.baseUnits.toString()), GemsBuyResult("GEMS", "12", 1)) else null
        val deposit = GemsBuyDeposit(quote, if (credited) "credited" else "pending",
            if (credited) signature else null, signature, receipt?.funding?.baseUnits,
            "2026-10-03T07:00:00Z", if (credited) "2026-10-03T07:01:00Z" else null,
            12, 12, if (credited) "0" else null, receipt?.funding?.amount, receipt?.result?.amount, receipt)
        return SavedGemsBuy(GemsBuyDraft(wallet, "https://example.invalid", "devnet", "original-purchase", 12),
            quote = quote, attempted = true, signature = signature, observed = deposit)
    }

    private fun forge() = Building("forge-1", "goldforge", 3, 1, 2)

    private fun funds(keep: String) = WalletFunds(null, mapOf("KEEP" to keep), 1)

    private fun gems(amount: String = "123") = GemsState(supported = true, enabled = true,
        overview = GemsOverview(BalanceFeatures(GemsFeature(1, 1)), amount, emptyList(), emptyList(),
            minConvertKeep = 1, maxConvertKeepPerTx = 1000, gemsPerKeep = 1, shardsPerGem = 2,
            serverNow = "2026-10-03T07:00:00Z"))

    private fun readyClaims() = MiningClaimsState(loaded = true, status = MiningClaimStatusView(
        features = MiningClaimFeatures(MiningClaimFeature(1, 1)), wallet = "test-wallet", program = "shardkeep-economy",
        programId = null, keepMint = null, state = "ready", reason = null, rootSequence = "1",
        cumulativeKeepBaseUnits = "1230000000", claimedBaseUnits = "0", claimableBaseUnits = "1230000000", decimals = 9,
        observedSlot = 1, chainUnixTimestamp = "1791010800", claimableAfterUnixTimestamp = "1791010800",
        needsAta = false, needsMinerRecords = false, preparationAllowed = true, claimSubmissionAuthorized = false,
        serverNow = "2026-10-03T07:00:00Z"))
}
