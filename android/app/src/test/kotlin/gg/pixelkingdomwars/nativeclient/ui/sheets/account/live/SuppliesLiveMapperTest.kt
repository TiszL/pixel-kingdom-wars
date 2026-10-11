package gg.pixelkingdomwars.nativeclient.ui.sheets.account.live

import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ops.InterruptedIntent
import gg.pixelkingdomwars.nativeclient.ops.ItemBuySpec
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterUiState
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.SupplyKind
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class SuppliesLiveMapperTest {
    private val wallet = "wallet-a"
    private val baseId = "11111111-1111-4111-8111-111111111111"
    private fun json(value: String) = Json.parseToJsonElement(value).jsonObject
    private fun home(warzone: Boolean = false, builders: Int = 2) = BaseSnapshot.from(json("""{
        "baseId":"$baseId","player":{"wallet":"$wallet","keepLevel":6,"builders":$builders},
        "freeBuilders":1,"energy":{"used":2,"free":3,"max":7},"warzone":{"active":$warzone}
    }"""))
    private val catalogue = json("""{"constants":{
        "SHIELD":{"extendCostSolLamports":"123456789","extendHours":17},
        "WARZONE":{"shieldCostSolLamports":"987654321","shieldDurationHours":3,"shieldLiquidityDirectBps":2000},
        "CAPS":{"buildersMax":4,"builderPricesSol":["0.01","0.123456789","0.4"]},
        "RAID_ENERGY":{"solLamportsPerEnergy":"1234567","packLamports":"45678901","packSize":6}
    }}""")
    private val item = ItemDefinition("keg_of_haste", "Keg of haste", "consumable", costKeep = "63",
        desc = "Server effect", asset = "itm_keg", acquisition = ItemAcquisition("shop"))
    private fun state(items: List<ItemDefinition> = listOf(item)) = RosterUiState(
        home = BaseState(base = home(), balances = Balances("100", "1000")),
        domain = ArmyDomainState(inventory = Inventory(catalog = items)), catalogue = catalogue)
    private fun project(s: RosterUiState = state(), current: Boolean = true, busy: Boolean = false,
        refreshed: Boolean = true, selected: String? = null) = projectSupplies(s, wallet, baseId,
        current = current, busy = busy, refreshed = refreshed, selectedId = selected, tabs = emptyList())

    @Test fun `SOL shield duration and price come from catalogue without mock gems tiers`() {
        val p = project()
        val row = p.ui.offers.single { it.kind == SupplyKind.SHIELD }
        assertEquals(Currency.SOL, row.price.currency)
        assertEquals("0.123456789", row.price.amount)
        assertTrue(row.effect.contains("17h"))
        assertEquals(SupplyTarget.BasePurchase("shield", baseId), p.targets[row.id])
        assertFalse(p.ui.offers.any { it.price.currency == Currency.GEMS })
    }

    @Test fun `builder price uses current hired count and max removes purchase`() {
        val p = project()
        assertEquals("0.123456789", p.ui.offers.single { it.kind == SupplyKind.BUILDER }.price.amount)
        val maxed = project(state().let { it.copy(home = it.home.copy(base = home(builders = 4))) })
        // Rewritten for account SPEC §3 "builder at max → MAX tag": the row used to vanish at the cap; it now stays visible,
        // tagged MAX and locked with its reason, while the purchase is still removed (no price, no owner target, no buy).
        val row = maxed.ui.offers.single { it.kind == SupplyKind.BUILDER }
        assertEquals("MAX", row.tag)
        assertNotNull(row.lockedReason)
        assertNull(row.price.amount)
        assertNull(maxed.targets[row.id])
        assertNull(suppliesBuyTarget(maxed, maxed, row.id))
        assertTrue("A reached cap is not a missing price", maxed.ui.catalogueReady)
    }

    @Test fun `the item section reads BOOSTS only when the server lists none`() {
        val empty = project(state(emptyList()))
        assertEquals("BOOSTS", empty.ui.inventorySectionLabel)
        assertTrue("The designed empty row needs a verified, ready shelf", empty.ui.catalogueReady)
        assertTrue(empty.ui.offers.none { it.kind == SupplyKind.BOOST })
        val gear = project(state(listOf(item, item.copy(id = "helm", kind = "gear"))))
        assertEquals("Gear and contracts are not boosts, so a live list keeps the honest label", "ITEMS", gear.ui.inventorySectionLabel)
    }

    @Test fun `item footer sub line quotes the server KEEP price then its effect like the SOL rows`() {
        assertEquals("63 KEEP · Server effect", project().ui.offers.single { it.kind == SupplyKind.BOOST }.buySub)
        assertEquals("63 KEEP", project(state(listOf(item.copy(desc = null)))).ui.offers.single { it.kind == SupplyKind.BOOST }.buySub)
        assertNull("No price, no quoted sub line", project(state(listOf(item.copy(costKeep = null)))).ui.offers.single { it.kind == SupplyKind.BOOST }.buySub)
    }

    @Test fun `both energy SKUs keep server quantities and lamports`() {
        val p = project()
        val rows = p.ui.offers.filter { it.kind == SupplyKind.ENERGY }
        assertEquals(listOf("0.001234567", "0.045678901"), rows.map { it.price.amount })
        assertTrue(rows[0].effect.contains("+1"))
        assertTrue(rows[1].effect.contains("+6"))
        assertEquals(listOf("energy", "energy_pack"), rows.map { (p.targets[it.id] as SupplyTarget.BasePurchase).kind })
        assertEquals(5, p.ui.energyNow)
        assertEquals(7, p.ui.energyMax)
    }

    @Test fun `warzone shield requires current active warzone`() {
        assertFalse(project().targets.values.any { it == SupplyTarget.BasePurchase("warzone_shield", baseId) })
        val s = state().let { it.copy(home = it.home.copy(base = home(warzone = true))) }
        assertTrue(project(s).targets.values.any { it == SupplyTarget.BasePurchase("warzone_shield", baseId) })
    }

    @Test fun `all purchasable inventory kinds remain visible with server KEEP prices`() {
        val gear = item.copy(id = "helm", kind = "gear", costKeep = "91")
        val p = project(state(listOf(item, gear)))
        val rows = p.ui.offers.filter { it.kind == SupplyKind.BOOST }
        assertEquals(listOf("63", "91"), rows.map { it.price.amount })
        assertTrue(rows.all { it.price.currency == Currency.KEEP })
        assertTrue(p.targets.values.containsAll(listOf(SupplyTarget.Item(item.id), SupplyTarget.Item(gear.id))))
    }

    @Test fun `drop only and drop acquisition items never become shop offers`() {
        val p = project(state(listOf(item, item.copy(id = "drop", dropOnly = true),
            item.copy(id = "forge", acquisition = ItemAcquisition("drop")))))
        assertEquals(listOf("item:keg_of_haste"), p.ui.offers.filter { it.kind == SupplyKind.BOOST }.map { it.id })
    }

    @Test fun `absent zero negative decimal huge and malformed KEEP prices cannot buy`() {
        for (price in listOf(null, "0", "-1", "1.5", "01", "x", "9".repeat(33))) {
            val p = project(state(listOf(item.copy(costKeep = price))))
            val row = p.ui.offers.single { it.kind == SupplyKind.BOOST }
            assertEquals(price, PriceStatus.UNAVAILABLE, row.price.status)
            assertNull(price, suppliesBuyTarget(p, p, row.id))
        }
    }

    @Test fun `bad SOL catalogue price is omitted not shown as zero`() {
        val s = state().copy(catalogue = json("""{"constants":{"SHIELD":{"extendCostSolLamports":"0","extendHours":17}}}"""))
        assertFalse(project(s).ui.offers.any { it.kind == SupplyKind.SHIELD })
    }

    @Test fun `max owned item stays visible but cannot buy`() {
        val s = state(listOf(item.copy(maxOwned = 1))).let {
            it.copy(domain = it.domain.copy(inventory = it.domain.inventory!!.copy(owned = listOf(OwnedItem(item.id, "1")))))
        }
        val p = project(s)
        assertNotNull(p.ui.offers.single { it.kind == SupplyKind.BOOST }.lockedReason)
        assertNull(suppliesBuyTarget(p, p, "item:${item.id}"))
    }

    @Test fun `short KEEP uses known base balance and unknown balance never becomes zero`() {
        val s = state()
        val short = project(s.copy(home = s.home.copy(balances = Balances("0", "62"))))
        assertEquals(PriceStatus.SHORT, short.ui.offers.single { it.kind == SupplyKind.BOOST }.price.status)
        assertNull(suppliesBuyTarget(short, short, "item:${item.id}"))
        val unknown = project(s.copy(home = s.home.copy(balances = null)))
        assertNotEquals(PriceStatus.SHORT, unknown.ui.offers.single { it.kind == SupplyKind.BOOST }.price.status)
        assertNull(suppliesBuyTarget(unknown, unknown, "item:${item.id}"))
    }

    @Test fun `missing catalogue inventory or initial refresh cannot report ready empty`() {
        val s = state(emptyList())
        for (p in listOf(project(s.copy(catalogue = null)), project(s.copy(domain = ArmyDomainState())), project(s, refreshed = false))) {
            assertFalse(p.ready)
            assertFalse(p.ui.catalogueReady)
            assertNotNull(p.status)
        }
    }

    @Test fun `read error remains visible and blocks stale purchases`() {
        val s = state()
        val p = project(s.copy(domain = s.domain.copy(error = "Read failed")))
        assertFalse(p.ready)
        assertTrue(p.status!!.contains("Read failed"))
        assertFalse(p.ui.catalogueReady)
        assertNull(suppliesBuyTarget(p, p, "item:${item.id}"))
    }

    @Test fun `view model read failure also blocks cached data without claiming empty ready`() {
        val p = projectSupplies(state(), wallet, baseId, true, false, true, null, emptyList(), readError = "Refresh failed")
        assertFalse(p.ready)
        assertFalse(p.ui.catalogueReady)
        assertEquals("Refresh failed", p.status)
        assertNull(suppliesBuyTarget(project(), p, "item:${item.id}"))
    }

    @Test fun `busy read and retired content block every purchase`() {
        val s = state()
        for (p in listOf(project(busy = true), project(s.copy(home = s.home.copy(loading = true))), project(s.copy(ordersAllowed = false)))) {
            assertNull(suppliesBuyTarget(p, p, "item:${item.id}"))
            assertNull(suppliesBuyTarget(p, p, "base:shield"))
        }
    }

    @Test fun `interrupted item purchase blocks new item purchase and remains projected`() {
        val pending = InterruptedIntent(ItemBuySpec.intent(wallet, baseId, item.id, "key-0000001", "63", "Keg").copy(attempted = true))
        val s = state().copy(interrupted = listOf(pending))
        val p = project(s)
        assertNotNull(p.ui.offers.single { it.kind == SupplyKind.BOOST }.lockedReason)
        assertNull(suppliesBuyTarget(p, p, "item:${item.id}"))
        assertEquals(listOf(pending), s.interrupted)
    }

    @Test fun `changed session wallet or base never exposes admitted offers`() {
        val s = state()
        assertTrue(project(current = false).ui.offers.isEmpty())
        assertTrue(project(s.copy(home = s.home.copy(base = home().copy(baseId = "another-base")))).ui.offers.isEmpty())
        assertTrue(project(s.copy(home = s.home.copy(base = home().copy(player = home().player.copy(wallet = "another-wallet"))))).ui.offers.isEmpty())
    }

    @Test fun `callback revalidation rejects price stock and identity changes`() {
        val displayed = project()
        assertEquals(SupplyTarget.Item(item.id), suppliesBuyTarget(displayed, displayed, "item:${item.id}"))
        assertNull(suppliesBuyTarget(displayed, project(state(listOf(item.copy(costKeep = "64")))), "item:${item.id}"))
        assertNull(suppliesBuyTarget(displayed, project(state(emptyList())), "item:${item.id}"))
        assertNull(suppliesBuyTarget(displayed, project(current = false), "base:shield"))
    }

    @Test fun `selection follows available ids and item base ids cannot collide`() {
        val p = project(state(listOf(item.copy(id = "shield"))), selected = "missing")
        assertEquals(p.ui.offers.first().id, p.ui.selectedId)
        assertTrue(p.targets.containsKey("base:shield"))
        assertTrue(p.targets.containsKey("item:shield"))
    }

    @Test fun `absent server builders energy and shield stay unknown`() {
        val original = state()
        val unknown = home().copy(energy = null, player = home().player.copy(builders = null),
            raw = json("""{"baseId":"$baseId"}"""))
        val s = original.copy(home = original.home.copy(base = unknown))
        val p = project(s)
        assertEquals("…/…", p.ui.builders)
        assertNull(p.ui.energyNow)
        assertNull(p.ui.energyMax)
        assertNull(p.ui.shieldLeft)
    }

    @Test fun `new shop body keeps explicit recovery and original SOL owner callbacks`() {
        val text = source("ui/sheets/account/live/SuppliesHomeBody.kt")
        assertTrue(text.contains("InterruptedBanner("))
        assertTrue(text.contains("IntentKind.ITEM_BUY"))
        assertTrue(text.contains("model.interrupted.retry"))
        assertTrue(text.contains("model.interrupted.check"))
        assertTrue(text.contains("model.interrupted.close"))
        assertTrue(text.contains("onPurchase(target.kind, target.baseId)"))
        assertTrue(text.contains("model.buy(target.itemId)"))
        assertFalse(text.contains("BasePurchaseViewModel("))
        assertFalse(text.contains("Repository("))
    }

    @Test fun `old ShopScreen body is removed in same replacement`() {
        assertFalse(source("ui/roster/RosterScreens.kt").contains("fun ShopScreen("))
    }

    private fun source(path: String): String {
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path"
        return listOf(File(relative), File("app/$relative")).first { it.isFile }.readText()
    }
}
