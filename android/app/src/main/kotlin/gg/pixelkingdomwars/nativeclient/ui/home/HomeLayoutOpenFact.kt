package gg.pixelkingdomwars.nativeclient.ui.home

import android.annotation.SuppressLint
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import gg.pixelkingdomwars.nativeclient.ui.layout.LayoutEditorState
import gg.pixelkingdomwars.nativeclient.ui.layout.LayoutEditorViewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/** The one layout-editor fact the Home shell reads: whether the editor is open. */
@Immutable internal data class LayoutOpenFact(val open: Boolean)

/** [LayoutOpenFact] of each editor state, emitted only when it changes. The editor state combines the base, content,
 *  interrupted-request, interlock and draft flows, so it changes on every drag step and every Home read; the shell that
 *  collected all of it recomposed whole (every Home door, the HUD binding, the sheet hosts) for each of those. */
internal fun layoutOpenFacts(states: Flow<LayoutEditorState>): Flow<LayoutOpenFact> =
    states.map { LayoutOpenFact(it.open) }.distinctUntilChanged()

/** Collects only [LayoutOpenFact] from [layout]: the shell recomposes when the editor opens or closes, never per edit. */
@Composable internal fun rememberLayoutOpenFact(layout: LayoutEditorViewModel): State<LayoutOpenFact> {
    val facts = remember(layout) { layoutOpenFacts(layout.state) }
    @SuppressLint("StateFlowValueCalledInComposition") // Deliberate: initial value only; collecting the editor state would undo fc9b810d (recompose on open/close, never per edit).
    val initial = LayoutOpenFact(layout.state.value.open)
    return facts.collectAsState(initial)
}
