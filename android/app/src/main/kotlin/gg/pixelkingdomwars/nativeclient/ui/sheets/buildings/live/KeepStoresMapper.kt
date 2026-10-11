package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.EquipmentState
import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingState
import gg.pixelkingdomwars.nativeclient.model.Inventory
import gg.pixelkingdomwars.nativeclient.model.ItemDefinition
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.KeepStoresUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.STORES_HERO_GEAR
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.StoreGroupUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.StoreItemUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.StoresTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.catalogueKey
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.craftItemIcon
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.liveCount

/*
 * Keep STORES live mapper (design/final/buildings/SPEC.md E1.1, keep-stores.png): the existing owners' state -> the
 * designed KeepStoresUi. Pure; JVM-tested in KeepStoresMapperTest. Reads only what the owners already hold:
 * - BAG and COLLECTION: `GET /items` (ArmyRepository.state.inventory, loaded by RosterViewModel.loadInventory);
 * - MATERIALS and the crafted kits: the ordinary-crafting view, only when it belongs to this wallet AND this base;
 * - Route Compass / Survey Lens: the ordinary-equipment view, under the same rule.
 * Every count is a server string; an unknown count is "…", never 0. Nothing here sells, trades or spends: USE calls the
 * existing item-use owner, everything else is a GO to the building that owns the action.
 */

/** Everything [keepStoresUi] reads. [wallet] / [baseId] scope the crafting and equipment views (a view of another
 *  wallet or kingdom shows nothing). [loading] / [error] describe the host's own read. */
internal data class KeepStoresSources(
    val keepLevel: Int?,
    val inventory: Inventory?,
    val crafting: OrdinaryCraftingState?,
    val equipment: EquipmentState?,
    val wallet: String?,
    val baseId: String?,
    val ordersAllowed: Boolean,
    val itemsBlocked: Boolean,
    val loading: Boolean,
    val error: String?,
)

/** The registry rows the stores' doors open (all exist in FeatureCatalogue; none is invented here). */
internal object StoresDoors {
    val HERO_GEAR = FeatureId("hero.gear")
    val TRAIN = FeatureId("barracks.train")
    /** BUILD › HEROES: a hero contract is used by placing its altar (InventoryScreen rule). */
    val HERO_BUILD = FeatureId("build.heroes")
    val HARVEST = FeatureId("harvester.harvest")
    val WORKSHOP = FeatureId("workshop.craft")
    val EQUIPMENT = FeatureId("workshop.equipment")
    val MARKET = FeatureId("market.trade")
    /** The USE primary's own id (the STORES row; the sheet hands the item id to onUse, never this id). */
    val STORES = FeatureId("keep.stores")
}

/** Group ids (handed back by onGroupGo). */
internal const val STORES_USE_NOW = "use-now"
internal const val STORES_WRITS = "writs"
internal const val STORES_HARVESTERS = "harvesters"
internal const val STORES_WORKSHOP = "workshop"
internal const val STORES_KITS = "kits"
internal const val STORES_COLLECTION = "collection"

/** The existing order gate's wording (RosterViewModel.orders): an outdated app turns every USE off. */
internal const val STORES_UPDATE_REQUIRED = "Install the available native app update before submitting game orders. Your account is preserved."
/** A saved item purchase or use whose answer was lost: USE stays off until the player checks it (InventoryScreen rule). */
internal const val STORES_ITEM_REQUEST_SAVED = "Check your saved item request before using another item."
/** The SPEC E1.1 error toast. */
internal const val STORES_READ_FAILED = "The Keep can't reach the server. Try again."

/** The InventoryScreen USE rule (RosterScreens ItemDetail): a stored consumable whose benefit is not already active.
 *  A hero contract is never used here: it is consumed by placing the hero's altar. */
internal fun keepStoresUsable(item: ItemDefinition, inventory: Inventory): Boolean =
    item.kind == "consumable" && inventory.stored(item.id) > 0 && item.activation?.active != true && item.activation?.kind != "hero"

/**
 * The Keep STORES sheet state for [tab]. [selectedId] is the tapped tile; [usingId] the item whose USE is in flight (its
 * count reads "…" and the primary is stone "Using"). [previous] is the last state drawn: when this tab's source is not
 * known right now (a refresh cleared it, or the read failed) its groups stay, so counts never blank. [staleSince] ("2 min
 * ago") is shown only while [KeepStoresSources.error] is set.
 */
internal fun keepStoresUi(src: KeepStoresSources, tab: StoresTab, selectedId: String?, usingId: String?,
    previous: KeepStoresUi?, staleSince: String?): KeepStoresUi {
    val fresh = storesTab(src, tab, usingId)
    val kept = previous?.takeIf { it.tab == tab && fresh == null }
    val groups = fresh?.groups ?: kept?.groups.orEmpty()
    val empty = if (fresh != null) fresh.empty else kept?.empty ?: unknownEmpty(src, tab)
    val readOnly = when {
        !src.ordersAllowed -> STORES_UPDATE_REQUIRED
        src.itemsBlocked -> STORES_ITEM_REQUEST_SAVED
        else -> null
    }
    val group = groups.firstOrNull { g -> g.items.any { it.id == selectedId } }
    val selected = group?.items?.firstOrNull { it.id == selectedId }
    val inventory = src.inventory
    val definition = selected?.let { inventory?.item(it.id) }
    val usable = definition != null && inventory != null && tab == StoresTab.BAG && keepStoresUsable(definition, inventory)
    val primary = if (selected == null || !usable) null else {
        val using = usingId == selected.id
        CommandUi(StoresDoors.STORES, "", if (using) "Using" else "USE", null, true,
            when { using -> CommandState.BUSY; readOnly != null -> CommandState.DISABLED; else -> CommandState.ENABLED },
            readOnly, null, Verb.GOLD)
    }
    val go = selected?.let { selectedGo(group, definition) }
    return KeepStoresUi(
        keepLevel = src.keepLevel ?: previous?.keepLevel ?: 0,
        tab = tab,
        tabBadges = storesTabBadges(inventory, tab),
        groups = groups,
        selected = selected,
        primary = primary,
        go = go,
        loading = src.loading,
        staleSince = if (src.error != null) staleSince ?: UNKNOWN else null,
        readOnly = readOnly,
        empty = if (groups.isEmpty()) empty else null,
    )
}

/** One tab's groups and empty state, or null when its source is not known right now. */
private data class StoresTabUi(val groups: List<StoreGroupUi>, val empty: EmptyStateUi?)

private fun storesTab(src: KeepStoresSources, tab: StoresTab, usingId: String?): StoresTabUi? = when (tab) {
    StoresTab.BAG -> src.inventory?.let { bagTab(it, usingId) }
    StoresTab.MATERIALS -> src.crafting?.view?.let { view ->
        // Another wallet's or kingdom's view is known but not ours: show no counts (and never keep older groups).
        if (scopeMatches(view.wallet, view.baseId, src)) materialsTab(view) else StoresTabUi(emptyList(), MATERIALS_NOT_CHECKED)
    }
    StoresTab.KITS -> kitsTab(src)
    StoresTab.COLLECTION -> src.inventory?.let { collectionTab(it) }
}

/** True only for this wallet's view of this base. */
private fun scopeMatches(viewWallet: String, viewBase: String, src: KeepStoresSources): Boolean =
    !src.wallet.isNullOrBlank() && !src.baseId.isNullOrBlank() && viewWallet == src.wallet && viewBase == src.baseId

private val MATERIALS_NOT_CHECKED = EmptyStateUi("ui:harvester-menu", "Materials not checked yet",
    "Raw materials come from Realm Harvesters and are refined at the Workshop.", "GO TO WORKSHOP", StoresDoors.WORKSHOP)
private val KITS_NOT_CHECKED = EmptyStateUi("ui:expedition-kit", "Kits not checked yet",
    "Kits are crafted at the Workshop and used on Lodge expeditions.", "GO TO WORKSHOP", StoresDoors.EQUIPMENT)

/** What a tab shows before its first read: nothing while that read runs (the loading line says it is coming); after it,
 *  MATERIALS / KITS say they have not been checked and offer the Workshop, never "nothing here" for an unknown. */
private fun unknownEmpty(src: KeepStoresSources, tab: StoresTab): EmptyStateUi? = when {
    src.loading -> null
    tab == StoresTab.MATERIALS -> MATERIALS_NOT_CHECKED
    tab == StoresTab.KITS -> KITS_NOT_CHECKED
    else -> null
}

// ---- BAG ----

private fun bagTab(inventory: Inventory, usingId: String?): StoresTabUi {
    val owned = inventory.catalog.filter { inventory.quantity(it.id) > 0 }
    val useNow = owned.filter { it.kind == "consumable" && it.activation == null }
    val gear = owned.filter { it.kind == "gear" && inventory.stored(it.id) > 0 }
    val writs = owned.filter { it.kind == "consumable" && it.activation != null }
    val groups = listOfNotNull(
        group(STORES_USE_NOW, "timer", "USE NOW", "speed-ups and shields", null, null, useNow.map { bagItem(it, inventory, usingId) }),
        group(STORES_HERO_GEAR, "itm_helm", "HERO GEAR", "wear on heroes", StoresDoors.HERO_GEAR, "ALTAR",
            gear.map { bagItem(it, inventory, usingId) }),
        group(STORES_WRITS, "ui_portrait_mage_t1", "WRITS", "unlock troops", StoresDoors.TRAIN, "BARRACKS",
            writs.map { bagItem(it, inventory, usingId) }),
    )
    return StoresTabUi(groups, if (groups.isEmpty()) EmptyStateUi("backpack", "Nothing here yet",
        "Speed-ups, gear and writs you earn or buy show here.", null, null) else null)
}

private fun bagItem(item: ItemDefinition, inventory: Inventory, usingId: String?): StoreItemUi {
    val activation = item.activation
    val contract = activation?.kind == "hero"
    // The same sentences the Inventory screen shows for an activation item (sentence case here).
    val rightNow = when {
        activation == null -> null
        activation.active && contract -> "Hero already recruited on this base. Sell the unused contract on the Market."
        activation.active -> "Training already unlocked. Sell the unused writ on the Market."
        contract -> "Place the Hero Altar to use this contract. It is consumed when placed."
        else -> "Use once to unlock training. The writ is consumed."
    }
    return StoreItemUi(
        id = item.id,
        icon = item.asset?.takeIf { it.isNotBlank() } ?: craftItemIcon(item.id),
        name = storesName(item.name, item.id),
        count = if (usingId == item.id) UNKNOWN else inventory.stored(item.id).toString(),
        reserved = null,
        isNew = !inventory.seen(item.id),
        whatItDoes = item.text.ifBlank { if (item.kind == "gear") "Wear it on a hero at the Hero Altar." else "Use it from the Keep." },
        rightNow = rightNow,
        useTarget = null,
    )
}

// ---- MATERIALS ----

private fun materialsTab(view: gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingView): StoresTabUi {
    val raw = view.rawStock.map { stock ->
        materialItem(stock.resourceId, stock.available, liveCount(stock.reserved)?.takeIf { it > 0 }?.let { "$it reserved by a job" },
            "Refined into Workshop materials. From a Realm Harvester.")
    }
    val refined = view.craftingStock.filterNot { storesIsKit(it.itemId) }.map { stock ->
        materialItem(stock.itemId, stock.available, liveCount(stock.pendingOutput)?.takeIf { it > 0 }?.let { "$it being refined" },
            "Used in Workshop recipes. Refined at the Workshop.")
    }
    return StoresTabUi(listOfNotNull(
        group(STORES_HARVESTERS, "ui:harvester-menu", "HARVESTERS", "raw, one per realm", StoresDoors.HARVEST, "HARVESTER", raw),
        group(STORES_WORKSHOP, "ui:workshop-menu", "WORKSHOP", "refined from raw", StoresDoors.WORKSHOP, "WORKSHOP", refined),
    ), null)
}

private fun materialItem(id: String, available: String, reserved: String?, what: String) = StoreItemUi(
    id = id, icon = craftItemIcon(id), name = storesName(null, id), count = liveCount(available)?.toString() ?: UNKNOWN,
    reserved = reserved, isNew = false, whatItDoes = what, rightNow = null, useTarget = null)

/** The three crafted kits ride in the crafting view; the stores show them under KITS, not WORKSHOP (SPEC E1.1). */
private fun storesIsKit(itemId: String): Boolean = catalogueKey(itemId).endsWith("_kit")

// ---- KITS ----

private fun kitsTab(src: KeepStoresSources): StoresTabUi? {
    val craftingRead = src.crafting?.view
    val equipmentRead = src.equipment?.view
    if (craftingRead == null && equipmentRead == null) return null
    val crafting = craftingRead?.takeIf { scopeMatches(it.wallet, it.baseId, src) }
    val equipment = equipmentRead?.takeIf { scopeMatches(it.wallet, it.baseId, src) }
    // Only another wallet's or kingdom's views: this kingdom's kits are not checked yet, never "nothing here".
    if (crafting == null && equipment == null) return StoresTabUi(emptyList(), KITS_NOT_CHECKED)
    val kits = crafting?.craftingStock.orEmpty().filter { storesIsKit(it.itemId) }.mapNotNull { stock ->
        heldKit(stock.itemId, stock.available, liveCount(stock.pendingOutput)?.takeIf { it > 0 }?.let { "$it being crafted" })
    } + equipment?.equipmentStock.orEmpty().mapNotNull { stock ->
        heldKit(stock.itemId, stock.available, liveCount(stock.reserved)?.takeIf { it > 0 }?.let { "$it in use" })
    }
    val group = group(STORES_KITS, "ui:expedition-kit", "KITS", "for expeditions", StoresDoors.EQUIPMENT, "WORKSHOP", kits)
    return StoresTabUi(listOfNotNull(group), if (group == null) EmptyStateUi("ui:expedition-kit", "Nothing here yet",
        "Kits are crafted at the Workshop and used on Lodge expeditions.", "GO TO WORKSHOP", StoresDoors.EQUIPMENT) else null)
}

/** A kit tile only when one is held or on its way back (the stores list what the kingdom holds). */
private fun heldKit(id: String, available: String, reserved: String?): StoreItemUi? {
    val count = liveCount(available)
    if (count == 0L && reserved == null) return null
    val what = when (catalogueKey(id)) {
        // The Workshop TOOLS card sentences (EquipmentWorkshopMapper).
        "route_compass" -> "Faster return, less cargo."
        "survey_lens" -> "Swap some cargo for a second material."
        else -> "Used on Lodge expeditions."
    }
    return StoreItemUi(id, craftItemIcon(id), storesName(null, id), count?.toString() ?: UNKNOWN, reserved, false, what, null, null)
}

// ---- COLLECTION ----

private fun collectionTab(inventory: Inventory): StoresTabUi {
    val held = inventory.catalog.filter { inventory.quantity(it.id) > 0 && it.kind != "consumable" && it.kind != "gear" }.map { item ->
        StoreItemUi(item.id, item.asset?.takeIf { it.isNotBlank() } ?: craftItemIcon(item.id), storesName(item.name, item.id),
            inventory.quantity(item.id).toString(), null, !inventory.seen(item.id),
            item.text.ifBlank { "Held by your kingdom." }, null, null)
    }
    val deeds = inventory.deeds.mapNotNull { deed ->
        val id = deed.id ?: return@mapNotNull null
        StoreItemUi(id, deed.asset?.takeIf { it.isNotBlank() } ?: craftItemIcon("deed"), storesName(deed.name, "land_deed"), "1", null, false,
            "A land deed held in your wallet.", deed.status?.takeIf { it.isNotBlank() }?.let { "Status: ${it.lowercase()}." }, null)
    }
    val group = group(STORES_COLLECTION, "star", "COLLECTION", "deeds and cosmetics", StoresDoors.MARKET, "MARKET", held + deeds)
    return StoresTabUi(listOfNotNull(group), if (group == null) EmptyStateUi("star", "Nothing here yet",
        "Deeds and cosmetics you hold show here.", "GO TO MARKET", StoresDoors.MARKET) else null)
}

// ---- shared ----

private fun group(id: String, icon: String, title: String, note: String, go: FeatureId?, goLabel: String?, items: List<StoreItemUi>) =
    if (items.isEmpty()) null else StoreGroupUi(id, icon, title, note, go, items, goLabel)

/** "FROST QUARTZ" from a server name or, without one, the catalogue id. */
private fun storesName(name: String?, id: String): String =
    name?.takeIf { it.isNotBlank() }?.uppercase() ?: catalogueKey(id).split('_').filter { it.isNotEmpty() }.joinToString(" ").uppercase()

/** The footer's blue GO for the selected tile: where its group's building is (none for USE NOW, used from here). A hero
 *  contract goes to BUILD › HEROES (its altar), not the Barracks. */
private fun selectedGo(group: StoreGroupUi?, definition: ItemDefinition?): CommandUi? {
    val (door, place) = when {
        definition?.activation?.kind == "hero" -> StoresDoors.HERO_BUILD to "Hero Altar"
        else -> when (group?.id) {
            STORES_HERO_GEAR -> StoresDoors.HERO_GEAR to "Hero Altar"
            STORES_WRITS -> StoresDoors.TRAIN to "Barracks"
            STORES_HARVESTERS -> StoresDoors.HARVEST to "Harvester"
            STORES_WORKSHOP -> StoresDoors.WORKSHOP to "Workshop"
            STORES_KITS -> StoresDoors.EQUIPMENT to "Workshop"
            STORES_COLLECTION -> StoresDoors.MARKET to "Market"
            else -> return null
        }
    }
    return CommandUi(door, "", "GO", null, false, CommandState.ENABLED, null, null, Verb.BLUE, sub = place)
}

/** A gold NEW badge on every other tab that holds an unseen item (the active tab shows NEW on the tile itself). */
private fun storesTabBadges(inventory: Inventory?, active: StoresTab): Map<StoresTab, BadgeUi?> {
    if (inventory == null) return emptyMap()
    val unseen = inventory.catalog.filter { inventory.quantity(it.id) > 0 && !inventory.seen(it.id) }
    fun badge(tab: StoresTab, any: Boolean) = tab to (if (any && tab != active) BadgeUi("NEW", BadgeTone.REWARD, "New item") else null)
    return mapOf(
        badge(StoresTab.BAG, unseen.any { it.kind == "consumable" || it.kind == "gear" }),
        badge(StoresTab.COLLECTION, unseen.any { it.kind != "consumable" && it.kind != "gear" }),
    )
}

/** "2 min ago" for the stale row: under a minute "just now", then minutes, hours, and days above 24 h (D-070). */
internal fun storesAgo(nowMs: Long, sinceMs: Long?): String? {
    if (sinceMs == null) return null
    val minutes = ((nowMs - sinceMs).coerceAtLeast(0L)) / 60_000L
    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "$minutes min ago"
        minutes < 24 * 60 -> "${minutes / 60}h ago"
        else -> "${minutes / (24 * 60)}d ago"
    }
}
