package gg.pixelkingdomwars.nativeclient.ui.kingdom

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState

/*
 * buildings/SPEC.md §1.2 item 6 and selected.png: the hint pill "Tap the <name> again to open it" (VT 20, ink 86 %, 38 dp
 * above the shelf) for the first three selections per install. The command bar already draws CommandBarUi.hint
 * (CommandBar.kt InfoPill) and its layout already makes room for it; until now nothing ever set it.
 */

/** How many selections per install show the hint (SPEC §1.2 item 6). */
internal const val SELECTION_HINT_LIMIT = 3

/**
 * The hint for a bar whose primary is a door that tap 2 opens: null when there is no enabled primary, or when the primary
 * acts in place (COLLECT, REARM: tap 2 spends or collects, it opens nothing), so the pill never promises the wrong thing.
 */
internal fun selectionHintLine(plateName: String?, bar: CommandBarUi?): String? {
    val primary = bar?.commands?.lastOrNull { it.primary } ?: return null
    if (primary.state != CommandState.ENABLED) return null
    if (primary.id == BuildingCommandIds.COLLECT || primary.id == BuildingCommandIds.REARM) return null
    // The Lodge / Workshop / Harvester COLLECT swaps keep their own ids; their caption still says what tap 2 does.
    if (primary.caption.uppercase() in IN_PLACE_CAPTIONS) return null
    val name = plateName?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
    return "Tap the $name again to open it"
}

private val IN_PLACE_CAPTIONS = setOf("COLLECT", "REARM")

/** Whether a new selection still earns the hint after [shown] selections already showed it. */
internal fun selectionHintDue(shown: Int): Boolean = shown < SELECTION_HINT_LIMIT

private const val HINT_PREFS = "pkw_home_hints"
private const val HINT_SHOWN_KEY = "selection_hints_shown"

/**
 * The hint to draw for the selection [selectionId] (the [line] from [selectionHintLine]), counted once per new selection
 * and remembered per install. The selection keeps its pill while it lasts (an INFO sheet and back does not count again);
 * after [SELECTION_HINT_LIMIT] selections it never shows. Reads the count once; writes are asynchronous (`apply`).
 */
@Composable internal fun rememberSelectionHint(selectionId: String?, line: String?): String? {
    val context = LocalContext.current
    val prefs = remember(context) { runCatching { context.getSharedPreferences(HINT_PREFS, Context.MODE_PRIVATE) }.getOrNull() }
    var shown by remember(prefs) { mutableIntStateOf(prefs?.let { runCatching { it.getInt(HINT_SHOWN_KEY, 0) }.getOrNull() } ?: SELECTION_HINT_LIMIT) }
    var hintFor by remember { mutableStateOf<String?>(null) }
    val hasLine = line != null
    LaunchedEffect(selectionId, hasLine) {
        when {
            selectionId == null -> hintFor = null
            hasLine && hintFor != selectionId && selectionHintDue(shown) -> {
                hintFor = selectionId
                shown += 1
                runCatching { prefs?.edit()?.putInt(HINT_SHOWN_KEY, shown)?.apply() }
            }
            else -> Unit
        }
    }
    return line?.takeIf { selectionId != null && selectionId == hintFor }
}
