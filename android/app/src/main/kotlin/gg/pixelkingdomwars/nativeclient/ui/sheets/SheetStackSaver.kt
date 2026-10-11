package gg.pixelkingdomwars.nativeclient.ui.sheets

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable

/** The sole saved representation is scoped navigation text; no live owner or consent is retained. */
fun homeSheetStacksSaver(scope: SheetScope): Saver<HomeSheetStacks, String> = Saver(
    save = { stacks -> stacks.takeIf { it.scope == scope }?.save() },
    restore = { saved -> HomeSheetStacks.restore(saved, scope) },
)

/**
 * HomeShell supplies the authenticated session generation, selected base, and current selection
 * generation. Input changes synchronously replace live history; restored data is separately checked
 * by the saver, because rememberSaveable inputs alone do not validate process-restored state.
 *
 * Mount once above the two Home tabs and pass the active stack down. Do not render a retained value
 * from a prior scope or use a callback captured before the account/selection changed. No effect in
 * this helper reads a repository, opens a destination, requests a wallet, or restores confirmation.
 */
@Composable
fun rememberHomeSheetStacks(scope: SheetScope): MutableState<HomeSheetStacks> {
    val saver = remember(scope) { homeSheetStacksSaver(scope) }
    return rememberSaveable(scope, stateSaver = saver) { mutableStateOf(HomeSheetStacks(scope)) }
}
