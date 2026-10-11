package gg.pixelkingdomwars.nativeclient.ui.roster

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.data.ArmyRepository
import gg.pixelkingdomwars.nativeclient.data.BaseRepository
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.ContentRepository
import gg.pixelkingdomwars.nativeclient.model.Hero
import gg.pixelkingdomwars.nativeclient.model.ItemDefinition
import gg.pixelkingdomwars.nativeclient.ops.InterruptedIntent
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.ReceiptObserver
import gg.pixelkingdomwars.nativeclient.ui.InterruptedActions
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** Inventory bag filter (web inventory.tsx `Tab`). */
enum class BagTab(val label: String) { ALL("ALL"), GEAR("GEAR"), CONSUMABLE("CONSUMABLE"), RELIC("RELIC"), DEED("DEED"), COSMETIC("COSMETIC") }
enum class BagPane { EQUIPMENT, BACKPACK }
enum class ShopKind(val label: String) { ALL("ALL"), GEAR("GEAR"), CONSUMABLE("CONSUMABLE") }

data class RosterUiState(
    val domain: ArmyDomainState = ArmyDomainState(),
    val home: BaseState = BaseState(),
    val interrupted: List<InterruptedIntent> = emptyList(),
    val catalogue: JsonObject? = null,
    val ordersAllowed: Boolean = true,
    val selectedHero: String = "vex",
    val selectedItemId: String? = null,
    val bagTab: BagTab = BagTab.ALL,
    val bagPane: BagPane = BagPane.BACKPACK,
    val shopKind: ShopKind = ShopKind.ALL,
) {
    val heroesBlocked: Boolean get() = interrupted.any { (it.kind == IntentKind.HERO_UPGRADE || it.kind == IntentKind.HERO_RECOVERY) && it.blocking }
    val itemsBlocked: Boolean get() = interrupted.any { (it.kind == IntentKind.ITEM_BUY || it.kind == IntentKind.ITEM_USE) && it.blocking }
    fun hero(key: String): Hero? = domain.heroes?.heroes?.firstOrNull { it.hero == key }
    /** Inventory answers "what do I own?": an unowned catalogue entry never becomes a bag cube; deeds are appended read-only. */
    val bagItems: List<ItemDefinition> get() {
        val inventory = domain.inventory ?: return emptyList()
        val owned = inventory.catalog.filter { inventory.quantity(it.id) > 0 }
        val deeds = inventory.deeds.mapNotNull { deed -> deed.id?.let { ItemDefinition(it, deed.name, "deed", rarity = "legendary", weight = 0, costKeep = "0", asset = deed.asset,
            desc = "${deed.status.orEmpty().uppercase()} STABLE LAND · $it", acquisition = gg.pixelkingdomwars.nativeclient.model.ItemAcquisition("drop"), maxOwned = 1) } }
        return owned + deeds
    }
    val visibleBagItems: List<ItemDefinition> get() = bagItems.filter { bagTab == BagTab.ALL || it.kind == bagTab.name.lowercase() }
    val selectedItem: ItemDefinition? get() = bagItems.firstOrNull { it.id == selectedItemId }
    fun isDeed(id: String): Boolean = domain.inventory?.deeds?.any { it.id == id } == true
    /** Purchase choices (web shopCatalog.tsx): drop-only and forge-drop items are never for sale. */
    val purchasable: List<ItemDefinition> get() = domain.inventory?.catalog.orEmpty().filter { !it.dropOnly && it.acquisition?.type != "drop" }
    val shopKinds: List<ShopKind> get() = listOf(ShopKind.GEAR, ShopKind.CONSUMABLE).filter { kind -> purchasable.any { it.kind == kind.name.lowercase() } }
    val visibleShopItems: List<ItemDefinition> get() = purchasable.filter { shopKind == ShopKind.ALL || it.kind == shopKind.name.lowercase() }
}

/** Heroes, inventory, shop and codex over the army repository. Every paid action is a money operation the
 * repository owns; this model only routes taps and keeps the presentation selection. */
class RosterViewModel(private val army: ArmyRepository, private val base: BaseRepository, content: ContentRepository, observer: ReceiptObserver,
                      private val actions: InterruptedActions?, private val versionCode: Int) : ScreenViewModel() {
    constructor(graph: AppGraph, session: SessionGraph) : this(session.army, session.base, graph.content, session.observer, null, graph.versionCode) { fallback = interruptedActions(session) }
    private var fallback: InterruptedActions? = null
    private val selection = MutableStateFlow(RosterUiState())
    val state: StateFlow<RosterUiState> = combine(army.state, base.state, observer.interrupted, content.state, selection) { domain, home, interrupted, content, selection ->
        selection.copy(domain = domain, home = home, interrupted = interrupted, catalogue = content.catalogue, ordersAllowed = content.allowsGameOrders(versionCode))
    }.stateIn(viewModelScope, SharingStarted.Eagerly, RosterUiState())
    val interrupted: InterruptedActions get() = actions ?: requireNotNull(fallback)

    init {
        // A sold or fully used item leaves the detail pane (web: the selection follows the owned set).
        viewModelScope.launch { army.state.map { it.inventory }.collect { inventory ->
            val selected = selection.value.selectedItemId ?: return@collect
            if (inventory != null && inventory.quantity(selected) <= 0 && inventory.deeds.none { it.id == selected }) selection.update { it.copy(selectedItemId = null) }
        } }
    }
    fun loadHeroes() = run { army.refreshHeroes() }
    fun reviewHeroUpgrade(hero: String) = orders { army.reviewHeroUpgrade(hero) }
    fun reviewHeroRecovery(hero: String) = orders { army.reviewHeroRecovery(hero) }
    fun confirmHeroSpend() = orders { army.confirmHeroSpend() }
    fun dismissHeroReview() { army.dismissHeroReview() }
    fun loadInventory() = run { army.refreshInventory() }
    fun loadShop() = run { base.refresh(); army.refreshInventory() }
    fun loadArmy() = run { army.refreshArmy() }
    fun upgradeHero(hero: String, level: Int, costKeep: String, confirmedBaseId: String? = state.value.domain.heroesBaseId) = orders {
        requireHeroConfirmationBase(confirmedBaseId)
        army.upgradeHero(hero, level, costKeep)
    }
    fun recoverHero(hero: String, costKeep: String, recoveryUntil: String, confirmedBaseId: String? = state.value.domain.heroesBaseId) = orders {
        requireHeroConfirmationBase(confirmedBaseId)
        army.recoverHero(hero, costKeep, recoveryUntil)
    }
    private fun requireHeroConfirmationBase(confirmedBaseId: String?) {
        check(confirmedBaseId == state.value.domain.heroesBaseId) { "The selected base changed. Review your hero again." }
    }
    fun buy(itemId: String) = orders { army.buyItem(itemId) }
    fun use(itemId: String) = orders { army.useItem(itemId) }
    fun equip(itemId: String) = orders {
        val current = state.value
        val inventory = requireNotNull(current.domain.inventory) { "Open your inventory first" }
        val item = requireNotNull(inventory.item(itemId)) { "Unknown item" }
        val slot = requireNotNull(item.slot?.takeIf { item.kind == "gear" }) { "This item is not gear" }
        val loadout = requireNotNull(inventory.loadout(current.selectedHero)) { "Unknown hero" }
        val desired = if (loadout.equipment[slot] == itemId) null else itemId
        army.equip(current.selectedHero, slot, desired, loadout.version)
    }
    fun selectHero(hero: String) { selection.update { it.copy(selectedHero = hero, selectedItemId = null) } }
    fun selectItem(id: String?) {
        selection.update { it.copy(selectedItemId = if (it.selectedItemId == id) null else id) }
        val chosen = selection.value.selectedItemId ?: return
        val inventory = state.value.domain.inventory ?: return
        if (!state.value.isDeed(chosen) && !inventory.seen(chosen)) viewModelScope.launch { runCatching { army.markItemSeen(chosen) } }
    }
    fun setBagTab(tab: BagTab) { selection.update { it.copy(bagTab = tab) } }
    fun setBagPane(pane: BagPane) { selection.update { it.copy(bagPane = pane) } }
    fun setShopKind(kind: ShopKind) { selection.update { it.copy(shopKind = kind) } }
    fun clearNotice() { army.clearNotice(); dismissNotice() }
    private fun orders(block: suspend () -> Unit) = run {
        check(state.value.ordersAllowed) { "Install the available native app update before submitting game orders. Your account is preserved." }
        block()
    }
}
