package gg.pixelkingdomwars.nativeclient.ui.sheets.account.live

import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ui.KeepConfirmPreference
import gg.pixelkingdomwars.nativeclient.ui.KeepSpendConfirmState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterUiState
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** BUILD › SUPPLIES KEEP buys (account SPEC §3): every KEEP item buy is consented on the kit Seal with the EXISTING
 * KeepSpendConfirm wording and the server price, CONFIRM re-checks the offer so a stale view never spends, and a host
 * that passes no preference always asks. */
class SuppliesKeepConsentTest {
    private val wallet = "wallet-a"
    private val baseId = "11111111-1111-4111-8111-111111111111"
    private fun json(value: String) = Json.parseToJsonElement(value).jsonObject
    private fun home() = BaseSnapshot.from(json("""{
        "baseId":"$baseId","player":{"wallet":"$wallet","keepLevel":6,"builders":2},
        "freeBuilders":1,"energy":{"used":2,"free":3,"max":7},"warzone":{"active":false}
    }"""))
    private val catalogue = json("""{"constants":{
        "SHIELD":{"extendCostSolLamports":"123456789","extendHours":17},
        "CAPS":{"buildersMax":4,"builderPricesSol":["0.01","0.123456789","0.4"]},
        "RAID_ENERGY":{"solLamportsPerEnergy":"1234567","packLamports":"45678901","packSize":6}
    }}""")
    private val item = ItemDefinition("keg_of_haste", "Keg of haste", "consumable", costKeep = "63",
        desc = "Server effect", asset = "itm_keg", acquisition = ItemAcquisition("shop"))
    private val offerId = "item:keg_of_haste"
    private fun state(items: List<ItemDefinition> = listOf(item), keep: String = "100000") = RosterUiState(
        home = BaseState(base = home(), balances = Balances("100", keep)),
        domain = ArmyDomainState(inventory = Inventory(catalog = items)), catalogue = catalogue)
    private fun project(s: RosterUiState = state(), current: Boolean = true, busy: Boolean = false) =
        projectSupplies(s, wallet, baseId, current = current, busy = busy, refreshed = true, selectedId = null, tabs = emptyList())
    private class Memory(var asks: Boolean) : KeepConfirmPreference {
        var writes = 0
        override fun on() = asks
        override fun set(on: Boolean) { asks = on; writes++ }
    }
    private fun source(path: String): String {
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path"
        return listOf(File(relative), File("app/$relative")).first { it.isFile }.readText()
    }

    @Test fun `the KEEP Seal carries only the existing KeepSpendConfirm wording and the server price`() {
        val p = project()
        val buy = requireNotNull(suppliesKeepBuy(p, p, offerId))
        assertEquals("63", buy.costKeep)
        assertEquals("The consent quotes exactly what the BUY button said", "BUY KEG OF HASTE", buy.what)
        val intent = suppliesKeepIntent(buy) {}
        assertFalse("A purchase hurries nothing, so it is never IMMEDIATELY", intent.immediate)
        assertFalse("The player's KEEP-confirm preference still applies", intent.alwaysReview)
        val seal = suppliesKeepConsentUi(intent, armedAtMs = 7L)
        assertEquals("SPEND KEEP?", seal.title)
        assertEquals(listOf("SPEND 63 KEEP TO BUY KEG OF HASTE?", "KEEP IS THE HARD CURRENCY — NOT SHARDS."), seal.lines)
        assertEquals("CONFIRM · 63", seal.confirmLabel)
        assertEquals(PriceUi(Currency.KEEP, "63", PriceStatus.OK), seal.price)
        assertNull("Nothing is promised in return beyond the quoted offer", seal.gets)
        assertEquals(7L, seal.armedAtMs)
        // No invented consent copy on a money action: every phrase above is the existing KEEP-spend dialog's own.
        val existing = source("ui/KeepSpendConfirm.kt")
        for (phrase in listOf("\"SPEND KEEP?\"", "SPEND \$amount KEEP TO \${intent.what}", "\"KEEP IS THE HARD CURRENCY — NOT SHARDS.\"",
            "CONFIRM · \$amount")) assertTrue(phrase, existing.contains(phrase))
    }

    @Test fun `a large server price is grouped exactly as the KEEP dialog groups it`() {
        val p = project(state(listOf(item.copy(costKeep = "12500"))))
        val seal = suppliesKeepConsentUi(suppliesKeepIntent(requireNotNull(suppliesKeepBuy(p, p, offerId))) {}, 0L)
        assertEquals("12,500", seal.price.amount)
        assertEquals("CONFIRM · 12,500", seal.confirmLabel)
        assertEquals("SPEND 12,500 KEEP TO BUY KEG OF HASTE?", seal.lines.first())
    }

    @Test fun `SOL offers and rows that changed since they were drawn never become a KEEP consent`() {
        val p = project()
        assertNull("SOL supplies keep their own wallet owner", suppliesKeepBuy(p, p, "base:shield"))
        assertNull(suppliesKeepBuy(p, project(state(listOf(item.copy(costKeep = "64")))), offerId))
        assertNull(suppliesKeepBuy(p, project(busy = true), offerId))
        val short = project(state(keep = "62"))
        assertNull("A SHORT price opens Need-more, never the Seal", suppliesKeepBuy(short, short, offerId))
    }

    @Test fun `a changed projection between consent and confirm buys nothing`() {
        val displayed = project()
        val buy = requireNotNull(suppliesKeepBuy(displayed, displayed, offerId))
        assertEquals(SupplyTarget.Item(item.id), suppliesKeepConfirmed(buy, project()))
        for (changed in listOf(project(state(listOf(item.copy(costKeep = "64")))), project(state(emptyList())),
            project(current = false), project(busy = true), project(state(keep = "1"))))
            assertNull("A stale offer must never be spent on", suppliesKeepConfirmed(buy, changed))
        // The same rule through the KEEP guard the body uses: the price moves while the Seal is open, CONFIRM spends nothing.
        val bought = mutableListOf<String>()
        var now = displayed
        val guard = KeepSpendConfirmState(suppliesKeepPreference(null))
        guard.confirm(suppliesKeepIntent(buy) { suppliesKeepConfirmed(buy, now)?.let { bought += it.itemId } })
        now = project(state(listOf(item.copy(costKeep = "64"))))
        guard.accept()
        assertTrue(bought.isEmpty())
        guard.confirm(suppliesKeepIntent(buy) { suppliesKeepConfirmed(buy, now)?.let { bought += it.itemId } })
        now = displayed
        guard.accept()
        assertEquals("The unchanged offer is bought once", listOf(item.id), bought)
    }

    @Test fun `a host that passes no preference always asks and never stores an opt-out`() {
        val guard = KeepSpendConfirmState(suppliesKeepPreference(null))
        var spent = 0
        guard.confirm(suppliesKeepIntent(requireNotNull(suppliesKeepBuy(project(), project(), offerId))) { spent++ })
        assertNotNull("The Seal is up and nothing was posted", guard.pending); assertEquals(0, spent)
        guard.cancel(); assertEquals("BACK posts nothing", 0, spent)
        guard.confirm(suppliesKeepIntent(requireNotNull(suppliesKeepBuy(project(), project(), offerId))) { spent++ })
        guard.optOut = true; guard.accept(); assertEquals(1, spent)
        guard.confirm(suppliesKeepIntent(requireNotNull(suppliesKeepBuy(project(), project(), offerId))) { spent++ })
        assertNotNull("Fail safe: with no stored preference the next buy still asks", guard.pending); assertEquals(1, spent)
    }

    @Test fun `a passed preference is the player's own and its opt-out keeps the old tap-to-buy`() {
        val asks = Memory(asks = true)
        assertSame(asks, suppliesKeepPreference(asks))
        val optedOut = Memory(asks = false)
        val guard = KeepSpendConfirmState(suppliesKeepPreference(optedOut))
        var spent = 0
        guard.confirm(suppliesKeepIntent(requireNotNull(suppliesKeepBuy(project(), project(), offerId))) { spent++ })
        assertNull("A player who opted out buys at once, as before the Seal", guard.pending)
        assertEquals(1, spent)
        assertEquals(0, optedOut.writes)
    }
}
