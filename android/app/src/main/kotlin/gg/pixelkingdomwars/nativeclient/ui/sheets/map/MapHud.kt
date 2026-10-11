package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.ResourceStack
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.drawChunky
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.plateContentPadding
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.roundToInt

/*
 * Design component: the map HUD (design/final/map/SPEC.md §1 shared map chrome, map-globe.png, map-realm.png): the top
 * bar (HOME, title plate, search, the Home ResourceStack unchanged), the right thumb column (zoom + / −, ME), the left
 * ModeButton (tap cycles EXPLORE › WARZONE › KINGDOMS, long press names all three), the bottom band (FilterChips in
 * KINGDOMS mode on a realm, the RealmRail with the three special islands first), the island PlaceLabels, the trip
 * markers (≤ 3), the YOU plate and selection octagon, and the two notice pills (art failed + RETRY; empty filter / failed
 * realm read). The globe / realm renderer is NOT here: it is the scene below.
 *
 * World anchors: labels, markers, the YOU plate and the ring sit where the renderer projects them. The renderer hands
 * the HUD an [anchor] lookup (dp from the HUD's top-left; null = off-screen). It is read in the layout / draw phase only,
 * so a spinning globe relayouts the anchored pieces without recomposing the HUD.
 */

/** Which map screen the HUD dresses (SPEC §2.1 / §2.2). */
enum class MapScreen { WORLD, REALM }

/** A point on the HUD in dp from its top-left (after the safe-drawing inset), as the renderer projected it. */
@Immutable data class ScreenPoint(val xDp: Float, val yDp: Float)

/** One RealmRail tile (SPEC §2.1 `RailTileUi`; the YOU / LIVE plate is [tag], a count is [badge]). */
@Immutable data class RailTileUi(
    /** "seeker", "solana", "divine" or a realm id. */
    val id: String,
    /** The thumbnail art; null draws the caption's initial (realm thumbnails are not authored yet, SPEC §9). */
    val icon: String?,
    /** The caption under the tile ("Solana Reach"). */
    val caption: String,
    /** A red count (Divine trial ready). */
    val badge: BadgeUi? = null,
    /** The plate on the tile's top edge: red "LIVE" on Seeker (never on fixture data), gold "YOU" on your realm. */
    val tag: MapTagUi? = null,
    /** True on your home realm. */
    val home: Boolean = false,
)

/** One filter chip (SPEC §2.2 `FilterChipUi`; the dot is a verb colour; BIDS has two). */
@Immutable data class FilterChipUi(
    /** "all", "mine", "unshielded", "lvl". */
    val id: String,
    /** "ALL", "MINE", "NO SHIELD", "LV 5–12". */
    val label: String,
    /** The count as the server gave it; "…" while unknown, never 0 (an empty string draws no count, for LV). */
    val count: String,
    /** True when this filter is active. */
    val on: Boolean,
    /** The legend dots (gold for MINE on a realm). */
    val dots: List<Verb> = emptyList(),
)

/** One island PlaceLabel (SPEC §1.5): it replaces the globe's own island name at the same anchor. */
@Immutable data class PlaceLabelUi(
    /** "seeker", "solana", "divine" (the [anchor] key). */
    val id: String,
    /** The 32 dp `*-navigation` icon. */
    val icon: String,
    /** "SEEKER". */
    val name: String,
    /** The tag under the chip (red "LIVE 14h"); null when the feature is off or the data is a fixture. */
    val tag: MapTagUi? = null,
    /** True while the island's panel is open: gold-hi rim, the tag moves into the sheet. */
    val selected: Boolean = false,
)

/** A trip marker's kind (SPEC §1.5). */
enum class MarkerKind { UNDER_WAY, RETURNED }

/** One trip marker on an archipelago island (SPEC §2.1 `MapMarkerUi`). Order them nearest first; ≤ 3 are drawn. */
@Immutable data class MapMarkerUi(
    /** "<chain>/<slot>" (the [anchor] key). */
    val islandId: String,
    val kind: MarkerKind,
    /** "1h 20m"; "…" while unknown. */
    val timeLeft: String?,
    /** 0..1 of the trip done; null draws an empty meter. */
    val progress: Float?,
    /** What a screen reader says ("Survey Balloon to Aurora Isle 2, back in 1 hour 20 minutes"). */
    val description: String,
)

/** A notice pill: text and an optional blue action ("RETRY", "ALL"). */
@Immutable data class MapPillUi(val id: String, val text: String, val actionLabel: String? = null)

/** Your kingdom's gold plate on the realm map (SPEC §2.2): "YOU · 3h" with a shield when shielded. */
@Immutable data class YouPlateUi(val text: String, val shielded: Boolean)

/** Everything the map HUD draws (SPEC §2.1 `MapHudUi`, adapted: positions come from the anchor lookup). */
@Immutable data class MapHudUi(
    val screen: MapScreen,
    val mode: MapMode,
    /** "WORLD" or the realm name. */
    val title: String,
    /** "8 realms · 3 islands" / "3,150 kingdoms here" ("…" while unknown). */
    val subtitle: String,
    /** The Home ResourceStack rows, unchanged (≤ 4: SHARDS, GEMS, KEEP when a wallet is linked, SKR + caret). */
    val resources: List<ResourceChipUi>,
    val rail: List<RailTileUi>,
    /** The active rail tile id. */
    val railSelected: String?,
    /** Empty unless KINGDOMS mode on a realm. */
    val chips: List<FilterChipUi> = emptyList(),
    val placeLabels: List<PlaceLabelUi> = emptyList(),
    /** Nearest first; at most three draw. */
    val markers: List<MapMarkerUi> = emptyList(),
    /** True while a map half sheet is open: rail, chips, mode and the thumb column slide away (the top bar stays). */
    val panelOpen: Boolean = false,
    /** The pill under the top bar ("Island art didn't load" + RETRY, IS-N4). */
    val topPill: MapPillUi? = null,
    /** The pill above the band ("No kingdoms match" + ALL, "Couldn't load kingdoms" + RETRY). */
    val bandPill: MapPillUi? = null,
    /** Your plate on the realm map (anchor key "you"); null when your base is not on this map. */
    val you: YouPlateUi? = null,
    /** The selection octagon's radius in dp (anchor key "ring"); null draws no ring. */
    val ringRadiusDp: Float? = null,
    /** True while a Seal shows: the stack stays readable but is not a touch target. */
    val sealShown: Boolean = false,
    /** The HOME medallion's keep portrait. */
    val homeIcon: String = "ui_portrait_keep_t3",
    /** False when the current host has no admitted resource destination; rows remain truthful and readable. */
    val resourcesEnabled: Boolean = true,
)

/** Map HUD callbacks (SPEC §2.1, §2.2 callbacks). */
@Immutable data class MapHudActions(
    val onHome: () -> Unit = {},
    val onSearch: () -> Unit = {},
    /** +1 / −1. */
    val onZoom: (Int) -> Unit = {},
    val onMe: () -> Unit = {},
    val onMode: () -> Unit = {},
    val onModeLong: () -> Unit = {},
    val onRail: (String) -> Unit = {},
    val onChip: (String) -> Unit = {},
    /** An island label: its panel. */
    val onPlace: (String) -> Unit = {},
    /** A trip marker: the archipelago panel for that island. */
    val onMarker: (String) -> Unit = {},
    /** A ResourceStack row: the resource drawer at that row. */
    val onResourceRow: (FeatureId) -> Unit = {},
    /** A pill's action, by pill id. */
    val onPill: (String) -> Unit = {},
)

/**
 * The map HUD (SPEC §1, §2.1, §2.2).
 *
 * Pointer rule: the root is a plain full-screen [Box] with NO clickable, pointerInput, draggable or scrim, so empty HUD
 * space lets touches fall through to the globe / realm scene below (pan, pinch, tap a realm or a base). Only the painted
 * pieces take touches: HOME, the title-less search, the ResourceStack, zoom / ME, the ModeButton, the rail strip, the
 * chips, the place labels, the trip markers and the pill actions. The YOU plate and the selection ring are paint only.
 *
 * [anchor] maps "seeker" / "solana" / "divine", a marker's islandId, "you" and "ring" to their projected position.
 */
@Composable fun MapHud(ui: MapHudUi, on: MapHudActions, modifier: Modifier = Modifier, anchor: (String) -> ScreenPoint? = { null }) {
    MapHud(ui, on, railArt = null, modifier = modifier, anchor = anchor)
}

/**
 * Optional authored rail art, drawn inside the existing 80 × 60 well. A null slot keeps the icon/initial fallback.
 * [onChromeBounds] reports painted chrome in dp relative to this HUD's outer bounds, before its safe-drawing inset.
 * These are label/framing obstacles only; reporting them does not change scene input handling.
 * The original overload remains so existing positional and trailing-lambda anchor calls keep their meaning.
 */
@Composable fun MapHud(ui: MapHudUi, on: MapHudActions, railArt: (@Composable BoxScope.(RailTileUi) -> Unit)?,
    modifier: Modifier = Modifier, onChromeBounds: (List<Rect>) -> Unit = {}, anchor: (String) -> ScreenPoint? = { null }) {
    val reduced = LocalReducedMotion.current
    val currentAnchor by rememberUpdatedState(anchor)
    val reportBounds by rememberUpdatedState(onChromeBounds)
    val density = LocalDensity.current.density
    val bounds = remember { mutableStateMapOf<String, Rect>() }
    var rootBounds by remember { mutableStateOf<Rect?>(null) }
    val measure: (String, Rect?) -> Unit = remember {
        { id, rect ->
            if (rect == null) bounds.remove(id) else bounds[id] = rect
            Unit
        }
    }
    val root = rootBounds
    val chrome = if (root == null) emptyList() else bounds.toSortedMap().values.mapNotNull { rect ->
        val clipped = rect.intersect(root)
        if (clipped.isEmpty) null else Rect((clipped.left - root.left) / density, (clipped.top - root.top) / density,
            (clipped.right - root.left) / density, (clipped.bottom - root.top) / density)
    }
    SideEffect { reportBounds(chrome) }
    DisposableEffect(Unit) { onDispose { reportBounds(emptyList()) } }
    Box(modifier.fillMaxSize().onGloballyPositioned { rootBounds = it.boundsInRoot() }) {
        BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
            val compactTop = mapTopBarCompact(maxWidth.value)
            val short = maxHeight < 480.dp
            val topPillTop = maxOf(if (compactTop) 134f else 80f, 16f + 28f * minOf(4, ui.resources.size)).dp
            // World-anchored paint first (under the bar): ring, YOU plate, labels, markers.
            if (ui.ringRadiusDp != null) {
                val radius = ui.ringRadiusDp
                Box(Modifier.fillMaxSize().drawBehind {
                    currentAnchor("ring")?.let { p -> drawOctagonRing(p.xDp.dp.toPx(), p.yDp.dp.toPx(), radius.dp.toPx()) }
                })
            }
            ui.you?.let { YouPlate(it, Modifier.anchoredAt("you", currentAnchor, 0.5f, 1f)) }
            ui.placeLabels.forEach { label ->
                PlaceLabel(label, { on.onPlace(label.id) }, Modifier.anchoredAt(label.id, currentAnchor, 0.5f, 0.5f))
            }
            capMarkers(ui.markers) { true }.forEach { m ->
                TripMarker(m, { on.onMarker(m.islandId) }, Modifier.anchoredAt(m.islandId, currentAnchor, 0.5f, 1f))
            }

            MapTopBar(ui.title, ui.subtitle, back = false, onBackOrHome = on.onHome, homeIcon = ui.homeIcon, onSearch = on.onSearch,
                resources = ui.resources, onResourceRow = on.onResourceRow, sealShown = ui.sealShown || !ui.resourcesEnabled, compact = compactTop, onBounds = measure,
                tight = mapTopBarTight(maxWidth.value))
            ui.topPill?.let { MapPill(it, on.onPill, Modifier.align(Alignment.TopStart).padding(start = 8.dp, top = topPillTop)
                .mapChromeBounds("top-pill", measure)) }

            // A short landscape keeps the rail at the bottom and the camera's middle clear of a tall control stack.
            if (short) {
                val modeTop = topPillTop +
                    if (ui.topPill == null) 0.dp else ((bounds["top-pill"]?.height?.div(density) ?: 48f) + 8f).dp
                AnimatedVisibility(!ui.panelOpen, modifier = Modifier.align(Alignment.TopStart).padding(start = 8.dp, top = modeTop),
                    enter = bandEnter(reduced), exit = bandExit(reduced)) {
                    ModeButton(ui.mode, on.onMode, on.onModeLong, Modifier.mapChromeBounds("mode", measure))
                }
                val thumbTop = maxOf(if (compactTop) 134f else 80f, 16f + 28f * ui.resources.size).dp
                AnimatedVisibility(!ui.panelOpen, modifier = Modifier.align(Alignment.TopEnd).padding(end = 8.dp, top = thumbTop),
                    enter = bandEnter(reduced), exit = bandExit(reduced)) {
                    ThumbRow(on.onZoom, on.onMe, Modifier.mapChromeBounds("thumb", measure))
                }
            }

            Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
                ui.bandPill?.let {
                    Box(Modifier.fillMaxWidth().padding(bottom = 8.dp), contentAlignment = Alignment.Center) {
                        MapPill(it, on.onPill, Modifier.mapChromeBounds("band-pill", measure))
                    }
                }
                AnimatedVisibility(!ui.panelOpen, enter = bandEnter(reduced), exit = bandExit(reduced)) {
                    Column(Modifier.fillMaxWidth()) {
                        if (!short) Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.Bottom) {
                            ModeButton(ui.mode, on.onMode, on.onModeLong, Modifier.mapChromeBounds("mode", measure))
                            Spacer(Modifier.weight(1f))
                            ThumbColumn(onZoom = on.onZoom, onMe = on.onMe, me = true, modifier = Modifier.mapChromeBounds("thumb", measure))
                        }
                        if (ui.chips.isNotEmpty()) {
                            if (!short) Spacer(Modifier.height(14.dp))
                            FilterChipRow(ui.chips, on.onChip, Modifier.padding(horizontal = 8.dp).mapChromeBounds("filters", measure))
                            Spacer(Modifier.height(if (short) 6.dp else 12.dp))
                        } else if (!short) Spacer(Modifier.height(54.dp))
                        RealmRailContent(ui.rail, ui.railSelected, on.onRail, railArt, Modifier.mapChromeBounds("rail", measure))
                        Spacer(Modifier.height(7.dp))
                    }
                }
            }
        }
    }
}

/**
 * Whether the title plate drops to its own row under HOME and search. At 412 dp the 56 dp HOME, 160 dp title, 52 dp search,
 * 108 dp stack and their gaps fit on one row; c-gap-map: the Seeker (1200 px at 3.0 = 400 dp) keeps the designed one-row bar
 * too, with 4 dp gaps ([mapTopBarTight]): the title plate gets width − 244 dp (8 + 56 + 4, 4 + 52, 4 + 108 + 8) and, inside
 * its 5 dp insets, holds "8 realms · 3 islands" (20 VT323 glyphs of 7.2 dp = 144 dp) from 398 dp up. Narrower, the title
 * would be cut, so it takes its own row.
 */
internal fun mapTopBarCompact(widthDp: Float): Boolean = widthDp < MAP_TOP_BAR_ONE_ROW_MIN

/** The narrowest width (dp) at which the one-row map bar holds the WORLD sub-line uncut ([mapTopBarCompact]). */
internal const val MAP_TOP_BAR_ONE_ROW_MIN = 398f

/** The one-row bar narrower than the frames' 412 dp: 4 dp gaps instead of 6 and a 5 dp plate inset, so the title keeps room. */
internal fun mapTopBarTight(widthDp: Float): Boolean = widthDp < 412f

/** Reports this painted region only; transparent positioning hosts never become framing obstacles. */
private fun Modifier.mapChromeBounds(id: String, onBounds: (String, Rect?) -> Unit): Modifier = composed {
    DisposableEffect(id, onBounds) { onDispose { onBounds(id, null) } }
    onGloballyPositioned { onBounds(id, it.boundsInRoot()) }
}

internal fun bandEnter(reduced: Boolean) = if (reduced) fadeIn(tween(PkwTokens.Motion.REDUCED_CROSSFADE))
    else slideInVertically(tween(PkwTokens.Motion.PLATE_IN, easing = PkwTokens.Motion.Out)) { it } + fadeIn(tween(PkwTokens.Motion.PLATE_IN))

internal fun bandExit(reduced: Boolean) = if (reduced) fadeOut(tween(PkwTokens.Motion.REDUCED_CROSSFADE))
    else slideOutVertically(tween(PkwTokens.Motion.PLATE_IN, easing = PkwTokens.Motion.In)) { it } + fadeOut(tween(PkwTokens.Motion.PLATE_IN))

/**
 * Places a piece so its pivot ([px], [py] as fractions of its own size) sits on the anchor of [key]; off-screen anchors
 * place it far outside the HUD, where it is neither painted on screen nor hit. Put it FIRST in the modifier chain so the
 * piece's own touch / semantics modifiers move with it. The anchor is read in the layout phase only.
 */
internal fun Modifier.anchoredAt(key: String, anchor: (String) -> ScreenPoint?, px: Float, py: Float): Modifier = layout { measurable, constraints ->
    val p = measurable.measure(constraints.copy(minWidth = 0, minHeight = 0))
    layout(p.width, p.height) {
        val a = anchor(key)
        if (a == null) p.place(-100_000, -100_000)
        else p.place((a.xDp.dp.toPx() - p.width * px).roundToInt(), (a.yDp.dp.toPx() - p.height * py).roundToInt())
    }
}

// ---- Top bar (SPEC §1.1) ----

/**
 * The map top bar (SPEC §1.1): HOME (or BACK "MAP" on island scenes, blue 56 × 58), the charcoal title plate (title PS 13
 * gold-hi + VT 18 sub-line), the stone search 52 × 54 (not on island scenes) and the Home ResourceStack at the right.
 * Paint and buttons only; the bar's empty space is not a touch target.
 */
@Composable internal fun MapTopBar(title: String, subtitle: String, back: Boolean, onBackOrHome: () -> Unit, homeIcon: String,
    onSearch: (() -> Unit)?, resources: List<ResourceChipUi>, onResourceRow: (FeatureId) -> Unit, sealShown: Boolean,
    titleMinWidth: Dp = if (back) 218.dp else 160.dp, compact: Boolean = false,
    onBounds: (String, Rect?) -> Unit = { _, _ -> }, tight: Boolean = false) {
    val gap = if (tight) 4.dp else 6.dp
    Box(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(start = 8.dp, top = 10.dp, end = 8.dp + PkwTokens.Dims.resourceRowW + gap),
            verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(gap)) {
                ChunkyBox(PkwTokens.Colors.blue, onBackOrHome, if (back) "Back to the map" else "Home to your kingdom",
                    Modifier.size(56.dp, 58.dp).mapChromeBounds("home", onBounds)) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        if (back) BackArrowGlyph(26.dp) else PkwIcon(homeIcon, 28.dp)
                        PkwText(if (back) "MAP" else "HOME", PkwTokens.Type.small, color = PkwTokens.Colors.label, outline = 1.dp)
                    }
                }
                if (!compact) MapTitlePlate(title, subtitle,
                    Modifier.weight(1f, fill = false).widthIn(min = titleMinWidth).mapChromeBounds("title", onBounds), tight)
                if (onSearch != null) {
                    ChunkyBox(PkwTokens.Colors.stone, onSearch, "Search players, kingdoms and spot numbers",
                        Modifier.size(52.dp, 54.dp).mapChromeBounds("search", onBounds)) {
                        MagnifierGlyph(26.dp)
                    }
                }
            }
            if (compact) MapTitlePlate(title, subtitle, Modifier.fillMaxWidth().mapChromeBounds("title", onBounds))
        }
        ResourceStack(resources, onResourceRow, Modifier.align(Alignment.TopEnd).padding(top = 10.dp, end = 8.dp)
            .mapChromeBounds("resources", onBounds), enabled = !sealShown)
    }
}

@Composable private fun MapTitlePlate(title: String, subtitle: String, modifier: Modifier, tight: Boolean = false) {
    Plate(PlateKind.CHARCOAL, modifier.heightIn(min = 52.dp)
        .clearAndSetSemantics { contentDescription = "$title. $subtitle" },
        contentPadding = if (tight) PaddingValues(start = 5.dp, top = 6.dp, end = 5.dp, bottom = 8.dp) else plateContentPadding(PlateKind.CHARCOAL),
        blocksScene = false) {
        Column {
            PkwText(title, PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp, maxLines = 1)
            PkwText(subtitle.ifBlank { UNKNOWN }, PkwTokens.Type.small, color = PkwTokens.Colors.muted, maxLines = 1)
        }
    }
}

// ---- Right edge and left edge (SPEC §1.2, §1.3) ----

/** Zoom + / − (stone 52) and, on the world and realm maps, ME (blue 52 × 54, locate icon + "ME"). */
@Composable internal fun ThumbColumn(onZoom: (Int) -> Unit, onMe: () -> Unit, me: Boolean, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ChunkyBox(PkwTokens.Colors.stone, { onZoom(1) }, "Zoom in", Modifier.size(52.dp)) { PkwIcon("shape:plus", 24.dp, tint = PkwTokens.Colors.label) }
        ChunkyBox(PkwTokens.Colors.stone, { onZoom(-1) }, "Zoom out", Modifier.size(52.dp)) { PkwIcon("shape:minus", 24.dp, tint = PkwTokens.Colors.label) }
        if (me) {
            Spacer(Modifier.height(6.dp))
            ChunkyBox(PkwTokens.Colors.blue, onMe, "Fly to my kingdom", Modifier.size(52.dp, 54.dp)) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    PkwIcon("locate", 24.dp)
                    PkwText("ME", PkwTokens.Type.small, color = PkwTokens.Colors.label, outline = 1.dp)
                }
            }
        }
    }
}

/** The same three callbacks and touch targets in a low shelf for short landscape. */
@Composable private fun ThumbRow(onZoom: (Int) -> Unit, onMe: () -> Unit, modifier: Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        ChunkyBox(PkwTokens.Colors.stone, { onZoom(1) }, "Zoom in", Modifier.size(52.dp)) {
            PkwIcon("shape:plus", 24.dp, tint = PkwTokens.Colors.label)
        }
        ChunkyBox(PkwTokens.Colors.stone, { onZoom(-1) }, "Zoom out", Modifier.size(52.dp)) {
            PkwIcon("shape:minus", 24.dp, tint = PkwTokens.Colors.label)
        }
        ChunkyBox(PkwTokens.Colors.blue, onMe, "Fly to my kingdom", Modifier.size(52.dp, 54.dp)) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                PkwIcon("locate", 24.dp)
                PkwText("ME", PkwTokens.Type.small, color = PkwTokens.Colors.label, outline = 1.dp)
            }
        }
    }
}

/**
 * The ModeButton (SPEC §1.3): 56 × 56 charcoal face with the mode icon (cross-fade 120 ms) and three 6 dp position pips,
 * an outlined caption pill under it. Tap = next mode; long press = the three-row sheet that names all modes.
 */
@Composable private fun ModeButton(mode: MapMode, onMode: () -> Unit, onModeLong: () -> Unit, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val tap by rememberUpdatedState(onMode)
    val long by rememberUpdatedState(onModeLong)
    var pressed by remember { mutableStateOf(false) }
    val press by animateFloatAsState(if (pressed) 1f else 0f,
        tween(if (reduced) 0 else if (pressed) PkwTokens.Motion.PRESS else PkwTokens.Motion.RELEASE,
            easing = if (pressed) PkwTokens.Motion.Linear else PkwTokens.Motion.Pop), label = "modePress")
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(56.dp).sceneInputRegion()
            .semantics {
                contentDescription = "Map mode ${mode.name.lowercase()}"
                role = Role.Button
                this.onClick(label = "Next mode") { tap(); true }
                this.onLongClick(label = "Show all modes") { long(); true }
            }
            .pointerInput(Unit) {
                detectTapGestures(onPress = { pressed = true; tryAwaitRelease(); pressed = false },
                    onLongPress = { long() }, onTap = { tap() })
            }
            .drawBehind { drawChunky(PkwTokens.Colors.charcoalRamp, press) }, contentAlignment = Alignment.Center) {
            Column(Modifier.padding(bottom = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Crossfade(mode, animationSpec = tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.TAB_SWITCH),
                    label = "modeIcon") { m -> PkwIcon(modeIcon(m), if (m == MapMode.KINGDOMS) 28.dp else 32.dp) }
                Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                    MapMode.entries.forEach { m ->
                        Box(Modifier.size(6.dp).background(if (m == mode) PkwTokens.Colors.gold.hi else MapColors.pipOff))
                    }
                }
            }
        }
        PkwText(mode.name, PkwTokens.Type.small, Modifier.clearAndSetSemantics { }, color = PkwTokens.Colors.label, outline = 2.dp)
    }
}

// ---- Bottom band (SPEC §1.4) ----

/** The FilterChips row (48 tall, gap 4): inactive veil, active parchment face with ink text. */
@Composable internal fun FilterChipRow(chips: List<FilterChipUi>, onChip: (String) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        chips.forEach { chip -> FilterChip(chip, { onChip(chip.id) }, Modifier.weight(1f)) }
    }
}

/** One FilterChip (SPEC §1.4): label + count, legend dots, a ≥ 48 dp target, −2 dp press. */
@Composable internal fun FilterChip(ui: FilterChipUi, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val count = if (ui.count.isEmpty()) null else ui.count
    Box(modifier.heightIn(min = 48.dp).sceneInputRegion()
        .clearAndSetSemantics {
            contentDescription = listOfNotNull(ui.label, count?.let { "$it" }).joinToString(" ")
            role = Role.Tab; selected = ui.on
            this.onClick(label = null, action = { onClick(); true })
        }
        .clickable(role = Role.Tab, onClick = onClick)
        .drawBehind {
            fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
            val i = 2.dp.toPx()
            insideStepped(i, i, size.width - i, size.height - i, CornerProfiles.S) {
                drawRect(if (ui.on) PkwTokens.Colors.parchment else PkwTokens.Colors.veil)
                drawRect(if (ui.on) PkwTokens.Colors.parchmentHi else PkwTokens.Colors.veilHi, Offset(i, i), Size(size.width - 2 * i, 2.dp.toPx()))
            }
        }, contentAlignment = Alignment.Center) {
        val ink = ui.on
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                if (ui.dots.isNotEmpty()) Row { ui.dots.forEach { Box(Modifier.size(6.dp, 10.dp).background(PkwTokens.ramp(it).face)) } }
                PkwText(ui.label, PkwTokens.Type.small, color = if (ink) PkwTokens.Colors.textOnParch else PkwTokens.Colors.label,
                    outline = if (ink) 0.dp else 1.dp)
            }
            if (count != null) PkwText(count, PkwTokens.Type.small, color = if (ink) PkwTokens.Colors.textOnParch else PkwTokens.Colors.label,
                outline = if (ink) 0.dp else 1.dp)
        }
    }
}

/**
 * The RealmRail (SPEC §1.4): Seeker, Solana, Divine first, a 4 dp ink divider, then the realms; horizontal scroll with
 * a 30 dp peek fade on the right. The strip is a scene-input region (it scrolls); a tile tap flies the camera.
 */
@Composable internal fun RealmRail(tiles: List<RailTileUi>, selected: String?, onRail: (String) -> Unit) {
    RealmRailContent(tiles, selected, onRail, null, Modifier)
}

@Composable private fun RealmRailContent(tiles: List<RailTileUi>, selected: String?, onRail: (String) -> Unit,
    railArt: (@Composable BoxScope.(RailTileUi) -> Unit)?, modifier: Modifier) {
    val (ordered, divider) = remember(tiles) { orderRail(tiles) { it.id } }
    Row(modifier.fillMaxWidth().sceneInputRegion()
        .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
        // the peek fade's brush is built once per size, not on every draw of a scrolling rail (c-gap-map)
        .drawWithCache {
            val fade = 30.dp.toPx()
            val peek = Brush.horizontalGradient(listOf(Color.Black, Color.Transparent), startX = size.width - fade, endX = size.width)
            onDrawWithContent {
                drawContent()
                drawRect(peek, blendMode = BlendMode.DstIn)
            }
        }
        .horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Bottom) {
        ordered.forEachIndexed { i, tile ->
            RailTile(tile, tile.id == selected, tile.id in SPECIAL_ISLAND_IDS, railArt) { onRail(tile.id) }
            if (i == divider) Box(Modifier.padding(bottom = 26.dp).size(4.dp, 60.dp).background(PkwTokens.Colors.ink))
        }
    }
}

/** One RailTile: 80 × 60 well (ink M shell, veil or sea face, gold-hi shell when active), the tile art, the plate / badge
 *  poking out of the top edge, and the VT 18 caption pill. */
@Composable private fun RailTile(tile: RailTileUi, active: Boolean, island: Boolean,
    railArt: (@Composable BoxScope.(RailTileUi) -> Unit)?, onClick: () -> Unit) {
    val said = listOfNotNull(tile.caption, tile.tag?.text, tile.badge?.description, "your realm".takeIf { tile.home }).joinToString(", ")
    Column(Modifier.width(80.dp)
        .clearAndSetSemantics { contentDescription = said; role = Role.Button; selected = active; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(role = Role.Button, onClick = onClick), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.padding(top = 12.dp)) {
            Box(Modifier.size(80.dp, 60.dp).drawBehind {
                fillStepped(0f, 0f, size.width, size.height, CornerProfiles.M, if (active) PkwTokens.Colors.gold.hi else PkwTokens.Colors.ink)
                val i = 3.dp.toPx()
                insideStepped(i, i, size.width - i, size.height - i, CornerProfiles.S) {
                    drawRect(if (island) MapColors.railSea else PkwTokens.Colors.veil)
                }
            }, contentAlignment = Alignment.Center) {
                val icon = tile.icon
                if (railArt != null) railArt(tile)
                else if (icon != null) MapIcon(icon, if (island) 32.dp else 52.dp)
                else PkwText(tile.caption.take(1).uppercase(), PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
            }
            tile.tag?.let { Tag(it.text, it.verb, Modifier.align(Alignment.TopCenter).offset(y = (-12).dp)) }
            tile.badge?.let { Badge(it, Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp)) }
        }
        Spacer(Modifier.height(4.dp))
        Box(Modifier.background(if (active) PkwTokens.Colors.gold.hi else Color.Transparent).padding(horizontal = 4.dp)) {
            PkwText(tile.caption, PkwTokens.Type.small, color = if (active) PkwTokens.Colors.ink else PkwTokens.Colors.text,
                outline = if (active) 0.dp else 1.dp, maxLines = 1)
        }
    }
}

// ---- World-anchored pieces (SPEC §1.5, §2.2) ----

/** A PlaceLabel (SPEC §1.5): a 104 × 28 veil chip (gold-hi rim when selected), the 32 dp navigation icon poking out at
 *  −8 / −6, the PS 11 name, and the optional tag hanging under it 20 to the right. The touch target is ≥ 48 tall. */
@Composable internal fun PlaceLabel(ui: PlaceLabelUi, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.defaultMinSize(minHeight = 48.dp).sceneInputRegion()
        .clearAndSetSemantics {
            contentDescription = listOfNotNull(ui.name, ui.tag?.text).joinToString(", ")
            role = Role.Button; selected = ui.selected
            this.onClick(label = null, action = { onClick(); true })
        }
        .clickable(role = Role.Button, onClick = onClick).padding(start = 8.dp, top = 10.dp)) {
        Box(Modifier.size(104.dp, 28.dp).drawBehind {
            fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, if (ui.selected) PkwTokens.Colors.gold.hi else PkwTokens.Colors.ink)
            val i = 2.dp.toPx()
            insideStepped(i, i, size.width - i, size.height - i, CornerProfiles.S) {
                drawRect(PkwTokens.Colors.veil)
                drawRect(PkwTokens.Colors.veilHi, Offset(i, i), Size(size.width - 2 * i, 2.dp.toPx()))
            }
        }.padding(start = 28.dp, end = 4.dp), contentAlignment = Alignment.CenterStart) {
            PkwText(ui.name, PkwTokens.Type.small, color = PkwTokens.Colors.label, outline = 1.dp)
        }
        MapIcon(ui.icon, 32.dp, Modifier.offset(x = (-8).dp, y = (-6).dp))
        if (ui.tag != null && !ui.selected) Tag(ui.tag.text, ui.tag.verb, Modifier.padding(start = 20.dp, top = 28.dp))
    }
}

/** A trip marker (SPEC §1.5): under way = TimerPlate 118 × 34 (lodge icon 32, time, 8 dp green meter); returned = a green
 *  48 dp WorldBubble with ready-status 32 and a tail. Tap = the archipelago panel. */
@Composable private fun TripMarker(ui: MapMarkerUi, onClick: () -> Unit, modifier: Modifier) {
    val touch = Modifier.sceneInputRegion()
        .clearAndSetSemantics { contentDescription = ui.description; role = Role.Button; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(role = Role.Button, onClick = onClick)
    when (ui.kind) {
        MarkerKind.UNDER_WAY -> Box(modifier.then(touch).size(118.dp, 48.dp), contentAlignment = Alignment.BottomCenter) {
            Plate(PlateKind.CHARCOAL, Modifier.size(118.dp, 34.dp), contentPadding = PaddingValues(start = 3.dp, end = 6.dp), blocksScene = false) {
                Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    PkwIcon("ui:lodge-menu", 32.dp, Modifier.offset(y = (-3).dp))
                    Column(Modifier.weight(1f)) {
                        PkwText(ui.timeLeft ?: UNKNOWN, PkwTokens.Type.small, color = PkwTokens.Colors.text, outline = 1.dp)
                        Box(Modifier.fillMaxWidth().height(6.dp).background(PkwTokens.Colors.track)) {
                            ui.progress?.let { Box(Modifier.fillMaxWidth(it.coerceIn(0f, 1f)).height(6.dp).background(PkwTokens.Colors.green.face)) }
                        }
                    }
                }
            }
        }
        MarkerKind.RETURNED -> Box(modifier.then(touch).size(48.dp, 56.dp).drawBehind {
            drawChunky(PkwTokens.Colors.green, 0f)
        }, contentAlignment = Alignment.TopCenter) {
            PkwIcon("ui:ready-status", 32.dp, Modifier.padding(top = 6.dp))
            Box(Modifier.align(Alignment.BottomCenter).size(12.dp, 8.dp).drawBehind {
                val tail = Path().apply { moveTo(0f, 0f); lineTo(size.width, 0f); lineTo(size.width / 2f, size.height); close() }
                drawPath(tail, PkwTokens.Colors.ink)
            })
        }
    }
}

/** Your kingdom's gold plate on a 4 dp ink stem (SPEC §2.2). Paint only: a pan may start on it. */
@Composable internal fun YouPlate(ui: YouPlateUi, modifier: Modifier) {
    Column(modifier.clearAndSetSemantics { contentDescription = "Your kingdom. ${ui.text}" }, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.heightIn(min = 26.dp).drawBehind {
            fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
            val i = 2.dp.toPx()
            insideStepped(i, i, size.width - i, size.height - i, CornerProfiles.S) {
                drawRect(PkwTokens.Colors.gold.face)
                drawRect(PkwTokens.Colors.gold.hi, Offset(i, i), Size(size.width - 2 * i, 2.dp.toPx()))
            }
        }.padding(horizontal = 6.dp), contentAlignment = Alignment.Center) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                if (ui.shielded) PkwIcon("shield", 20.dp)
                PkwText(ui.text, PkwTokens.Type.small, color = PkwTokens.Colors.label, outline = 1.dp)
            }
        }
        Box(Modifier.size(4.dp, 12.dp).background(PkwTokens.Colors.ink))
    }
}

/** A notice pill (SPEC §2.1 art failed, §2.2 empty filter / failed read): veil text + an optional blue 64 × 44 action. */
@Composable internal fun MapPill(ui: MapPillUi, onPill: (String) -> Unit, modifier: Modifier = Modifier) {
    Plate(PlateKind.VEIL, modifier.semantics(mergeDescendants = true) { }, contentPadding = PaddingValues(start = 8.dp, top = 2.dp, end = 3.dp, bottom = 2.dp),
        blocksScene = ui.actionLabel != null) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwText(ui.text, PkwTokens.Type.body, color = PkwTokens.Colors.text, outline = 1.dp)
            ui.actionLabel?.let { SecondaryButton(it, { onPill(ui.id) }, Modifier.width(64.dp).heightIn(min = 44.dp), verb = Verb.BLUE) }
        }
    }
}

// ---- Previews ----

internal val PREVIEW_RESOURCES = listOf(
    ResourceChipUi(FeatureId("hud.shards"), "shards", "40,943", 0.62f, false, null, name = "Shards", accent = ResourceAccent.SHARDS),
    ResourceChipUi(FeatureId("hud.gems"), "gem", "1,250", null, false, null, name = "Gems", accent = ResourceAccent.GEMS),
    ResourceChipUi(FeatureId("hud.keep"), "keep", "312.5", null, false, null, name = "KEEP", accent = ResourceAccent.KEEP),
    ResourceChipUi(FeatureId("hud.skr"), "skr", "240", null, false, null, name = "SKR", accent = ResourceAccent.SKR, drawerHandle = true),
)

private val previewRail = listOf(
    RailTileUi("frostveil", null, "Frostveil", tag = MapTagUi("YOU", Verb.GOLD), home = true),
    RailTileUi("seeker", "ui:seeker-navigation", "Seeker", tag = MapTagUi("LIVE", Verb.RED)),
    RailTileUi("elderwood", null, "Elderwood"),
    RailTileUi("solana", "ui:solana-navigation", "Solana"),
    RailTileUi("divine", "ui:divine-navigation", "Divine", badge = BadgeUi("1", BadgeTone.COUNT, "1 trial ready")),
)

private val previewAnchors = mapOf(
    "seeker" to ScreenPoint(300f, 380f), "solana" to ScreenPoint(96f, 350f), "aurora/2" to ScreenPoint(110f, 520f),
    "glasswake/1" to ScreenPoint(228f, 560f), "you" to ScreenPoint(200f, 420f), "ring" to ScreenPoint(200f, 460f),
)

@Preview(name = "World at rest (map-globe)", widthDp = 412, heightDp = 915)
@Composable private fun MapHudWorldPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF0B0A1A))) {
        MapHud(MapHudUi(MapScreen.WORLD, MapMode.EXPLORE, "WORLD", "8 realms · 3 islands", PREVIEW_RESOURCES, previewRail, null,
            placeLabels = listOf(PlaceLabelUi("seeker", "ui:seeker-navigation", "SEEKER", MapTagUi("LIVE 14h", Verb.RED)),
                PlaceLabelUi("solana", "ui:solana-navigation", "SOLANA")),
            markers = listOf(MapMarkerUi("aurora/2", MarkerKind.UNDER_WAY, "1h 20m", 0.4f, "Survey Balloon, back in 1 hour 20 minutes"),
                MapMarkerUi("glasswake/1", MarkerKind.RETURNED, null, null, "Cargo Cutter returned"))),
            MapHudActions(), anchor = { previewAnchors[it] })
    }
}

@Preview(name = "Realm, KINGDOMS mode with chips (map-realm)", widthDp = 412, heightDp = 915)
@Composable private fun MapHudRealmPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF9FB4C4))) {
        MapHud(MapHudUi(MapScreen.REALM, MapMode.KINGDOMS, "FROSTVEIL", "3,150 kingdoms here", PREVIEW_RESOURCES, previewRail, "frostveil",
            chips = listOf(FilterChipUi("all", "ALL", "3,150", true), FilterChipUi("mine", "MINE", "1", false, listOf(Verb.GOLD)),
                FilterChipUi("unshielded", "NO SHIELD", UNKNOWN, false), FilterChipUi("lvl", "LV 5–12", "", false)),
            you = YouPlateUi("YOU · 3h", true), ringRadiusDp = 29f), MapHudActions(), anchor = { previewAnchors[it] })
    }
}

@Preview(name = "Art failed + empty filter pills; panel open (rail away)", widthDp = 412, heightDp = 915)
@Composable private fun MapHudNoticePreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF0B0A1A))) {
        MapHud(MapHudUi(MapScreen.WORLD, MapMode.WARZONE, "WORLD", UNKNOWN, PREVIEW_RESOURCES.map { it.copy(value = UNKNOWN) }, previewRail, "seeker",
            panelOpen = true, topPill = MapPillUi("art", "Island art didn't load", "RETRY"),
            bandPill = MapPillUi("empty", "No kingdoms match", "ALL")), MapHudActions())
    }
}
