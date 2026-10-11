package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.data.EconomyPage
import org.junit.Assert.*
import org.junit.Test

/** Owner rule: "buy your land to unlock this" is a gate, shown gold with BUY LAND — never a red error. */
class EconomyGateTest {
    private val forgePaths = listOf("/balances", "/forge", "/forge/allocations")

    @Test fun `a landless player on the Forge sees one gold gate built from the repository's own refusal`() {
        val errors = mapOf("/forge" to "A Land Deed unlocks new Forge contributions.", "/forge/allocations" to "buy your land to unlock this")
        val notices = economyReadNotices(EconomyPage.FORGE, landOwned = false, paths = forgePaths, errors = errors)
        assertEquals("A Land Deed unlocks new Forge contributions.", notices.gate)
        assertTrue("Gated reads never double as stale-value cautions", notices.stale.isEmpty())
    }

    @Test fun `the gate shows before any gated read answered, and a failed wallet read stays a caution beside it`() {
        val notices = economyReadNotices(EconomyPage.FORGE, landOwned = false, paths = forgePaths, errors = mapOf("/balances" to "Connection interrupted. Retry to update."))
        assertEquals(economyGateCopy(EconomyPage.FORGE), notices.gate)
        assertEquals(listOf("Connection interrupted. Retry to update. $STALE_VALUES_NOTE"), notices.stale)
    }

    @Test fun `a landowner's Forge failure is a stale-value caution, not a land gate`() {
        val notices = economyReadNotices(EconomyPage.FORGE, landOwned = true, paths = forgePaths, errors = mapOf("/forge" to "Gold Forge is currently unavailable."))
        assertNull(notices.gate)
        assertEquals(listOf("Gold Forge is currently unavailable. $STALE_VALUES_NOTE"), notices.stale)
    }

    @Test fun `withdrawals are gated for a landless player while the wallet page never is`() {
        assertTrue(economyLandGate(EconomyPage.WITHDRAWALS, landOwned = false))
        assertFalse(economyLandGate(EconomyPage.WALLET, landOwned = false))
        assertFalse(economyLandGate(EconomyPage.SUPPORT, landOwned = false))
        val wallet = economyReadNotices(EconomyPage.WALLET, landOwned = false, paths = listOf("/balances", "/wallet/balances"), errors = mapOf("/wallet/balances" to "Unavailable on this server."))
        assertNull(wallet.gate); assertEquals(1, wallet.stale.size)
    }

    @Test fun `identical messages from two reads collapse into one caution`() {
        val notices = economyReadNotices(EconomyPage.WALLET, landOwned = true, paths = listOf("/balances", "/wallet/balances"),
            errors = mapOf("/balances" to "Connection interrupted.", "/wallet/balances" to "Connection interrupted."))
        assertEquals(1, notices.stale.size)
    }
}
