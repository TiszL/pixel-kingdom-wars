package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay

/*
 * Design component: the map Search drawer (design/final/map/SPEC.md §2.4, map-search.png): a WoodFrame dropping from the
 * top (x 8 to 404, height = content up to the keyboard), the cream query field (magnifier 26, VT 24 query, VT 18 hint)
 * with the red close, and the parchment results: SPOTS / KINGDOMS sections (max 3 rows each, a stone "More" row), each
 * row a 52 dp IngredientRow with its art well, VT 20 name, VT 18 place line and a blue GO 58 × 46. Empty query: "Recent";
 * no hits: "Nothing called 'x'"; loading: dots in the field's corner; error: a danger line + RETRY. On an island the
 * drawer is pre-scoped to spot numbers (numeric keyboard).
 */

/** What a search row points at. */
enum class SearchKind { SPOT, KINGDOM, PLAYER }

/** One result row (SPEC §2.4 `SearchRowUi`; the destination stays on the data side, keyed by [id]). */
@Immutable data class SearchRowUi(
    val id: String,
    val kind: SearchKind,
    /** The well art: a spot sprite, or the kingdom's own base thumbnail. */
    val icon: String,
    /** "Spot 42" / "Kinmar". */
    val title: String,
    /** "Seeker Island · King" / "Frostveil · LV 12". */
    val sub: String,
)

/** One results section (SPEC §2.4): SPOTS / KINGDOMS / RECENT. */
@Immutable data class SearchSectionUi(val title: String, val rows: List<SearchRowUi>, val more: Boolean = false,
    /** Stable expansion key; existing callers continue using the title. */
    val id: String = title)

/** Everything the search drawer draws (SPEC §2.4 `SearchUi`). */
@Immutable data class MapSearchUi(
    val query: String,
    /** A search is running: dots in the field's corner (never a blank list). */
    val busy: Boolean,
    /** Results (or "RECENT" for an empty query; up to 5). */
    val sections: List<SearchSectionUi>,
    /** The search failed: the inline line + RETRY. */
    val error: String? = null,
    /** The island scope: spot numbers only, numeric keyboard. */
    val spotsOnly: Boolean = false,
)

/** Search drawer callbacks (SPEC §2.4). */
@Immutable data class MapSearchActions(
    /** Every keystroke (the field shows [MapSearchUi.query]). */
    val onQuery: (String) -> Unit = {},
    /** The debounced search (250 ms after the last keystroke, or the IME search key). */
    val onSearch: (String) -> Unit = {},
    /** GO on a row: close the drawer and fly the camera (a spot opens its island scene with it selected). */
    val onGo: (SearchRowUi) -> Unit = {},
    /** A section's "More" row, keyed by [SearchSectionUi.id] (the title unless supplied). */
    val onMore: (String) -> Unit = {},
    val onRetry: () -> Unit = {},
    /** Close, the scrim tap and Back. */
    val onClose: () -> Unit = {},
)

/** SPEC §2.4: the query is searched 250 ms after the last keystroke. */
const val SEARCH_DEBOUNCE_MS = 250L

/**
 * The map Search drawer (SPEC §2.4).
 *
 * Pointer rule: the drawer is modal, so it carries the 40 % [ModalScrim] — compose this drawer ONLY while it is open;
 * the scrim then exists only while shown, and a tap on it closes (never confirms). The wood frame is a painted panel.
 */
@Composable fun MapSearchDrawer(ui: MapSearchUi, on: MapSearchActions, modifier: Modifier = Modifier,
    /** The source owns debounce through onQuery; this drawer must not issue a second search, including from the IME. */
    searchManagedExternally: Boolean = false,
    /** Expanded sections show all rows already supplied by the source; this never starts another read. */
    expandedSections: Set<String> = emptySet(),
    /** A source without completion provenance can describe the empty response without claiming there are no matches. */
    emptyMessage: String? = null,
    /** Describes only the search kinds supported by this source; null retains the shared drawer's default hint. */
    queryHint: String? = null) {
    val search by rememberUpdatedState(on.onSearch)
    LaunchedEffect(ui.query, searchManagedExternally) {
        if (searchManagedExternally || ui.query.isBlank()) return@LaunchedEffect
        delay(SEARCH_DEBOUNCE_MS)
        search(ui.query)
    }
    Box(modifier.fillMaxSize()) {
        ModalScrim(PkwTokens.Scrim.SHEET_TALL, on.onClose)
        Plate(PlateKind.WOOD, Modifier.windowInsetsPadding(WindowInsets.safeDrawing.union(WindowInsets.ime))
            .padding(start = 8.dp, top = 8.dp, end = 8.dp).fillMaxWidth()) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    QueryField(ui, on, Modifier.weight(1f), searchManagedExternally, queryHint)
                    CloseSquare(on.onClose, contentDescription = "Close search")
                }
                Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth().heightIn(max = 420.dp), contentPadding = PaddingValues(10.dp), blocksScene = false) {
                    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Results(ui, on, expandedSections, emptyMessage)
                    }
                }
            }
        }
    }
}

/** The cream query field 52 tall: magnifier 26, VT 24 query with a caret, VT 18 hint on the right, dots while busy. */
@Composable private fun QueryField(ui: MapSearchUi, on: MapSearchActions, modifier: Modifier, searchManagedExternally: Boolean,
    queryHint: String?) {
    val hint = queryHint ?: if (ui.spotsOnly) "spot no." else "name, spot no."
    Row(modifier.heightIn(min = 52.dp).background(PkwTokens.Colors.cream).border(2.dp, PkwTokens.Colors.ink).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        MagnifierGlyph(26.dp, tint = PkwTokens.Colors.textOnParch)
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            BasicTextField(ui.query, on.onQuery, Modifier.fillMaxWidth().semantics { contentDescription = "Search $hint" },
                textStyle = PkwTokens.Type.lead.copy(color = PkwTokens.Colors.textOnParch), singleLine = true,
                cursorBrush = SolidColor(PkwTokens.Colors.textOnParch),
                keyboardOptions = KeyboardOptions(keyboardType = if (ui.spotsOnly) KeyboardType.Number else KeyboardType.Text, imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { if (!searchManagedExternally) on.onSearch(ui.query) }))
        }
        if (ui.busy) BusyDots()
        else if (ui.query.isEmpty()) PkwText(hint, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    }
}

@Composable private fun Results(ui: MapSearchUi, on: MapSearchActions, expandedSections: Set<String>, emptyMessage: String?) {
    val error = ui.error
    if (error != null) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwText(error, PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.shortText, maxLines = 2)
            SecondaryButton("RETRY", on.onRetry, verb = Verb.BLUE)
        }
        return
    }
    if (ui.sections.all { it.rows.isEmpty() } && ui.query.isNotBlank() && !ui.busy) {
        EmptyState(EmptyStateUi("shape:unknown", emptyMessage ?: "Nothing called '${ui.query}'",
            if (emptyMessage != null) "Try another search." else "Try a kingdom name or a spot number.", null, null), onGo = {})
        return
    }
    ui.sections.filter { it.rows.isNotEmpty() }.forEach { section ->
        MapSectionHeader(section.title)
        val expanded = section.id in expandedSections
        val limit = if (ui.query.isBlank()) 5 else 3
        (if (expanded) section.rows else section.rows.take(limit)).forEach { row ->
            MapRow(description = "${row.title}. ${row.sub}") {
                ArtWell(44.dp, if (row.kind == SearchKind.SPOT) MapColors.seekerWell else MapColors.snowWell) { MapIcon(row.icon, 40.dp) }
                RowText(row.title, row.sub)
                GoButton({ on.onGo(row) }, "Go to ${row.title}", Modifier.size(58.dp, 48.dp))
            }
        }
        if (!expanded && (section.more || section.rows.size > limit)) SecondaryButton("More", { on.onMore(section.id) }, Modifier.fillMaxWidth().heightIn(min = 44.dp),
            contentDescription = "More ${section.title.lowercase()}")
    }
}

// ---- Previews ----

private val spots = SearchSectionUi("SPOTS", listOf(SearchRowUi("seeker/42", SearchKind.SPOT, "site:seeker-occupied", "Spot 42", "Seeker Island · you were outbid"),
    SearchRowUi("seeker/7", SearchKind.SPOT, "site:seeker-active", "Spot 7", "Seeker Island · King")))
private val kingdoms = SearchSectionUi("KINGDOMS", listOf(SearchRowUi("k1", SearchKind.KINGDOM, "ui_portrait_keep_t3", "Kinmar", "Frostveil · LV 12"),
    SearchRowUi("k2", SearchKind.KINGDOM, "ui_portrait_keep_t2", "Kaly", "Frostveil · LV 8"),
    SearchRowUi("k3", SearchKind.KINGDOM, "ui_portrait_keep_t4", "Milisdor", "Frostveil · LV 17")), more = true)

@Composable private fun Host(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.bg)) { content() }
}

@Preview(name = "Results (map-search)", widthDp = 412, heightDp = 915)
@Composable private fun SearchResultsPreview() { Host { MapSearchDrawer(MapSearchUi("k", false, listOf(spots, kingdoms)), MapSearchActions()) } }

@Preview(name = "Busy / no hits / error / island scope", widthDp = 412, heightDp = 915)
@Composable private fun SearchStatesPreview() {
    Host {
        Column {
            MapSearchDrawer(MapSearchUi("4", true, emptyList(), spotsOnly = true), MapSearchActions(), Modifier.heightIn(max = 220.dp))
            MapSearchDrawer(MapSearchUi("zzz", false, emptyList()), MapSearchActions(), Modifier.heightIn(max = 300.dp))
            MapSearchDrawer(MapSearchUi("k", false, emptyList(), error = "Search didn't answer."), MapSearchActions(), Modifier.heightIn(max = 220.dp))
        }
    }
}
