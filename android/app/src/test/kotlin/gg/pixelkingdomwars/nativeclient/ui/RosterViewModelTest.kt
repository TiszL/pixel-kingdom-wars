package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.model.HeroRoster
import gg.pixelkingdomwars.nativeclient.model.Inventory
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.roster.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Heroes / inventory / shop presentation over the fake army repository (web heroes.tsx, inventory.tsx,
 * shopCatalog.tsx): what is shown comes from GET /items and GET /heroes, every paid tap is routed to the
 * repository with the row's own price, and interrupted money intents block the matching screen. */
@OptIn(ExperimentalCoroutinesApi::class)
class RosterViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private val actions = InterruptedActions({}, {}, {})
    private val inventory = Inventory.from(json("""{"catalogRevision":2,"heroGearCombatEnabled":true,
        "catalog":[{"id":"keg_of_haste","name":"KEG OF HASTE","kind":"consumable","costKeep":60,"asset":"a","desc":"d","rarity":"common","weight":1,"acquisition":{"type":"shop"},"maxOwned":null},
            {"id":"wardens_helm","name":"WARDEN'S HELM","kind":"gear","slot":"helm","costKeep":0,"asset":"h","desc":"d","rarity":"rare","weight":4,"acquisition":{"type":"drop"},"maxOwned":2,"modifiers":[{"stat":"hero_hp_bps","value":600}]},
            {"id":"item_hero_vex","name":"HERO CONTRACT: VEX","kind":"consumable","costKeep":3000,"asset":"v","desc":"d","rarity":"epic","weight":2,"acquisition":{"type":"keep_level","keepLevel":5},"maxOwned":1,"activation":{"kind":"hero","active":false,"availableContracts":0}},
            {"id":"warzone_aegis","name":"WARZONE AEGIS","kind":"consumable","costKeep":8000,"dropOnly":true,"asset":"s","desc":"d","rarity":"legendary","weight":3,"acquisition":{"type":"drop"},"maxOwned":null}],
        "owned":[{"itemId":"keg_of_haste","qty":2},{"itemId":"wardens_helm","qty":1},{"itemId":"warzone_aegis","qty":1}],"discovery":[{"itemId":"keg_of_haste","seenAt":"2026-09-11T00:00:00Z"}],
        "capacity":{"used":9,"max":160,"overflow":false},
        "heroLoadouts":[{"hero":"vex","recruited":true,"level":3,"recoveryUntil":null,"available":true,"version":2,"equipment":{"helm":"wardens_helm"},"modifiers":{"hero_hp_bps":600},"setBonus":{"id":"warden","pieces":1,"required":9,"active":false},"baseStats":{"hp":1605,"basicDamage":108,"skillDamageSeed":108},"effectiveStats":{"hp":1701,"basicDamage":108,"skillDamageSeed":108}},
            {"hero":"theodor","recruited":false,"level":1,"recoveryUntil":null,"available":true,"version":0,"equipment":{},"modifiers":{},"setBonus":{"id":"warden","pieces":0,"required":9,"active":false},"baseStats":{"hp":4200,"basicDamage":38,"skillDamageSeed":38},"effectiveStats":{"hp":4200,"basicDamage":38,"skillDamageSeed":38}}],
        "deeds":[{"id":"DEED1","baseId":"$BASE_ID","name":"EARTH LAND DEED · KEEP 1","kind":"deed","asset":"itm_deed_earth","status":"active"}]}"""))
    private fun model(army: FakeArmyRepository, observer: ReceiptObserver = ReceiptObserver(PendingIntentStore(MemoryStore()))) =
        RosterViewModel(army, FakeBaseRepository(), FakeContentRepository(json("""{"constants":{"GEAR_SLOTS":["helm","chest"]}}""")), observer, actions, versionCode = 1)

    @Test fun `the bag shows owned items and deeds only and the shop hides forge drops`() {
        val army = FakeArmyRepository(); army._state.value = ArmyDomainState(inventory = inventory)
        val m = model(army)
        assertEquals(listOf("keg_of_haste", "wardens_helm", "warzone_aegis", "DEED1"), m.state.value.bagItems.map { it.id })
        m.setBagTab(BagTab.GEAR); assertEquals(listOf("wardens_helm"), m.state.value.visibleBagItems.map { it.id })
        m.setBagTab(BagTab.DEED); assertEquals(listOf("DEED1"), m.state.value.visibleBagItems.map { it.id }); assertTrue(m.state.value.isDeed("DEED1"))
        assertEquals("The unowned hero contract is a shop card, the aegis and the helm are never sold", listOf("keg_of_haste", "item_hero_vex"), m.state.value.purchasable.map { it.id })
        assertEquals("A single kind for sale needs no tab row", listOf(ShopKind.CONSUMABLE), m.state.value.shopKinds)
        assertEquals("One worn copy leaves no stored copy to sell or equip elsewhere", 0, inventory.stored("wardens_helm")); assertEquals(1, inventory.equippedCount("wardens_helm"))
    }
    @Test fun `selecting an unseen item clears its NEW marker and the selection follows the owned set`() {
        val army = FakeArmyRepository(); army._state.value = ArmyDomainState(inventory = inventory)
        val m = model(army)
        m.selectItem("wardens_helm"); assertEquals("wardens_helm", m.state.value.selectedItemId); assertEquals("seen:wardens_helm", army.calls.last())
        m.selectItem("keg_of_haste"); assertFalse("An already-seen item is not re-marked", army.calls.contains("seen:keg_of_haste"))
        m.selectItem("DEED1"); assertFalse("Deeds carry no discovery row", army.calls.contains("seen:DEED1"))
        m.selectItem("DEED1"); assertNull("A second tap closes the detail", m.state.value.selectedItemId)
        m.selectItem("keg_of_haste")
        army._state.value = ArmyDomainState(inventory = Inventory.from(json("""{"catalog":[],"owned":[],"capacity":{"used":0,"max":160},"heroLoadouts":[],"deeds":[]}""")))
        assertNull("A used-up item leaves the detail pane", m.state.value.selectedItemId)
    }
    @Test fun `equip toggles the selected hero's slot with the loadout version and paid taps carry the row price`() {
        val army = FakeArmyRepository(); army._state.value = ArmyDomainState(inventory = inventory)
        val m = model(army)
        m.equip("wardens_helm"); assertEquals("The worn copy unequips", "equip:vex:helm:null:2", army.calls.last())
        m.selectHero("theodor"); m.equip("wardens_helm"); assertEquals("equip:theodor:helm:wardens_helm:0", army.calls.last())
        m.equip("keg_of_haste"); assertTrue(m.notice.value!!.error); assertTrue(m.notice.value!!.message.contains("not gear"))
        m.use("keg_of_haste"); assertEquals("use:keg_of_haste", army.calls.last())
        m.buy("item_hero_vex"); assertEquals("buy:item_hero_vex", army.calls.last())
        m.upgradeHero("vex", 4, "14500"); assertEquals("upgrade:vex:4:14500", army.calls.last())
        m.recoverHero("vex", "7", "2026-09-11T10:00:00.000Z"); assertEquals("recover:vex:7:2026-09-11T10:00:00.000Z", army.calls.last())
    }
    @Test fun `hero confirmation cannot spend on a different base after the roster rehydrates`() {
        val army = FakeArmyRepository()
        army._state.value = ArmyDomainState(heroesBaseId = BASE_ID)
        val m = model(army)
        val confirmedBase = m.state.value.domain.heroesBaseId
        army._state.value = army._state.value.copy(heroesBaseId = "22222222-2222-4222-8222-222222222222")
        m.upgradeHero("vex", 2, "2500", confirmedBase)
        assertTrue(m.notice.value!!.message.contains("base changed"))
        m.recoverHero("vex", "7", "2026-09-11T10:00:00.000Z", confirmedBase)
        assertTrue("Even identical hero prices on the new base do not reuse old consent", army.calls.isEmpty())
    }
    @Test fun `interrupted hero or item intents block their screens and a retired build blocks orders`() {
        val store = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(store)
        store.create(ItemUseSpec.intent(WALLET, BASE_ID, "keg_of_haste", "key-1-0000", "KEG").copy(attempted = true))
        store.create(HeroUpgradeSpec.intent(WALLET, BASE_ID, "vex", "key-2-0000", 2, "2500").copy(attempted = true))
        kotlinx.coroutines.runBlocking { observer.refresh(WALLET) }
        val army = FakeArmyRepository(); army._state.value = ArmyDomainState(inventory = inventory, heroes = HeroRoster.from(json("""{"heroes":[]}""")))
        val m = model(army, observer)
        assertTrue(m.state.value.itemsBlocked); assertTrue(m.state.value.heroesBlocked)
        val gated = RosterViewModel(army, FakeBaseRepository(), FakeContentRepository(minimumBuild = 2), observer, actions, versionCode = 1)
        gated.buy("keg_of_haste"); assertTrue(gated.notice.value!!.message.contains("update")); assertFalse(army.calls.contains("buy:keg_of_haste"))
    }
    @Test fun `Hero review is separate from payment and background dismiss never retries a command`() {
        val fake = FakeArmyRepository()
        val calls = mutableListOf<String>()
        val army = object : gg.pixelkingdomwars.nativeclient.data.ArmyRepository by fake {
            override suspend fun reviewHeroUpgrade(hero: String) { calls += "review-upgrade:$hero" }
            override suspend fun reviewHeroRecovery(hero: String) { calls += "review-recovery:$hero" }
            override suspend fun confirmHeroSpend() { calls += "confirm" }
            override fun dismissHeroReview() { calls += "dismiss" }
        }
        val m = RosterViewModel(army, FakeBaseRepository(), FakeContentRepository(), ReceiptObserver(PendingIntentStore(MemoryStore())), actions, 1)
        m.reviewHeroUpgrade("vex")
        m.reviewHeroRecovery("theodor")
        assertEquals(listOf("review-upgrade:vex", "review-recovery:theodor"), calls)
        assertTrue("Reviews must not route through legacy KEEP spends", fake.calls.isEmpty())
        m.dismissHeroReview()
        assertEquals("dismiss", calls.last())
        m.confirmHeroSpend()
        assertEquals("confirm", calls.last())
    }
    @Test fun `retired client cannot review or confirm Hero currencies but can dismiss unsent consent`() {
        val fake = FakeArmyRepository()
        var calls = 0
        val army = object : gg.pixelkingdomwars.nativeclient.data.ArmyRepository by fake {
            override suspend fun reviewHeroUpgrade(hero: String) { calls++ }
            override suspend fun confirmHeroSpend() { calls++ }
            override fun dismissHeroReview() { calls++ }
        }
        val m = RosterViewModel(army, FakeBaseRepository(), FakeContentRepository(minimumBuild = 2), ReceiptObserver(PendingIntentStore(MemoryStore())), actions, 1)
        m.reviewHeroUpgrade("vex"); m.confirmHeroSpend()
        assertEquals(0, calls)
        assertTrue(m.notice.value!!.message.contains("update"))
        m.dismissHeroReview()
        assertEquals(1, calls)
    }
    @Test fun `recovery labels and modifier copy match the web helpers`() {
        val now = java.time.Instant.parse("2026-09-11T00:00:00Z").toEpochMilli()
        assertNull(heroRecoveryLabel("2026-09-11T00:10:00Z", now, available = true))
        assertEquals("RECOVERING · 10M", heroRecoveryLabel("2026-09-11T00:10:00Z", now, available = false))
        assertEquals("RECOVERING · VERIFYING", heroRecoveryLabel("2026-09-10T00:00:00Z", now, available = false)); assertEquals("RECOVERING · VERIFYING", heroRecoveryLabel(null, now, available = false))
        assertEquals("HERO HP +6%", modifierLabel("hero_hp_bps", 600)); assertEquals("INCOMING DAMAGE −8%", modifierLabel("incoming_damage_reduction_bps", 800))
        assertEquals("MOVE SPEED −5%", modifierLabel("move_speed_bps", -500)); assertEquals("FIRST HIT −2.5%", modifierLabel("first_hit_reduction_bps", 250))
    }
}
