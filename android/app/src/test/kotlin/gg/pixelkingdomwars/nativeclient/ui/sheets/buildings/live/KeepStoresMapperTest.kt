package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.EquipmentJournal
import gg.pixelkingdomwars.nativeclient.data.EquipmentState
import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingState
import gg.pixelkingdomwars.nativeclient.model.DeedItem
import gg.pixelkingdomwars.nativeclient.model.Inventory
import gg.pixelkingdomwars.nativeclient.model.ItemActivation
import gg.pixelkingdomwars.nativeclient.model.ItemDefinition
import gg.pixelkingdomwars.nativeclient.model.ItemDiscovery
import gg.pixelkingdomwars.nativeclient.model.OwnedItem
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingFeature
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingFeatures
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingIdentity
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingJournal
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingView
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryProtectedStock
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.EquipmentFeature
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.EquipmentFeatures
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.EquipmentStock
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.EquipmentView
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.KeepStoresUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.STORES_HERO_GEAR
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.StoresTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.storesChipLine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Keep STORES live mapper: the stores show only server counts, offer USE exactly where the Inventory screen does, and
 *  never sell, trade or guess. Synthetic server values, not copied tuning. */
class KeepStoresMapperTest {
    private val wallet = "11111111111111111111111111111112"
    private val base = "00000000-0000-4000-8000-000000000001"
    private val otherBase = "00000000-0000-4000-8000-000000000009"
    private val now = "2026-10-04T07:00:00.000Z"
    private val identity = OrdinaryCraftingIdentity("https://example.invalid", "devnet", wallet)

    private fun item(id: String, kind: String, activation: ItemActivation? = null, asset: String? = null) =
        ItemDefinition(id, name = id.replace('_', ' '), kind = kind, desc = "What $id does.", asset = asset, activation = activation)

    private val keg = item("keg_of_haste", "consumable")
    private val writ = item("mage_writ", "consumable", ItemActivation("training"))
    private val usedWrit = item("bowman_writ", "consumable", ItemActivation("training", active = true))
    private val contract = item("theodor_contract", "consumable", ItemActivation("hero"))
    private val helm = item("iron_helm", "gear")
    private val awning = item("market_awning", "cosmetic")

    private fun bagInventory(seen: List<String> = listOf("keg_of_haste", "mage_writ", "bowman_writ", "theodor_contract", "market_awning")) = Inventory(
        catalog = listOf(keg, writ, usedWrit, contract, helm, awning),
        owned = listOf(OwnedItem("keg_of_haste", "3"), OwnedItem("mage_writ", "1"), OwnedItem("bowman_writ", "1"),
            OwnedItem("theodor_contract", "1"), OwnedItem("iron_helm", "1"), OwnedItem("market_awning", "1")),
        discovery = seen.map { ItemDiscovery(it) },
        deeds = listOf(DeedItem(id = "deed-1", baseId = base, name = "Crownlands Plot", status = "active")),
    )

    private fun craftingView(viewBase: String = base, available: String = "14") = OrdinaryCraftingView(wallet, viewBase,
        OrdinaryCraftingFeatures(OrdinaryCraftingFeature(1, 1)), true, 2, 9, emptyList(),
        listOf(OrdinaryRawStock("frost_quartz", available, "2", "16"), OrdinaryRawStock("storm_ore", "0", "0", "0")),
        listOf(OrdinaryProtectedStock("frostglass", "3", "1"), OrdinaryProtectedStock("navigation_kit", "2", "0")),
        emptyList(), now, catalogueVersion = 2, shardsAvailable = "0")

    private fun craftingState(view: OrdinaryCraftingView? = craftingView()) =
        OrdinaryCraftingState(OrdinaryCraftingJournal(1, identity, 0, null, emptyList()), view, advertised = true)

    private fun equipmentState(viewBase: String = base) = EquipmentState(
        journal = EquipmentJournal(identity = StarterIdentity(identity.origin, identity.cluster, wallet)),
        view = EquipmentView(wallet, viewBase, now, EquipmentFeatures(EquipmentFeature(1, 1)), true, 1, 1, emptyList(),
            emptyList(), listOf(EquipmentStock("route_compass", "1", "0", "0")), emptyList()))

    private fun sources(inventory: Inventory? = bagInventory(), crafting: OrdinaryCraftingState? = craftingState(), equipment: EquipmentState? = null,
        ordersAllowed: Boolean = true, itemsBlocked: Boolean = false, loading: Boolean = false, error: String? = null) =
        KeepStoresSources(12, inventory, crafting, equipment, wallet, base, ordersAllowed, itemsBlocked, loading, error)

    private fun bag(selected: String? = null, src: KeepStoresSources = sources(), using: String? = null, previous: KeepStoresUi? = null) =
        keepStoresUi(src, StoresTab.BAG, selected, using, previous, null)

    @Test fun `USE is offered exactly where the Inventory screen offers it`() {
        val inv = bagInventory()
        // The Inventory rule decides; the stores never offer USE on anything else (gear, cosmetics, an active writ).
        for (definition in inv.catalog) {
            val ui = bag(definition.id)
            if (ui.selected == null) continue
            assertEquals(definition.id, keepStoresUsable(definition, inv), ui.primary != null)
        }
        val kegUse = requireNotNull(bag("keg_of_haste").primary)
        assertEquals("USE", kegUse.caption)
        assertEquals(CommandState.ENABLED, kegUse.state)
        assertNotNull(bag("mage_writ").primary)
        assertNull("an unlocked writ has nothing left to use", bag("bowman_writ").primary)
        assertNull("gear is worn at the Hero Altar, not used", bag("iron_helm").primary)
    }

    @Test fun `a hero contract never gets USE and goes to the altar in the build tray`() {
        val ui = bag("theodor_contract")
        assertFalse(keepStoresUsable(contract, bagInventory()))
        assertNull(ui.primary)
        assertEquals(StoresDoors.HERO_BUILD, ui.go?.id)
        assertEquals(FeatureId("build.heroes"), ui.go?.id)
        assertTrue(requireNotNull(ui.selected?.rightNow).contains("Place the Hero Altar"))
    }

    @Test fun `BAG groups follow the design order and name where each GO goes`() {
        val ui = bag()
        assertEquals(listOf(STORES_USE_NOW, STORES_HERO_GEAR, STORES_WRITS), ui.groups.map { it.id })
        assertNull("USE NOW items are used from the Keep, no GO", ui.groups[0].go)
        assertEquals(StoresDoors.HERO_GEAR to "ALTAR", ui.groups[1].go to ui.groups[1].goLabel)
        assertEquals(StoresDoors.TRAIN to "BARRACKS", ui.groups[2].go to ui.groups[2].goLabel)
        assertEquals("3", ui.groups[0].items.single().count)
        assertEquals("7 in your bag", storesChipLine(ui.tab, ui.groups))
    }

    @Test fun `deeds and cosmetics are read only and only point at the Market`() {
        val ui = keepStoresUi(sources(), StoresTab.COLLECTION, "deed-1", null, null, null)
        val group = ui.groups.single()
        assertEquals(STORES_COLLECTION, group.id)
        assertEquals(listOf("market_awning", "deed-1"), group.items.map { it.id })
        assertEquals(StoresDoors.MARKET, group.go)
        assertEquals("MARKET", group.goLabel)
        assertNull("nothing in the collection is used, sold or traded inside the Keep", ui.primary)
        assertEquals(StoresDoors.MARKET, ui.go?.id)
        assertNull(keepStoresUi(sources(), StoresTab.COLLECTION, "market_awning", null, null, null).primary)
    }

    @Test fun `an unknown count is the ellipsis never zero`() {
        val using = bag("keg_of_haste", using = "keg_of_haste")
        assertEquals(UNKNOWN, using.groups[0].items.single().count)
        assertEquals("Using", using.primary?.caption)
        assertEquals(CommandState.BUSY, using.primary?.state)
        assertEquals("$UNKNOWN in your bag", storesChipLine(using.tab, using.groups))
        val malformed = keepStoresUi(sources(crafting = craftingState(craftingView(available = "lots"))), StoresTab.MATERIALS, null, null, null, null)
        assertEquals(UNKNOWN, malformed.groups.first().items.first { it.id == "frost_quartz" }.count)
        // A known zero stays a zero.
        assertEquals("0", malformed.groups.first().items.first { it.id == "storm_ore" }.count)
    }

    @Test fun `a loading refresh keeps the previous groups instead of blanking them`() {
        val shown = bag()
        val refreshing = bag(src = sources(inventory = null, loading = true), previous = shown)
        assertEquals(shown.groups, refreshing.groups)
        assertTrue(refreshing.loading)
        val failed = keepStoresUi(sources(inventory = null, error = STORES_READ_FAILED), StoresTab.BAG, null, null, shown, "2 min ago")
        assertEquals(shown.groups, failed.groups)
        assertEquals("2 min ago", failed.staleSince)
        assertNull("no stale row while the last read succeeded", bag(previous = shown).staleSince)
    }

    @Test fun `a crafting view of another kingdom shows no MATERIALS counts`() {
        val ours = keepStoresUi(sources(), StoresTab.MATERIALS, null, null, null, null)
        assertEquals(listOf(STORES_HARVESTERS, STORES_WORKSHOP), ours.groups.map { it.id })
        val foreign = keepStoresUi(sources(crafting = craftingState(craftingView(viewBase = otherBase))), StoresTab.MATERIALS, null, null, ours, null)
        assertTrue("never keeps the other kingdom's or older counts", foreign.groups.isEmpty())
        assertEquals("Materials not checked yet", foreign.empty?.headline)
        assertEquals(StoresDoors.WORKSHOP, foreign.empty?.go)
    }

    @Test fun `materials carry their reserved and in-progress lines and their own GO`() {
        val ui = keepStoresUi(sources(), StoresTab.MATERIALS, "frost_quartz", null, null, null)
        val raw = ui.groups[0].items.first { it.id == "frost_quartz" }
        assertEquals("14", raw.count)
        assertEquals("2 reserved by a job", raw.reserved)
        assertEquals("1 being refined", ui.groups[1].items.single { it.id == "frostglass" }.reserved)
        assertFalse("crafted kits belong to KITS", ui.groups[1].items.any { it.id == "navigation_kit" })
        assertEquals(StoresDoors.HARVEST, ui.go?.id)
        assertNull(ui.primary)
    }

    @Test fun `KITS list held kits and never call an unread tab empty`() {
        val kits = keepStoresUi(sources(equipment = equipmentState()), StoresTab.KITS, null, null, null, null)
        assertEquals(listOf("navigation_kit", "route_compass"), kits.groups.single().items.map { it.id })
        val unread = keepStoresUi(sources(crafting = null), StoresTab.KITS, null, null, null, null)
        assertTrue(unread.groups.isEmpty())
        assertEquals("Kits not checked yet", unread.empty?.headline)
        assertEquals(FeatureId("workshop.equipment"), unread.empty?.go)
        assertNull("nothing is claimed while the read is still running", keepStoresUi(sources(crafting = null, loading = true), StoresTab.KITS,
            null, null, null, null).empty)
    }

    @Test fun `a read-only base turns USE off with the reason and keeps GO`() {
        val outdated = bag("mage_writ", src = sources(ordersAllowed = false))
        assertEquals(STORES_UPDATE_REQUIRED, outdated.readOnly)
        assertEquals(CommandState.DISABLED, outdated.primary?.state)
        assertEquals(STORES_UPDATE_REQUIRED, outdated.primary?.reason)
        assertEquals(StoresDoors.TRAIN, outdated.go?.id)
        val saved = bag("keg_of_haste", src = sources(itemsBlocked = true))
        assertEquals(STORES_ITEM_REQUEST_SAVED, saved.readOnly)
        assertEquals(CommandState.DISABLED, saved.primary?.state)
    }

    @Test fun `NEW marks unseen items and badges only the other tabs`() {
        val ui = bag(src = sources(inventory = bagInventory(seen = listOf("keg_of_haste", "mage_writ", "bowman_writ", "theodor_contract"))))
        assertTrue(ui.groups.first { it.id == STORES_HERO_GEAR }.items.single().isNew)
        assertNull("the active tab shows NEW on the tile itself", ui.tabBadges[StoresTab.BAG])
        assertEquals("NEW", ui.tabBadges[StoresTab.COLLECTION]?.text)
    }

    @Test fun `a group GO routes to its own destination and an unknown group to none`() {
        val ui = bag()
        assertEquals(StoresDoors.HERO_GEAR, storesGroupGo(ui, STORES_HERO_GEAR))
        assertEquals(StoresDoors.TRAIN, storesGroupGo(ui, STORES_WRITS))
        assertNull(storesGroupGo(ui, STORES_USE_NOW))
        assertNull(storesGroupGo(ui, "missing"))
    }

    @Test fun `the stale row says how old the last good read is`() {
        assertNull(storesAgo(1_000_000L, null))
        assertEquals("just now", storesAgo(1_030_000L, 1_000_000L))
        assertEquals("2 min ago", storesAgo(1_000_000L + 125_000L, 1_000_000L))
        assertEquals("3h ago", storesAgo(3 * 3_600_000L + 5L, 0L))
        assertEquals("2d ago", storesAgo(2 * 86_400_000L, 0L))
    }

    @Test fun `an unknown Keep level never reads as level zero in the data`() {
        val ui = keepStoresUi(sources().copy(keepLevel = null), StoresTab.BAG, null, null, null, null)
        assertEquals(0, ui.keepLevel)
        assertEquals(12, keepStoresUi(sources().copy(keepLevel = null), StoresTab.BAG, null, null, bag(), null).keepLevel)
    }
}
