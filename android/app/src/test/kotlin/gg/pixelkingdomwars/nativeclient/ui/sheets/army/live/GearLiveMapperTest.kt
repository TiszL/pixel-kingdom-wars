package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.model.GearModifier
import gg.pixelkingdomwars.nativeclient.model.HeroLoadout
import gg.pixelkingdomwars.nativeclient.model.Inventory
import gg.pixelkingdomwars.nativeclient.model.ItemDefinition
import gg.pixelkingdomwars.nativeclient.model.OwnedItem
import gg.pixelkingdomwars.nativeclient.model.SetBonus
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterUiState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.DeltaTone
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.GearSlotState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HERO_TAB_GEAR
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Gear is an owned-item projection and a versioned save, with no invented prices or set thresholds. */
class GearLiveMapperTest {
    private val catalogue = Json.parseToJsonElement("""{"constants":{"GEAR_SLOTS":["cloak","weapon","offhand"]}}""").jsonObject
    private val old = ItemDefinition("old", "Old cloak", "gear", "cloak", asset = "itm_cloak",
        modifiers = listOf(GearModifier("hero_hp_bps", 400), GearModifier("hero_damage_bps", 300)))
    private val next = ItemDefinition("next", "New cloak", "gear", "cloak", asset = "itm_cloak",
        modifiers = listOf(GearModifier("hero_hp_bps", 700), GearModifier("cooldown_reduction_bps", 200)))
    private val elsewhere = ItemDefinition("elsewhere", "Other cloak", "gear", "cloak")
    private val blade = ItemDefinition("blade", "Blade", "gear", "weapon")
    private val absent = ItemDefinition("absent", "Unowned cloak", "gear", "cloak")
    private val potion = ItemDefinition("potion", "Potion", "consumable", "cloak")
    private fun inventory() = Inventory(catalog = listOf(old, next, elsewhere, blade, absent, potion),
        owned = listOf(OwnedItem("old", "1"), OwnedItem("next", "2"), OwnedItem("elsewhere", "1"), OwnedItem("blade", "1"), OwnedItem("potion", "3")),
        heroLoadouts = listOf(HeroLoadout("vex", recruited = true, version = 17, equipment = mapOf("cloak" to "old"), setBonus = SetBonus(pieces = 1, required = 3)),
            HeroLoadout("theodor", recruited = true, equipment = mapOf("cloak" to "elsewhere"))))
    private fun state(data: Inventory? = inventory(), selected: String? = "next") =
        RosterUiState(domain = ArmyDomainState(inventory = data), catalogue = catalogue, selectedHero = "vex", selectedItemId = selected)

    @Test fun `missing inventory catalogue or loadout shows unknown equipment and no guessed awakening`() {
        val missing = listOf(state(null), state().copy(catalogue = null), state(inventory().copy(heroLoadouts = emptyList())))
        missing.forEach { source ->
            val ui = gearLiveProjection(source, "vex", "cloak", false)
            assertTrue(ui.gear.slots.isEmpty())
            assertEquals("", ui.gear.awakenLine)
            assertNull(ui.gear.selectedItem)
            assertEquals(CommandState.DISABLED, ui.footer.primary.state)
            assertNull(ui.footer.primary.price)
            assertTrue(ui.gear.bagEmpty!!.reason.isNotBlank())
        }
    }

    @Test fun `slot order count awakening and rollout wording come from current inventory and catalogue`() {
        val ui = gearLiveProjection(state(), "vex", "cloak", false)
        assertEquals(listOf("cloak", "weapon", "offhand"), ui.gear.slots.map { it.slot })
        assertEquals(GearSlotState.WORN, ui.gear.slots.first().state)
        assertEquals(1, ui.gear.worn)
        assertEquals(3, ui.gear.awakenAt)
        assertEquals("Wear 3 to awaken Vex", ui.gear.awakenLine)
        assertEquals("Equipment saved · combat rollout off", ui.gear.rolloutNote)
        assertEquals(listOf("old", "next", "elsewhere"), ui.gear.bag.map { it.id })
        assertTrue(ui.hasNew)
        val noThreshold = gearLiveProjection(state(inventory().copy(heroLoadouts = inventory().heroLoadouts.map { it.copy(setBonus = null) })), "vex", "cloak", false)
        assertEquals("", noThreshold.gear.awakenLine)
        assertEquals(0, noThreshold.gear.awakenAt)
        assertNull(gearLiveProjection(state(inventory().copy(heroGearCombatEnabled = true)), "vex", "cloak", false).gear.rolloutNote)
    }

    @Test fun `comparison includes removed stats and uses the existing beneficial reduction display sign`() {
        val item = gearLiveProjection(state(), "vex", "cloak", false).gear.selectedItem!!
        assertFalse(item.worn)
        assertEquals(listOf("HERO HP +7%", "COOLDOWN −2%", "DAMAGE 0%"), item.lines.map { it.label })
        assertEquals(listOf("+3%", "−2%", "−3%"), item.lines.map { it.delta })
        assertEquals(listOf(DeltaTone.GAIN, DeltaTone.GAIN, DeltaTone.LOSS), item.lines.map { it.tone })
    }

    @Test fun `owned stored gear equips freely and current worn item unequips even with none stored`() {
        val equip = gearLiveProjection(state(), "vex", "cloak", false).footer.primary
        assertEquals(CommandState.ENABLED, equip.state)
        assertEquals("EQUIP", equip.caption)
        assertEquals(Verb.GOLD, equip.verb)
        assertNull(equip.price)
        assertEquals("next", gearEquipItem(state(), "vex", "cloak", false))
        val unequip = gearLiveProjection(state(selected = "old"), "vex", "cloak", false).footer.primary
        assertEquals(CommandState.ENABLED, unequip.state)
        assertEquals("UNEQUIP", unequip.caption)
        assertEquals(Verb.STONE, unequip.verb)
        assertEquals("old", gearEquipItem(state(selected = "old"), "vex", "cloak", false))
    }

    @Test fun `another hero wearing the only copy does not authorize equipping it`() {
        val ui = gearLiveProjection(state(selected = "elsewhere"), "vex", "cloak", false)
        assertEquals(CommandState.DISABLED, ui.footer.primary.state)
        assertTrue(ui.footer.primary.reason!!.contains("another hero"))
        assertNull(gearEquipItem(state(selected = "elsewhere"), "vex", "cloak", false))
    }

    @Test fun `click eligibility rejects stale hero selection missing item wrong slot busy and orders hold`() {
        listOf(state().copy(selectedHero = "theodor"), state(selected = "absent"), state(selected = "potion"),
            state(selected = "blade"), state().copy(ordersAllowed = false),
            state(inventory().copy(heroLoadouts = inventory().heroLoadouts.map { it.copy(recruited = false) })))
            .forEach { assertNull(gearEquipItem(it, "vex", "cloak", false)) }
        assertNull(gearEquipItem(state(), "vex", "cloak", true))
        assertNull(gearEquipItem(state(), "vex", "removed-slot", false))
        assertNull(gearEquipItem(state(inventory().copy(owned = emptyList())), "vex", "cloak", false))
    }

    @Test fun `Heroes gear tab receives actual gear and free save primary`() {
        val ui = heroesLiveUi(state(), "vex", HERO_TAB_GEAR, 0, false, selectedSlot = "cloak")
        assertEquals("next", ui.gear.selectedItem?.id)
        assertEquals("EQUIP", ui.footer.primary.caption)
        assertNull(ui.footer.primary.price)
        assertTrue(ui.gearNew)
    }

    @Test fun `changed selection or equip mode since the rendered button refuses a stale click`() {
        assertNull(gearEquipItem(state(), "vex", "cloak", false, expectedItemId = "old", expectedWorn = true))
        val changedLoadout = inventory().copy(heroLoadouts = inventory().heroLoadouts.map {
            if (it.hero == "vex") it.copy(equipment = mapOf("cloak" to "next"), version = 18) else it
        })
        assertNull(gearEquipItem(state(changedLoadout), "vex", "cloak", false, expectedItemId = "next", expectedWorn = false))
    }

    @Test fun `a worn item absent from the catalogue cannot supply a guessed comparison`() {
        val data = inventory().copy(catalog = inventory().catalog.filter { it.id != "old" })
        val item = gearLiveProjection(state(data), "vex", "cloak", false).gear.selectedItem!!
        assertTrue(item.lines.all { it.tone == DeltaTone.UNKNOWN })
        assertTrue(item.lines.all { it.delta == "…" })
    }
}
