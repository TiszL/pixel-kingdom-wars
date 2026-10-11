package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.EquipmentState
import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingRepository
import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingState
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterViewModel
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.KeepStoresActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.KeepStoresSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.KeepStoresUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.StoresTab
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/*
 * Keep STORES mounted in place (buildings/SPEC.md E1.1, keep-stores.png; Keep selected -> STORES): the designed tall
 * sheet over the existing inventory owners. Reads are GET-only: RosterViewModel.loadInventory (`GET /items`) once per
 * resume, and the ordinary-crafting owner's guarded refresh (skipped while it is busy or holds a review). USE is the
 * Inventory screen's own one-tap RosterViewModel.use; nothing here sells, trades, signs or pays. Every other door is a
 * GO the caller routes ([onGo]).
 */

/** What [LiveKeepStoresHost] does with a group's destination button: route its GO, or say why there is none. */
internal fun storesGroupGo(ui: KeepStoresUi, groupId: String): FeatureId? = ui.groups.firstOrNull { it.id == groupId }?.go

/** What a tap on the CHECK row does: a new read, unless one is running (then the player is told, never ignored). */
internal const val STORES_STILL_CHECKING = "The Keep is still checking your stores. Try again in a moment."

/** A USE dropped because another army request is still finishing (ScreenViewModel runs one at a time). */
internal const val STORES_USE_WAIT = "Another request is still finishing. Try again in a moment."

/**
 * The Keep STORES host. [roster] is the existing inventory owner (its inventory, its order gate, its USE); [crafting]
 * and [equipment] are the MATERIALS / KITS owners when the caller has them (null shows those tabs as not checked);
 * [keepLevel] and [baseId] come from the current base. [onGo] receives every GO (group buttons, the footer GO, empty-state
 * GOs); [onClose] closes the sheet (red close, Back, the scrim). The stone History square is drawn only when
 * [onHistory] is given.
 */
@Composable internal fun LiveKeepStoresHost(
    roster: RosterViewModel,
    crafting: OrdinaryCraftingRepository?,
    equipment: StateFlow<EquipmentState>?,
    keepLevel: Int?,
    baseId: String?,
    onGo: (FeatureId) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    onHistory: (() -> Unit)? = null,
    initialTab: StoresTab = StoresTab.BAG,
) {
    val state by roster.state.collectAsState()
    val craftState = crafting?.state?.collectAsState()?.value
    val equipState = equipment?.collectAsState()?.value
    var tab by rememberSaveable { mutableStateOf(initialTab) }
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    var usingId by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    var reading by remember { mutableStateOf(true) }
    var failed by remember { mutableStateOf(false) }
    var lastGoodAt by remember { mutableStateOf<Long?>(null) }
    // The crafting owner clears its view while it refreshes: keep the last view so counts never blank (a view of
    // another wallet or kingdom is still refused by the mapper).
    val heldCrafting = remember { HeldStores() }
    if (craftState?.view != null) heldCrafting.crafting = craftState
    val previous = remember { HeldStores() }
    val scope = rememberCoroutineScope()

    BackHandlerAt(BackPriority.SHEET) { onClose() }

    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle, refresh) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            reading = true
            val read = try { readStores(roster, crafting) } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { false }
            reading = false
            when (read) {
                true -> { failed = false; lastGoodAt = System.currentTimeMillis() }
                false -> { failed = true; Toasts.post(STORES_READ_FAILED, error = true) }
                // Another army request took the owner first: nothing was read and nothing failed; CHECK reads again.
                null -> Unit
            }
        }
    }

    val wallet = craftState?.journal?.identity?.wallet ?: equipState?.journal?.identity?.wallet
    val sources = KeepStoresSources(
        keepLevel = keepLevel,
        inventory = state.domain.inventory,
        crafting = craftState?.takeIf { it.view != null } ?: heldCrafting.crafting,
        equipment = equipState,
        wallet = wallet,
        baseId = baseId,
        ordersAllowed = state.ordersAllowed,
        itemsBlocked = state.itemsBlocked,
        loading = reading || state.domain.loading,
        error = if (failed) STORES_READ_FAILED else null,
    )
    val ui = keepStoresUi(sources, tab, selectedId, usingId, previous.ui,
        if (failed) storesAgo(System.currentTimeMillis(), lastGoodAt) else null).copy(history = onHistory != null)
    previous.ui = ui

    fun use(itemId: String) {
        val job = roster.use(itemId)
        if (job == null) { Toasts.post(STORES_USE_WAIT); return }
        usingId = itemId
        scope.launch {
            try { job.join() } finally { usingId = null }
            // The owner turns a refusal into its notice; say it here, where the player pressed USE.
            roster.notice.value?.takeIf { it.error }?.let { Toasts.post(it.message, error = true); roster.dismissNotice() }
        }
    }

    val actions = KeepStoresActions(
        onTab = { next -> tab = next; selectedId = null },
        onItem = { id ->
            selectedId = id
            // The Inventory screen's own selection clears the NEW marker (best effort, its owner's call).
            val inventory = state.domain.inventory
            if (inventory != null && inventory.quantity(id) > 0 && roster.state.value.selectedItemId != id) roster.selectItem(id)
        },
        onUse = { id, _ -> use(id) },
        onGo = onGo,
        onGroupGo = { groupId -> storesGroupGo(ui, groupId)?.let(onGo) ?: Toasts.post("Nothing to open for this group yet.") },
        onHistory = { onHistory?.invoke() },
        onClose = onClose,
        onCheck = { if (reading) Toasts.post(STORES_STILL_CHECKING) else refresh++ },
        onRefused = { refused -> Toasts.post(refused.reason ?: ui.readOnly ?: "This item can't be used from the Keep.") },
    )
    LiveTallSheetHost(onScrimTap = onClose, modifier = modifier) { placed ->
        KeepStoresSheet(ui, actions, placed)
    }
}

/** Plain holders (not snapshot state): remembering the last drawn view must not schedule another composition. */
private class HeldStores {
    var ui: KeepStoresUi? = null
    var crafting: OrdinaryCraftingState? = null
}

/**
 * One GET-only read of the stores: the inventory through its owner (after any action it is finishing), then the
 * crafting view when its owner is idle with no review (otherwise the last good view stays). False when either read
 * failed (the caller keeps the last good view and shows the stale row); null when the owner was taken by another
 * request before this read could start.
 */
private suspend fun readStores(roster: RosterViewModel, crafting: OrdinaryCraftingRepository?): Boolean? {
    roster.busy.first { !it }
    val job = roster.loadInventory() ?: return null
    job.join()
    // ScreenViewModel turns the owner's failure into an error notice; that read is this one's answer.
    if (roster.notice.value?.error == true) return false
    val owner = crafting ?: return true
    val now = owner.state.value
    if (now.busy || now.review != null) return true
    owner.refresh()
    return true
}
