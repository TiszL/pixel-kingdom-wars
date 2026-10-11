package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.model.ItemDefinition
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileState
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterUiState
import gg.pixelkingdomwars.nativeclient.ui.roster.modifierLabel
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.CompareLineUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.DeltaTone
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.FooterUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.GearSlotState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.GearSlotUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.GearUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ItemCompareUi
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** InventoryEquipment's current catalogue, ownership and hero loadout projected into the designed GEAR tab. */
internal data class GearLiveProjection(val gear: GearUi, val footer: FooterUi, val hasNew: Boolean)

private fun slotIcon(slot: String): String = when (slot) {
    "weapon" -> "itm_hammer"
    "offhand" -> "itm_shield"
    else -> "itm_$slot"
}

private fun gearCompare(item: ItemDefinition, worn: ItemDefinition?, isWorn: Boolean, comparisonKnown: Boolean): ItemCompareUi {
    val stats = (item.modifiers.map { it.stat } + worn?.modifiers.orEmpty().map { it.stat }).distinct()
    val lines = stats.map { stat ->
        val value = item.modifiers.firstOrNull { it.stat == stat }?.value ?: 0
        val previous = worn?.modifiers?.firstOrNull { it.stat == stat }?.value ?: 0
        val delta = value - previous
        CompareLineUi(modifierLabel(stat, value),
            if (!comparisonKnown) UNKNOWN else if (isWorn || delta == 0) "" else modifierLabel(stat, delta).substringAfterLast(' '),
            when { !comparisonKnown -> DeltaTone.UNKNOWN; isWorn || delta == 0 -> DeltaTone.ZERO; delta > 0 -> DeltaTone.GAIN; else -> DeltaTone.LOSS })
    }
    return ItemCompareUi(item.id, item.name ?: item.id, lines, isWorn)
}

internal fun gearLiveProjection(state: RosterUiState, hero: String, selectedSlot: String?, busy: Boolean): GearLiveProjection {
    val inventory = state.domain.inventory
    val loadout = inventory?.loadout(hero)
    val constants = state.catalogue?.get("constants") as? JsonObject
    val catalogueSlots = (constants?.get("GEAR_SLOTS") as? JsonArray)?.mapNotNull {
        (it as? JsonPrimitive)?.content?.takeIf(String::isNotBlank)
    }?.distinct().orEmpty()
    val known = inventory != null && loadout != null && catalogueSlots.isNotEmpty()
    val slots = if (!known) emptyList() else catalogueSlots.map { slot ->
        val wornId = loadout?.equipment?.get(slot)
        GearSlotUi(slot, slot.replaceFirstChar { it.uppercase() }, wornId?.let { inventory?.item(it)?.asset ?: slotIcon(slot) },
            if (wornId == null) GearSlotState.EMPTY else GearSlotState.WORN, slotIcon(slot))
    }
    val selectedDefinition = inventory?.item(state.selectedItemId.orEmpty())
    val slot = if (!known) null else if (selectedSlot != null) selectedSlot.takeIf { it in catalogueSlots }
        else selectedDefinition?.takeIf { state.selectedHero == hero && it.kind == "gear" && it.slot in catalogueSlots }?.slot
            ?: catalogueSlots.firstOrNull()
    val bagItems = if (slot == null || inventory == null) emptyList() else inventory.catalog.filter {
        it.kind == "gear" && it.slot == slot && inventory.quantity(it.id) > 0
    }
    val selected = bagItems.firstOrNull { state.selectedHero == hero && it.id == state.selectedItemId }
    val wornId = slot?.let { loadout?.equipment?.get(it) }
    val isWorn = selected != null && selected.id == wornId
    val compared = wornId?.let { inventory?.item(it) }
    val bag = bagItems.map { item ->
        val quantity = requireNotNull(inventory).quantity(item.id)
        val wornHere = item.id == wornId
        ItemTileUi(item.id, item.asset ?: slotIcon(requireNotNull(item.slot)), "×$quantity",
            "${item.name ?: item.id}, $quantity owned${if (wornHere) ", worn by this hero" else if (inventory.stored(item.id) == 0) ", equipped by another hero" else ""}",
            if (item.id == selected?.id) ItemTileState.SELECTED else ItemTileState.OWNED, isNew = !inventory.seen(item.id))
    }
    val reason = when {
        !state.ordersAllowed -> ordersBlockedReason(false, true)
        !known -> "Equipment is unavailable. Refresh the inventory to read this hero's loadout and gear slots."
        state.selectedHero != hero -> "The selected hero is changing. Choose the item again."
        loadout?.recruited != true -> "Recruit this hero before equipping gear."
        slot == null -> "Choose an available gear slot."
        selected == null -> "Select gear from your bag."
        !isWorn && requireNotNull(inventory).stored(selected.id) <= 0 -> "Every owned copy is equipped by another hero."
        else -> null
    }
    val primary = liveCommand(FeatureId("hero.gear"), if (isWorn) "UNEQUIP" else "EQUIP",
        when { busy -> CommandState.BUSY; reason != null -> CommandState.DISABLED; else -> CommandState.ENABLED }, reason,
        verb = if (isWorn) Verb.STONE else Verb.GOLD)
    val heroName = state.hero(hero)?.name ?: hero.replaceFirstChar { it.uppercase() }
    val threshold = if (known) loadout?.setBonus?.required?.takeIf { it > 0 } else null
    val awakened = loadout?.setBonus?.active == true
    val gear = GearUi(slots, slots.count { it.state == GearSlotState.WORN }, threshold ?: 0, slot, bag,
        selected?.let { gearCompare(it, compared, isWorn, wornId == null || compared != null) },
        bagEmpty = if (bag.isEmpty()) EmptyStateUi(slot?.let(::slotIcon) ?: "itm_helm",
            if (!known) "Equipment unavailable" else "No gear for this slot",
            if (!known) requireNotNull(reason) else "Your owned gear for this slot will appear here.", null, null) else null,
        rolloutNote = inventory?.takeIf { !it.heroGearCombatEnabled }?.let { "Equipment saved · combat rollout off" },
        awakenLine = if (threshold == null) "" else if (awakened) "Awaken set complete" else "Wear $threshold to awaken $heroName",
        slotTitle = slot.orEmpty(),
        awakenSummary = if (threshold == null) "" else if (awakened) "Awaken set complete" else "Wear $threshold to awaken")
    return GearLiveProjection(gear, FooterUi(gearFooterInfo(selected, isWorn, slot, wornId, compared, reason), emptyList(), primary),
        inventory?.let { data -> data.catalog.any { it.kind == "gear" && data.quantity(it.id) > 0 && !data.seen(it.id) } } == true)
}

/** The GEAR footer's info block (heroes-gear.png "Fills the empty / Cloak slot.", SPEC §5 "Old cloak goes back to your
 *  bag."): what EQUIP / UNEQUIP will do to the selected slot. While the primary is off its reason says why, so the block
 *  only names the selected item. */
private fun gearFooterInfo(selected: ItemDefinition?, isWorn: Boolean, slot: String?, wornId: String?, worn: ItemDefinition?,
    reason: String?): List<String> {
    if (selected == null) return emptyList()
    val name = selected.name ?: selected.id
    if (reason != null || slot == null) return listOf(name)
    return when {
        isWorn -> listOf("$name goes back", "to your bag.")
        wornId != null -> listOf("${worn?.name ?: worn?.id ?: "The worn piece"} goes back", "to your bag.")
        else -> listOf("Fills the empty", "${slot.replaceFirstChar { it.uppercase() }} slot.")
    }
}

/** Re-evaluated against the model at click time; the existing model/repository own the fresh versioned save. */
internal fun gearEquipItem(state: RosterUiState, hero: String, selectedSlot: String?, busy: Boolean,
    expectedItemId: String? = state.selectedItemId, expectedWorn: Boolean? = null): String? {
    val projection = gearLiveProjection(state, hero, selectedSlot, busy)
    val item = projection.gear.selectedItem ?: return null
    return item.id.takeIf { it == expectedItemId && (expectedWorn == null || item.worn == expectedWorn)
        && projection.footer.primary.state == CommandState.ENABLED }
}
