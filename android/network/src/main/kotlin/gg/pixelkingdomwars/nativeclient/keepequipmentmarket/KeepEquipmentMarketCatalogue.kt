package gg.pixelkingdomwars.nativeclient.keepequipmentmarket

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.craftingItemIds
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.craftingItemIdsV2

/** D194/D195 identities retain old catalogues; quantities and prices remain server policy. */
object KeepEquipmentMarketCatalogue {
    val equipmentIds: Set<String> get() = setOf("route_compass", "survey_lens")
    val resourceIds: Set<String> get() = (craftingItemIds - "navigation_kit") + "crystal_fragment"
    val craftingCatalogueIds: Set<String> get() = equipmentIds + craftingItemIds
    val fragmentCatalogueIds: Set<String> get() = craftingCatalogueIds + "crystal_fragment"
    val itemIds: Set<String> get() = equipmentIds + craftingItemIdsV2 + "crystal_fragment"
    fun ids(version: String?): Set<String> = when (version) {
        null -> equipmentIds
        "2" -> craftingCatalogueIds
        "3" -> fragmentCatalogueIds
        "4" -> itemIds
        else -> error("Unsupported market catalogue")
    }
    fun category(id: String): String {
        require(id in itemIds)
        return if (id in resourceIds) "resources" else "items"
    }
}
