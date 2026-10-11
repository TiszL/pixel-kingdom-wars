package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.KingdomPanel
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.KingdomPanelActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.KingdomPanelUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.KingdomSheetKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.KingdomDoor
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.keptKingdomPanel
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.kingdomPanelUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.lookCloserCommand
import kotlinx.coroutines.delay

/**
 * The designed kingdom sheet (map-base, SPEC §2.3) over the parcel read the old base card drew: the realm map's card and
 * the globe's PARCEL panel. It replaces `ParcelCardBody` on the user path; every action is an existing entry point:
 * SCOUT [WorldViewModel.scout], ATTACK [WorldViewModel.attack], GO HOME [onOpenBase], MANAGE DEED [onOpenBases], CHOOSE
 * THIS LAND [WorldViewModel.draftLand], CHOOSE LAND [onOpenLand], RETRY [WorldViewModel.retryParcel], NEXT OPEN DEED
 * [onNextOpen] (choose mode), LOOK CLOSER [onLookCloser] (the realm map). No new action owner and no new server call; a
 * refused command explains itself through the app toast.
 *
 * Routine refresh: a re-read of the same deed keeps the kingdom already shown, its commands BUSY, until the read lands
 * ([keptKingdomPanel]); it never falls back to the silhouette. The shield tag counts down from the read's own
 * `remainingMs` on a one-second tick while the screen is started. [onHeight] reports the sheet's measured height in dp.
 * Draws nothing when no deed is selected.
 */
@Composable internal fun WorldParcelSheet(model: WorldViewModel, current: WorldUiState, selectedBaseId: String?, busy: Boolean,
    columns: Int, rows: Int, realmName: String?, silhouette: RealmHudBase?, onOpenLand: () -> Unit, onOpenBases: () -> Unit,
    onOpenBase: (String) -> Unit, onClose: () -> Unit, onNextOpen: (() -> Unit)?, onLookCloser: (() -> Unit)?, onHeight: (Float) -> Unit,
    modifier: Modifier = Modifier) {
    val tileId = current.selectedTileId ?: return
    var now by remember { mutableLongStateOf(System.nanoTime()) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(tileId, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { while (true) { now = System.nanoTime(); delay(1_000) } }
    }
    val fresh = kingdomPanelUi(current, columns, rows, realmName, silhouette, busy, model::keepPortrait, model::claimTiles, now,
        choose = onNextOpen != null) ?: return
    // The last kingdom drawn for this deed, as this base sees it (actions are per viewing base).
    val kept = remember(tileId, selectedBaseId) { KeptKingdom() }
    SideEffect { if (fresh.kind == KingdomSheetKind.RIVAL || fresh.kind == KingdomSheetKind.OWN) kept.ui = fresh }
    val held = keptKingdomPanel(fresh, kept.ui)
    val ui = if (onLookCloser != null && held.secondary == null && held.kind != KingdomSheetKind.OWN)
        held.copy(secondary = lookCloserCommand(kingdom = held.kind == KingdomSheetKind.RIVAL || silhouette != null)) else held
    var infoOpen by remember(tileId) { mutableStateOf(false) }
    val own = current.globe?.me?.ownedTiles?.firstOrNull { it.tileId == tileId }
    fun open(command: CommandUi?) {
        when (KingdomDoor.of(command)) {
            KingdomDoor.SCOUT -> model.scout()
            KingdomDoor.ATTACK -> model.attack()
            KingdomDoor.GO_HOME -> if (own != null) onOpenBase(own.baseId) else onOpenBases()
            KingdomDoor.MANAGE_DEED -> onOpenBases()
            KingdomDoor.CHOOSE_THIS_LAND -> model.draftLand(onOpenLand)
            KingdomDoor.CHOOSE_LAND -> onOpenLand()
            KingdomDoor.RETRY -> model.retryParcel()
            KingdomDoor.NEXT_OPEN_DEED -> onNextOpen?.invoke()
            KingdomDoor.LOOK_CLOSER -> onLookCloser?.invoke()
            null -> Unit
        }
    }
    val density = LocalDensity.current
    KingdomPanel(ui, KingdomPanelActions(
        onScout = { model.scout() },
        onAttack = { model.attack() },
        onInfo = { infoOpen = !infoOpen },
        onPrimary = { open(ui.primary) },
        onSecondary = { open(ui.secondary) },
        onExplain = { reason -> Toasts.post(reason) },
        onClose = onClose,
    ), infoOpen, modifier.onSizeChanged { size -> onHeight(with(density) { size.height.toDp().value }) }.padding(horizontal = 4.dp))
}

/** The last RIVAL or OWN sheet drawn for one deed (written after composition, read by [keptKingdomPanel]). */
private class KeptKingdom { var ui: KingdomPanelUi? = null }
