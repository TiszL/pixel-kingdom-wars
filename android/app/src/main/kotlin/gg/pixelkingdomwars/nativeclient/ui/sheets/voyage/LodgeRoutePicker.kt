package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.PixelShapes
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Lodge › SEND › CHOOSE AN ISLAND (design/final/voyage/route-picker.png, SPEC §4): the 32 archipelago
 * islands as a realm × grade grid, with filter chips (ALL / CAN SAIL / HOME), the grade header ("needs T2+", blue
 * "T3+ in 1h") and per-tile states (available, selected, my trip away / back, locked by tier, locked by permit). It
 * replaces SEND's panel content in place (a 120 ms cross-fade owned by [LodgeSheet]); header and tabs stay.
 *
 * States: loading (tiles from the local catalogue at once; counts "…"), art missing (that realm's tiles show "Island art
 * loading" + one RETRY pill), empty filter ("No islands match" + ALL). The realm-to-island mapping is the server's
 * `PHASE_E_ORDINARY_ROUTES`; the PNG's mapping is illustrative (SPEC §4 mapping note).
 *
 * Pointer rule: only the back square, chips, tiles and the RETRY pill take touches; the grid's gaps are not targets.
 * The SheetFrame body already scrolls, so realm blocks are plain rows (a LazyColumn cannot nest in it).
 */

/** Everything the picker draws (SPEC §4 Data `LodgePickerUi`; added fields after `filter`). */
@Immutable data class LodgePickerUi(
    /** All 32 islands; grouped and ordered by [realmBlocks]. */
    val routes: List<RouteUi>,
    /** The player's home realm (its block comes first). */
    val homeRealmId: String?,
    /** The best docked vehicle tier; null = none docked (every tile is tier-locked). */
    val bestDockedTier: Int?,
    /** Tier → that tier's soonest return, formatted ("1h"), for vehicles away. */
    val awayTierReturn: Map<Int, String>,
    /** The active filter. */
    val filter: RouteFilter,
    /** Added: the currently chosen island (gold frame + ✓). */
    val selectedRouteId: String? = null,
    /** Added: the catalogue is still loading: counts and tags show "…". */
    val loading: Boolean = false,
    /** Added: a chain atlas failed to load: one "Island pictures didn't load · RETRY" pill at the top. */
    val artRetry: Boolean = false,
)

/** The picker's callbacks (SPEC §4 Callbacks). */
@Immutable data class LodgePickerActions(
    /** Back to SEND. */
    val onBack: () -> Unit = {},
    val onFilter: (RouteFilter) -> Unit = {},
    /** An available or selected tile: choose it and go back to SEND. */
    val onPickRoute: (routeId: String) -> Unit = {},
    /** A tier- or permit-locked tile: the caller toasts the reason ("Needs a Tier 3 vehicle. Upgrade at the Berth ▸"). */
    val onLockedTile: (routeId: String) -> Unit = {},
    /** A tile with my trip: AWAY opens TRIPS at it; BACK collects. */
    val onTripTile: (tripId: String) -> Unit = {},
    /** The art RETRY pill. */
    val onArtRetry: () -> Unit = {},
)

/**
 * True only when a LOADED picker has nothing to show for its filter ("No islands match" + ALL). A loading picker never
 * says that: SPEC §4 loading draws the tiles from the local catalogue at once, and with no catalogue yet it draws a
 * skeleton, because "No islands match" would tell the player the archipelago is empty.
 */
internal fun pickerShowsEmpty(ui: LodgePickerUi, shown: List<RouteUi>): Boolean = !ui.loading && shown.isEmpty()

/** The picker body (SPEC §4 layout). It has no footer: a tile tap chooses. */
@Composable fun ColumnScope.LodgeRoutePickerBody(ui: LodgePickerUi, on: LodgePickerActions) {
    val c = PkwTokens.Colors
    // SPEC §0.5: a refreshing panel shows the 2 dp stone line under the tabs, never a spinner page.
    RefreshLine(ui.loading)
    BackTitleRow("CHOOSE AN ISLAND", "Tap one to sail there", on.onBack, "Back to send")
    if (ui.artRetry) {
        VoyageRow(rim = c.blood) {
            PkwText("Island pictures didn't load", PkwTokens.Type.body, Modifier.weight(1f).padding(start = 6.dp), color = c.textOnParch)
            SecondaryButton("RETRY", on.onArtRetry, Modifier.padding(end = 2.dp), contentDescription = "Retry island pictures")
        }
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        RouteFilter.entries.forEach { f ->
            val label = when (f) { RouteFilter.ALL -> "ALL"; RouteFilter.CAN_SAIL -> "CAN SAIL"; RouteFilter.HOME -> "HOME" }
            val count = filterCount(ui.routes, f, ui.bestDockedTier, ui.loading)
            ChoiceChip("$label $count", ui.filter == f, { on.onFilter(f) }, description = "$label, $count islands")
        }
    }
    // The grade header: one column per grade over the tile columns. route-picker.html: a grade the best docked vehicle
    // reaches has an ink numeral, the rest ink-2; the blue line marks a tier that is away.
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        (1..4).forEach { g ->
            val (line, away) = gradeHeaderLine(g, ui.bestDockedTier, ui.awayTierReturn)
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                PkwText(gradeNumeral(g), PkwTokens.Type.label, color = if (ui.bestDockedTier != null && ui.bestDockedTier >= g) c.textOnParch else c.textOnParch2)
                PkwText(if (ui.loading) UNKNOWN else line, PkwTokens.Type.small, color = if (away && !ui.loading) c.blue.lo else c.textOnParch2)
            }
        }
    }
    val shown = filterRoutes(ui.routes, ui.filter, ui.bestDockedTier)
    if (pickerShowsEmpty(ui, shown)) {
        Column(Modifier.fillMaxWidth().padding(vertical = 16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwIcon("ui:lodge-menu", 64.dp, alpha = 0.4f)
            PkwText("No islands match", PkwTokens.Type.body, color = c.textOnParch, textAlign = TextAlign.Center)
            ChoiceChip("ALL", false, { on.onFilter(RouteFilter.ALL) }, description = "Show all islands")
        }
        return
    }
    if (shown.isEmpty()) {
        // Loading with no catalogue yet: skeleton blocks (sea wells with their grade tags), never an empty verdict.
        repeat(2) { SkeletonRealmBlock() }
        return
    }
    realmBlocks(shown, ui.homeRealmId).forEach { block ->
        RealmRow(block, ui.loading)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            (1..4).forEach { g ->
                val route = block.routes.firstOrNull { it.grade == g }
                Box(Modifier.weight(1f).aspectRatio(1f)) {
                    if (route != null) IslandTile(route, islandTileState(route, ui.bestDockedTier, ui.selectedRouteId), on,
                        awayHint = gradeHeaderLine(g, ui.bestDockedTier, ui.awayTierReturn).second, loading = ui.loading)
                }
            }
        }
    }
}

/** A realm row (32 tall): the raw-resource icon, realm · resource, and the HOME / PERMIT tag ("…" while [loading]:
 *  the access is not known until the home realm is). */
@Composable private fun RealmRow(block: RealmBlock, loading: Boolean) {
    val c = PkwTokens.Colors
    Row(Modifier.fillMaxWidth().heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (block.resourceIcon.isNotBlank()) VoyageIcon(block.resourceIcon, 32.dp)
        PkwText(block.realmName, PkwTokens.Type.body, color = c.textOnParch)
        PkwText("· ${block.resourceName}", PkwTokens.Type.small, Modifier.weight(1f), color = c.textOnParch2)
        if (loading) Tag(UNKNOWN, Verb.STONE) else AccessTag(block.access)
    }
}

/** A first-load skeleton realm block: a "…" realm row and four sea wells with their stone grade tags. Paint only. */
@Composable private fun SkeletonRealmBlock() {
    val c = PkwTokens.Colors
    Row(Modifier.fillMaxWidth().heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically) {
        PkwText(UNKNOWN, PkwTokens.Type.body, color = c.textOnParch2)
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        (1..4).forEach { g ->
            Box(Modifier.weight(1f).aspectRatio(1f)) {
                SeaWell(Modifier.fillMaxSize(), waves = g)
                Tag(gradeNumeral(g), Verb.STONE, Modifier.align(Alignment.TopStart).padding(2.dp))
                PkwText(UNKNOWN, PkwTokens.Type.body, Modifier.align(Alignment.Center), color = c.muted)
            }
        }
    }
}

/**
 * One 84 dp island tile: 2 dp ink rim, the route card, the stone grade tag top-left, and the state overlay. Press scales
 * 0.96 in 60 ms; choosing flashes the gold frame twice (2 × 120 ms) before the caller cross-fades back to SEND.
 * [awayHint]: a vehicle of this grade's tier is away (route-picker.html paints the padlock's "T3" blue-hi then);
 * [loading]: the PERMIT tag reads "…" until the home realm is known.
 */
@Composable private fun IslandTile(route: RouteUi, state: IslandTileState, on: LodgePickerActions, awayHint: Boolean = false, loading: Boolean = false) {
    val c = PkwTokens.Colors
    val reduced = LocalReducedMotion.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed && !reduced) 0.96f else 1f, tween(PkwTokens.Motion.PRESS), label = "tile")
    val flash = remember { Animatable(0f) }
    LaunchedEffect(state) {
        if (state == IslandTileState.SELECTED && !reduced) repeat(2) {
            flash.animateTo(1f, tween(PkwTokens.Motion.SNAP_HINT / 2)); flash.animateTo(0f, tween(PkwTokens.Motion.SNAP_HINT / 2))
        }
    }
    val tripId = route.myTrip?.tripId
    val tap: () -> Unit = {
        when (state) {
            IslandTileState.AVAILABLE, IslandTileState.SELECTED -> on.onPickRoute(route.routeId)
            IslandTileState.MY_TRIP_AWAY, IslandTileState.MY_TRIP_BACK -> tripId?.let(on.onTripTile)
            IslandTileState.LOCKED_TIER, IslandTileState.LOCKED_PERMIT -> on.onLockedTile(route.routeId)
        }
    }
    val spoken = listOfNotNull(route.displayName, "${route.realmName}, Grade ${gradeNumeral(route.grade)}", when (state) {
        IslandTileState.SELECTED -> "selected"
        IslandTileState.MY_TRIP_AWAY -> "your vehicle is there"
        IslandTileState.MY_TRIP_BACK -> "your vehicle is back, tap to collect"
        IslandTileState.LOCKED_TIER -> "needs a Tier ${route.grade} vehicle"
        IslandTileState.LOCKED_PERMIT -> route.permitReason ?: "needs a permit"
        IslandTileState.AVAILABLE -> null
    }).joinToString(". ")
    val selected = state == IslandTileState.SELECTED
    Box(Modifier.fillMaxSize().graphicsLayer { scaleX = scale; scaleY = scale }
        .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; this.selected = selected; onClick(label = null, action = { tap(); true }) }
        .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = tap)) {
        SeaWell(Modifier.fillMaxSize()) {
            LocalVoyageArt.current.routeCard(route, Modifier.fillMaxSize().lockedArt(state == IslandTileState.LOCKED_TIER || state == IslandTileState.LOCKED_PERMIT))
        }
        if (selected) Box(Modifier.fillMaxSize().border(3.dp, c.gold.face.copy(alpha = 1f - 0.6f * flash.value), PixelShapes.S))
        Tag(gradeNumeral(route.grade), Verb.STONE, Modifier.align(Alignment.TopStart).padding(2.dp))
        when (state) {
            IslandTileState.SELECTED -> CheckBadge(Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp))
            // route-picker.html `.st`: the state tag sits in a 22 dp band on the tile's bottom edge.
            IslandTileState.MY_TRIP_AWAY -> Tag("AWAY", Verb.BLUE, Modifier.align(Alignment.BottomCenter).padding(bottom = 1.dp))
            IslandTileState.MY_TRIP_BACK -> Tag("BACK", Verb.GREEN, Modifier.align(Alignment.BottomCenter).padding(bottom = 1.dp))
            IslandTileState.LOCKED_TIER -> Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                PkwIcon("shape:lock", 24.dp, tint = c.gold.face)
                PkwText("T${route.grade}", PkwTokens.Type.caption, color = if (awayHint) c.blue.hi else c.label, outline = 1.dp)
            }
            IslandTileState.LOCKED_PERMIT -> if (loading) Tag(UNKNOWN, Verb.STONE, Modifier.align(Alignment.BottomCenter).padding(bottom = 1.dp))
                else Tag("PERMIT", Verb.BLUE, Modifier.align(Alignment.BottomCenter).padding(bottom = 1.dp))
            IslandTileState.AVAILABLE -> Unit
        }
    }
}

/** Preview data shared by the Lodge previews: four realms of the 32 (the real mapping is the server's). */
internal fun previewRoutes(): List<RouteUi> {
    val realms = listOf(
        listOf("elderwood", "Elderwood", "glasswake", "Glasswake Keys", "voyage:heartwood-logs", "Heartwood Logs", "heartwood_logs"),
        listOf("cinderfall", "Cinderfall", "emberwake", "Emberwake Isles", "voyage:ember-nodules", "Ember Nodules", "ember_nodules"),
        listOf("frostveil", "Frostveil", "rimeholm", "Rimeholm Shoals", "voyage:frost-quartz", "Frost Quartz", "frost_quartz"),
        // SPEC E1.1: the eighth realm's display name is "Solana Reach" everywhere (the round-1 PNG's "Seeker Reach" is old).
        listOf("seeker-reach", "Solana Reach", "prismdeep", "Prismdeep", "voyage:rough-prism", "Rough Prism", "rough_prism"),
    )
    return realms.flatMapIndexed { r, row ->
        (1..4).map { g ->
            RouteUi("${row[2]}-$g", row[2], g - 1, "${row[3]} $g", row[0], row[1], row[6], g, if (r == 0) Access.HOME else Access.PAID_REALM,
                if (r == 1 && g == 1) TripRef("t-ember", TripState.AT_SEA) else null, row[4], row[5])
        }
    }
}
