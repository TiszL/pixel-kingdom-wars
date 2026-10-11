package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.inset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.drawChunky
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

/*
 * Design component: the island scene overlay for Seeker Island and Solana Island (design/final/map/SPEC.md §3.2-§3.3,
 * §4.1; seeker-island.png, seeker-closed.png, seeker-testdata.png, seeker-outbid.png, solana-island.png): BACK "MAP",
 * the 218 dp title plate and the ResourceStack; the CountdownChip, the server-off banner, the striped TEST DATA ribbon
 * and the red outbid Herald; the AUCTION HUB tag; ClusterBubbles at Z0 (and Z1 where spots crowd), spot sprites with
 * their SpotTags and the selection diamond at Z1 / Z2; the Public Workshop marker on Solana; the bottom FilterChips that
 * double as the legend, the spot-number search, zoom + / −, the first-visits hint and the empty-filter / error pills.
 *
 * The spots come from the caller's layout list (IS-A2 anchors in island-art pixels; 100 on Seeker, 20 of them King;
 * every count is the server's). The island art itself, its pan / pinch and its camera belong to the island scene below
 * this overlay; the overlay reads the camera ([IslandCamera]) in the layout / draw phase only.
 */

/** One spot of the layout list (SPEC §3.2 `SpotMarkerUi`). */
@Immutable data class SpotMarkerUi(
    /** The spot / workshop number. */
    val no: Int,
    /** King class (crown pip, gold-hi cluster shell). */
    val king: Boolean,
    /** The sprite look (Q2 default mapping: available / occupied / active / expired). */
    val look: SpotLook,
    /** Your relation to it (Seeker). */
    val mine: MineState = MineState.NONE,
    /** Solana only: the workshop's licence state. */
    val licence: LicenceState? = null,
    /** The IS-A2 anchor, bottom-centre of the sprite, in island-art pixels. */
    val at: IslandPoint,
) {
    internal val geom: SpotGeom get() = SpotGeom(no, king, look, mine, at, licence)
}

/** The red outbid Herald (SPEC §3.5): "OUTBID · SPOT 42" / "160 SKR leads now". The caller removes it after its hold. */
@Immutable data class OutbidBannerUi(val key: String, val spotNo: Int, val title: String, val line: String)

/** Everything the island overlay draws (SPEC §3.2 `IslandSceneUi`; the clusters are derived here from [spots]). */
@Immutable data class IslandSceneUi(
    val island: IslandKind,
    /** "SEEKER ISLAND". */
    val title: String,
    /** "Bids fund league rewards" / "100 workshops + 1 public" (counts from the catalogue). */
    val subtitle: String,
    /** The Home ResourceStack rows, unchanged. */
    val resources: List<ResourceChipUi>,
    /** Seeker: the auction phase; null while loading. */
    val phase: AuctionPhase?,
    /** Solana: the island's draw state (NONE when the server has no draw). */
    val licence: LicenceState? = null,
    /** The CountdownChip time ("14h 10m"); null while unknown. */
    val countdown: String? = null,
    /** 0..2 (Z0 art / 2, Z1 art / 1, Z2 2 px per art px). */
    val zoom: Int = 0,
    /** The layout list (≤ 100 + the King spots among them). */
    val spots: List<SpotMarkerUi>,
    val filter: SpotFilter = SpotFilter.ALL,
    /** Server counts per filter ("…" while unknown; "0" only when the server says so). */
    val counts: Map<SpotFilter, String> = emptyMap(),
    /** The selected spot number. */
    val selected: Int? = null,
    /** Seeker: the AUCTION HUB anchor (realm pack `hub`); null draws no tag. */
    val hub: IslandPoint? = null,
    /** Solana: the Public Workshop anchor (IS-A2). */
    val publicWorkshop: IslandPoint? = null,
    val publicSelected: Boolean = false,
    /** The live outbid Herald; null when none. */
    val outbid: OutbidBannerUi? = null,
    /** The data is a fixture: TEST DATA ribbon, never the word LIVE. */
    val testData: Boolean = false,
    /** "Tap a group to zoom in" (first 3 visits only). */
    val hint: Boolean = false,
    /** The auction read failed: "Can't load the auction · RETRY" (spots stay at their last read). */
    val error: Boolean = false,
    /** A spot / workshop sheet is open: the bottom row slides away. */
    val sheetOpen: Boolean = false,
    /** A Seal shows: the stack is readable, not tappable. */
    val sealShown: Boolean = false,
)

/** Island overlay callbacks (SPEC §3.2 callbacks). */
@Immutable data class IslandSceneActions(
    /** BACK "MAP": the globe with the island still selected. */
    val onBack: () -> Unit = {},
    val onSpot: (Int) -> Unit = {},
    /** A ClusterBubble: zoom ×2 centred on it (280 ms `out`). */
    val onCluster: (members: List<Int>, at: IslandPoint) -> Unit = { _, _ -> },
    val onPublic: () -> Unit = {},
    val onFilter: (SpotFilter) -> Unit = {},
    /** The bottom search: the spot-number search (numeric keyboard). */
    val onFindSpot: () -> Unit = {},
    val onZoom: (Int) -> Unit = {},
    val onResourceRow: (FeatureId) -> Unit = {},
    val onRetry: () -> Unit = {},
    /** The outbid Herald: select that spot. */
    val onOutbid: (Int) -> Unit = {},
)

/** The tappable targets of the island at its zoom level (clusters, lone sprites, the Public Workshop). */
fun islandTargets(ui: IslandSceneUi, density: Float): List<IslandTarget> {
    val visible = ui.spots.map { it.geom }.filter { spotPasses(ui.filter, it, ui.selected) }
    val clusters = clusterSpots(ui.island, visible, ui.zoom, density)
    val spriteLiftArt = 32f * spriteScale(ui.zoom) / levelScale(ui.zoom) // half the sprite height, in art px
    val bubbleLiftArt = 34f * density / levelScale(ui.zoom)              // bubble centre above its tail tip, in art px
    val out = clusters.map { c ->
        if (c.members.size == 1 && ui.zoom >= 1) IslandTarget(IslandTap.Spot(c.members.first()), IslandPoint(c.at.x, c.at.y - spriteLiftArt))
        else IslandTarget(IslandTap.Cluster(c.members, c.at), IslandPoint(c.at.x, c.at.y - bubbleLiftArt))
    }
    val pub = ui.publicWorkshop?.let { IslandTarget(IslandTap.PublicWorkshop, IslandPoint(it.x, it.y - spriteLiftArt)) }
    return if (pub == null) out else out + pub
}

/**
 * The island scene's tap → target (pointer rule: the overlay's markers are paint, so the scene's own tap handler calls
 * this with the tap in overlay pixels and routes the result to [IslandSceneActions]).
 */
fun islandTap(ui: IslandSceneUi, camera: IslandCamera, density: Float, tapXPx: Float, tapYPx: Float): IslandTap? =
    pickIslandTarget(islandTargets(ui, density), camera, density, tapXPx, tapYPx)

/**
 * The island overlay (SPEC §3.2, §4.1).
 *
 * Pointer rule: the root and the marker layer are plain full-screen boxes with NO clickable, pointerInput, draggable or
 * scrim. The spot sprites, cluster bubbles, hub tag and Public Workshop marker are PAINT ONLY (each carries a screen-
 * reader click action, which does not take pointer hits), so a pan or pinch that starts on a spot still reaches the
 * island scene below; the scene's tap calls [islandTap] (nearest centre within 24 dp). Only BACK, the ResourceStack, the
 * outbid Herald, the chips, search, zoom and pill actions take touches.
 *
 * [camera] gives the art → overlay transform (device px, the overlay root's own coordinates, before insets).
 */
@Composable fun IslandOverlay(ui: IslandSceneUi, on: IslandSceneActions, camera: () -> IslandCamera, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current || LocalInspectionMode.current
    val density = LocalDensity.current.density
    Box(modifier.fillMaxSize()) {
        SpotLayer(ui, on, camera, density, reduced)
        Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
            MapTopBar(ui.title, ui.subtitle, back = true, onBackOrHome = on.onBack, homeIcon = "", onSearch = null,
                resources = ui.resources, onResourceRow = on.onResourceRow, sealShown = ui.sealShown)
            IslandBanners(ui, on, Modifier.padding(start = 8.dp, top = 76.dp).widthIn(max = 288.dp), reduced)
            Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
                val emptyFilter = ui.filter != SpotFilter.ALL && ui.spots.none { spotPasses(ui.filter, it.geom, null) }
                when {
                    ui.error -> CenterPill(MapPillUi("retry", "Can't load the auction", "RETRY")) { on.onRetry() }
                    emptyFilter && !ui.sheetOpen -> CenterPill(MapPillUi("all", emptyFilterLine(ui.filter), "ALL")) { on.onFilter(SpotFilter.ALL) }
                }
                AnimatedVisibility(!ui.sheetOpen, enter = bandEnter(reduced), exit = bandExit(reduced)) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
                            if (ui.hint) Plate(PlateKind.VEIL, Modifier.padding(bottom = 4.dp), blocksScene = false) {
                                PkwText("Tap a group to zoom in", PkwTokens.Type.body, color = PkwTokens.Colors.text)
                            }
                            Spacer(Modifier.weight(1f))
                            ThumbColumn(onZoom = on.onZoom, onMe = {}, me = false)
                        }
                        Spacer(Modifier.height(14.dp))
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                            val chips = islandFilters(ui.island).map { f ->
                                FilterChipUi(f.name, filterLabel(f), filterCount(ui.counts, f), f == ui.filter, filterDots(f))
                            }
                            FilterChipRow(chips, { id -> on.onFilter(SpotFilter.valueOf(id)) }, Modifier.weight(1f))
                            ChunkyBox(PkwTokens.Colors.stone, on.onFindSpot, "Find a spot by number", Modifier.size(52.dp)) { MagnifierGlyph(26.dp) }
                        }
                        Spacer(Modifier.height(8.dp))
                    }
                }
            }
        }
    }
}

@Composable private fun CenterPill(ui: MapPillUi, onAction: () -> Unit) {
    Box(Modifier.fillMaxWidth().padding(bottom = 8.dp), contentAlignment = Alignment.Center) { MapPill(ui, { onAction() }) }
}

/** Under the top bar: the TEST DATA ribbon, then the outbid Herald, the server-off banner or the CountdownChip. */
@Composable private fun IslandBanners(ui: IslandSceneUi, on: IslandSceneActions, modifier: Modifier, reduced: Boolean) {
    val last = remember { mutableStateOf(ui.outbid) }
    if (ui.outbid != null) last.value = ui.outbid
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (ui.testData) TestDataRibbon(if (ui.island == IslandKind.SEEKER) "TEST DATA · NOT REAL BIDS" else "TEST DATA",
            Modifier.fillMaxWidth())
        AnimatedVisibility(ui.outbid != null,
            enter = if (reduced) fadeIn(tween(PkwTokens.Motion.REDUCED_CROSSFADE))
                else slideInVertically(tween(PkwTokens.Motion.TOAST_IN, easing = PkwTokens.Motion.Out)) { -it / 4 } + fadeIn(tween(PkwTokens.Motion.TOAST_IN)),
            exit = fadeOut(tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.TOAST_OUT))) {
            last.value?.let { OutbidHerald(it) { on.onOutbid(it.spotNo) } }
        }
        if (ui.outbid == null) {
            if (ui.island == IslandKind.SEEKER && ui.phase == AuctionPhase.SERVER_OFF) {
                Plate(PlateKind.CHARCOAL, Modifier.fillMaxWidth().heightIn(min = 52.dp)
                    .clearAndSetSemantics { contentDescription = "Auctions are not open on this server yet." }, blocksScene = false) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        PkwIcon("ui:exhausted-status", 32.dp)
                        PkwText("Auctions are not open on this server yet.", PkwTokens.Type.body, color = PkwTokens.Colors.text, maxLines = 2)
                    }
                }
            } else countdownCopy(ui.island, ui.phase, ui.licence, ui.countdown)?.let { CountdownChip(it) }
        }
    }
}

/** The CountdownChip (SPEC §3.2: veil 280 × 34, timer 24, VT 20 label, PS 12 gold-hi time on the right). Paint only. */
@Composable private fun CountdownChip(copy: CountdownCopy) {
    Plate(PlateKind.VEIL, Modifier.widthIn(min = 240.dp).heightIn(min = 34.dp)
        .clearAndSetSemantics { contentDescription = listOfNotNull(copy.label, copy.time).joinToString(" ") },
        contentPadding = PaddingValues(start = 6.dp, top = 2.dp, end = 10.dp, bottom = 2.dp), blocksScene = false) {
        Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwIcon(copy.icon, 24.dp)
            PkwText(copy.label, PkwTokens.Type.body, color = PkwTokens.Colors.text, outline = 1.dp)
            if (copy.time != null) {
                Spacer(Modifier.width(8.dp))
                PkwText(copy.time, PkwTokens.Type.label, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
            }
        }
    }
}

/** The red outbid Herald (SPEC §3.5): 52 tall, SKR 24, PS 11 title, VT 18 line; tap = select that spot. */
@Composable private fun OutbidHerald(ui: OutbidBannerUi, onClick: () -> Unit) {
    Box(Modifier.fillMaxWidth().heightIn(min = 52.dp).sceneInputRegion()
        .clearAndSetSemantics { contentDescription = "${ui.title}. ${ui.line}"; role = Role.Button; this.onClick(label = "Show the spot", action = { onClick(); true }) }
        .clickable(role = Role.Button, onClick = onClick)
        .drawBehind {
            fillStepped(0f, 0f, size.width, size.height, CornerProfiles.M, PkwTokens.Colors.ink)
            val i = 3.dp.toPx()
            insideStepped(i, i, size.width - i, size.height - i, CornerProfiles.S) {
                drawRect(PkwTokens.Colors.red.face)
                drawRect(PkwTokens.Colors.red.hi, Offset(i, i), Size(size.width - 2 * i, 3.dp.toPx()))
                drawRect(PkwTokens.Colors.red.lo, Offset(i, size.height - i - 4.dp.toPx()), Size(size.width - 2 * i, 4.dp.toPx()))
            }
        }.padding(horizontal = 10.dp, vertical = 6.dp), contentAlignment = Alignment.CenterStart) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwIcon("skr", 24.dp)
            Column {
                PkwText(ui.title, PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
                PkwText(ui.line, PkwTokens.Type.small, color = PkwTokens.Colors.label, outline = 1.dp)
            }
        }
    }
}

// ---- The spot layer (paint only) ----

/** Places a piece so its pivot sits on an island point, through the camera, in the layout phase. */
private fun Modifier.islandAt(p: IslandPoint, camera: () -> IslandCamera, px: Float, py: Float, dyPx: Float = 0f): Modifier =
    layout { measurable, constraints ->
        val placeable = measurable.measure(constraints.copy(minWidth = 0, minHeight = 0))
        layout(placeable.width, placeable.height) {
            val c = camera()
            placeable.place((c.screenX(p.x) - placeable.width * px).roundToInt(), (c.screenY(p.y) - placeable.height * py + dyPx).roundToInt())
        }
    }

@Composable private fun SpotLayer(ui: IslandSceneUi, on: IslandSceneActions, camera: () -> IslandCamera, density: Float, reduced: Boolean) {
    val visible = remember(ui.spots, ui.filter, ui.selected) { ui.spots.map { it.geom }.filter { spotPasses(ui.filter, it, ui.selected) } }
    val clusters = remember(visible, ui.zoom, density) { clusterSpots(ui.island, visible, ui.zoom, density) }
    val byNo = remember(visible) { visible.associateBy { it.no } }
    val pulse = if (reduced || ui.selected == null) 0f else {
        val t = rememberInfiniteTransition(label = "selection")
        val v by t.animateFloat(0f, 1f, infiniteRepeatable(tween(900, easing = PkwTokens.Motion.Out), RepeatMode.Reverse), label = "pulse")
        v
    }
    val k = spriteScale(ui.zoom)
    val spriteDp = (64f * k / density).dp
    Box(Modifier.fillMaxSize()) {
        ui.hub?.let { HubTag(Modifier.islandAt(it, camera, 0.5f, 1f)) }
        clusters.forEachIndexed { index, c ->
            val single = c.members.size == 1 && ui.zoom >= 1
            val spot = if (single) byNo[c.members.first()] else null
            androidx.compose.runtime.key(c.members.first(), single) {
                if (spot != null) {
                    val selected = spot.no == ui.selected
                    if (selected) Canvas(Modifier.islandAt(spot.at, camera, 0.5f, 0.5f).size(80.dp, 42.dp)) {
                        drawSelectionDiamond(size.width / 2f, size.height / 2f, pulse)
                    }
                    MapIcon(siteArt(ui.island, spot.look), spriteDp,
                        Modifier.islandAt(spot.at, camera, 0.5f, 1f).popIn(index, reduced)
                            .clearAndSetSemantics {
                                contentDescription = spotDescription(ui.island, spot); role = Role.Button; this.selected = selected
                                this.onClick(label = null, action = { on.onSpot(spot.no); true })
                            }, scale = k)
                    spotTag(spot, ui.zoom)?.let { tag -> SpotTagChip(tag, Modifier.islandAt(spot.at, camera, 0.5f, 0f, 2f * density)) }
                } else {
                    ClusterBubble(c, Modifier.islandAt(c.at, camera, 0.5f, 1f).popIn(index, reduced)
                        .clearAndSetSemantics {
                            contentDescription = "${c.members.size} ${if (ui.island == IslandKind.SEEKER) "spots" else "workshops"}" +
                                (if (c.king) ", King spots inside" else "") + ". Zoom in"
                            role = Role.Button
                            this.onClick(label = null, action = { on.onCluster(c.members, c.at); true })
                        })
                }
            }
        }
        ui.publicWorkshop?.let { p ->
            PublicWorkshopMarker(ui.zoom, ui.publicSelected, k, spriteDp, Modifier.islandAt(p, camera, 0.5f, 1f)
                .clearAndSetSemantics {
                    contentDescription = "Public Workshop, always open"; role = Role.Button; selected = ui.publicSelected
                    this.onClick(label = null, action = { on.onPublic(); true })
                })
        }
    }
}

/** Clusters pop in with a 20 ms stagger (max 12 animated; the rest appear at once); none under reduced motion. */
@Composable private fun Modifier.popIn(index: Int, reduced: Boolean): Modifier {
    val animated = !reduced && index < 12
    val scale = remember { Animatable(if (animated) 0f else 1f) }
    LaunchedEffect(Unit) {
        if (animated) {
            delay(index * PkwTokens.Motion.DRAWER_ROW_STAGGER.toLong())
            scale.animateTo(1f, tween(PkwTokens.Motion.BADGE_POP, easing = PkwTokens.Motion.Pop))
        }
    }
    return this.graphicsLayer {
        scaleX = scale.value; scaleY = scale.value
        transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0.5f, 1f)
    }
}

/** The ClusterBubble (SPEC §3.2): 52 × 52 ink shape-M face (red / green / cream / stone) with a 12 × 8 tail and the PS 12
 *  count; a gold-hi shell and crown pip when it holds a King spot. Paint only. */
@Composable private fun ClusterBubble(c: SpotCluster, modifier: Modifier) {
    val ramp = when (c.face) {
        ClusterFace.RED -> PkwTokens.Colors.red
        ClusterFace.GREEN -> PkwTokens.Colors.green
        ClusterFace.STONE -> PkwTokens.Colors.stone
        ClusterFace.CREAM -> PkwTokens.Ramp(PkwTokens.Colors.cream, PkwTokens.Colors.parchmentHi, PkwTokens.Colors.creamLo, PkwTokens.Colors.cream)
    }
    Box(modifier.size(52.dp, 62.dp)) {
        Box(Modifier.size(52.dp).drawBehind {
            if (c.king) {
                fillStepped(0f, 0f, size.width, size.height, CornerProfiles.M, PkwTokens.Colors.gold.hi)
                inset(2.dp.toPx()) { drawChunky(ramp, 0f, lipDp = 5f) }
            } else drawChunky(ramp, 0f, lipDp = 5f)
        }, contentAlignment = Alignment.Center) {
            PkwText(c.members.size.toString(), PkwTokens.Type.label, Modifier.padding(bottom = 3.dp),
                color = if (c.face == ClusterFace.CREAM) PkwTokens.Colors.ink else PkwTokens.Colors.label,
                outline = if (c.face == ClusterFace.CREAM) 0.dp else 1.dp)
        }
        if (c.king) CrownPip(Modifier.align(Alignment.TopCenter).padding(top = 0.dp).graphicsLayer { translationY = -6.dp.toPx() })
        Canvas(Modifier.align(Alignment.BottomCenter).size(12.dp, 10.dp)) {
            val tail = Path().apply { moveTo(0f, 0f); lineTo(size.width, 0f); lineTo(size.width / 2f, size.height); close() }
            drawPath(tail, PkwTokens.Colors.ink)
        }
    }
}

/** A SpotTag (SPEC §3.3): ink shape-S chip 22 tall, PS 11 number (crown pip before it for King), a coloured face for
 *  your states, veil for others. Paint only. */
@Composable private fun SpotTagChip(tag: SpotTagLook, modifier: Modifier) {
    val face = tag.verb?.let { PkwTokens.ramp(it).face } ?: PkwTokens.Colors.veil
    Row(modifier.heightIn(min = 22.dp).clearAndSetSemantics { }.drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 2.dp.toPx()
        insideStepped(i, i, size.width - i, size.height - i, CornerProfiles.S) { drawRect(face) }
    }.padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        if (tag.crown) CrownPip()
        PkwText(tag.text, PkwTokens.Type.small, color = PkwTokens.Colors.label, outline = 1.dp)
    }
}

/** The AUCTION HUB tag on the lighthouse (SPEC §3.2): gold plate 30 tall + 4 × 16 ink stem. Paint only. */
@Composable private fun HubTag(modifier: Modifier) {
    Column(modifier.clearAndSetSemantics { contentDescription = "Auction hub" }, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.heightIn(min = 30.dp).drawBehind {
            fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
            val i = 2.dp.toPx()
            insideStepped(i, i, size.width - i, size.height - i, CornerProfiles.S) {
                drawRect(PkwTokens.Colors.gold.face)
                drawRect(PkwTokens.Colors.gold.hi, Offset(i, i), Size(size.width - 2 * i, 2.dp.toPx()))
            }
        }.padding(horizontal = 8.dp), contentAlignment = Alignment.Center) {
            PkwText("AUCTION HUB", PkwTokens.Type.small, color = PkwTokens.Colors.label, outline = 1.dp)
        }
        Box(Modifier.size(4.dp, 16.dp).background(PkwTokens.Colors.ink))
    }
}

/** The Public Workshop (SPEC §4.1): at Z0 a 60 dp gold-hi-rimmed bubble with the active workshop at 48 and a gold "PUBLIC"
 *  tag; at Z1 / Z2 the sprite with the tag. Always open. Paint only. */
@Composable private fun PublicWorkshopMarker(zoom: Int, selected: Boolean, k: Int, spriteDp: androidx.compose.ui.unit.Dp, modifier: Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        if (zoom == 0) {
            Box(Modifier.size(60.dp).drawBehind {
                fillStepped(0f, 0f, size.width, size.height, CornerProfiles.M, PkwTokens.Colors.gold.hi)
                inset(3.dp.toPx()) { fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, MapColors.seekerWell) }
            }, contentAlignment = Alignment.Center) { MapIcon("site:solana-active", 48.dp) }
        } else {
            Box(contentAlignment = Alignment.BottomCenter) {
                if (selected) Canvas(Modifier.size(80.dp, 42.dp).graphicsLayer { translationY = 21.dp.toPx() }) {
                    drawSelectionDiamond(size.width / 2f, size.height / 2f, 0f)
                }
                MapIcon("site:solana-active", spriteDp, scale = k)
            }
        }
        Tag("PUBLIC", Verb.GOLD)
    }
}

// ---- Previews ----

private val previewSpots = buildList {
    val ring = listOf(IslandPoint(300f, 260f), IslandPoint(330f, 280f), IslandPoint(620f, 300f), IslandPoint(640f, 330f), IslandPoint(560f, 620f),
        IslandPoint(580f, 650f), IslandPoint(260f, 820f), IslandPoint(300f, 840f), IslandPoint(700f, 1100f), IslandPoint(330f, 1300f))
    ring.forEachIndexed { i, p ->
        add(SpotMarkerUi(i + 1, king = i % 4 == 0, look = if (i == 8) SpotLook.EXPIRED else SpotLook.AVAILABLE,
            mine = when (i) { 2 -> MineState.LEADING; 4 -> MineState.OUTBID; else -> MineState.NONE }, at = p))
    }
}

private val previewCounts = mapOf(SpotFilter.ALL to "100", SpotFilter.MINE to "1", SpotFilter.BIDS to "2", SpotFilter.KING to "20")

private fun previewScene(zoom: Int = 0, phase: AuctionPhase? = AuctionPhase.OPEN, testData: Boolean = false, outbid: OutbidBannerUi? = null,
    selected: Int? = null, sheetOpen: Boolean = false) = IslandSceneUi(IslandKind.SEEKER, "SEEKER ISLAND", "Bids fund league rewards",
    PREVIEW_RESOURCES, phase, countdown = "14h 10m", zoom = zoom, spots = previewSpots, counts = previewCounts, selected = selected,
    hub = IslandPoint(610f, 180f), outbid = outbid, testData = testData, hint = zoom == 0, sheetOpen = sheetOpen)

@Composable private fun SceneBackdrop(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(MapColors.stage)) { content() }
}

@Preview(name = "Seeker island, Z0 clusters (seeker-island)", widthDp = 412, heightDp = 915)
@Composable private fun IslandOverlayZ0Preview() {
    SceneBackdrop { IslandOverlay(previewScene(), IslandSceneActions(), camera = { IslandCamera(0.5f, 0f, 120f) }) }
}

@Preview(name = "Seeker island, Z2 sprites + selection + outbid Herald (seeker-outbid)", widthDp = 412, heightDp = 915)
@Composable private fun IslandOverlayZ2Preview() {
    SceneBackdrop {
        IslandOverlay(previewScene(zoom = 2, selected = 5, outbid = OutbidBannerUi("o1", 5, "OUTBID · SPOT 5", "160 SKR leads now"), sheetOpen = true),
            IslandSceneActions(), camera = { IslandCamera(1f, -150f, -100f) })
    }
}

@Preview(name = "Seeker island, server off (seeker-closed)", widthDp = 412, heightDp = 915)
@Composable private fun IslandOverlayClosedPreview() {
    SceneBackdrop {
        IslandOverlay(previewScene(phase = AuctionPhase.SERVER_OFF).copy(counts = previewCounts + (SpotFilter.MINE to "0") + (SpotFilter.BIDS to "0")),
            IslandSceneActions(), camera = { IslandCamera(0.5f, 0f, 120f) })
    }
}

@Preview(name = "Seeker island, TEST DATA + loading (seeker-testdata)", widthDp = 412, heightDp = 915)
@Composable private fun IslandOverlayTestDataPreview() {
    SceneBackdrop {
        IslandOverlay(previewScene(phase = null, testData = true).copy(counts = emptyMap(), filter = SpotFilter.MINE, spots = emptyList()),
            IslandSceneActions(), camera = { IslandCamera(0.5f, 0f, 120f) })
    }
}

@Preview(name = "Solana island, licence draw opens later + Public Workshop (solana-island)", widthDp = 412, heightDp = 915)
@Composable private fun SolanaOverlayPreview() {
    SceneBackdrop {
        IslandOverlay(IslandSceneUi(IslandKind.SOLANA, "SOLANA ISLAND", "100 workshops + 1 public", PREVIEW_RESOURCES, phase = null,
            licence = LicenceState.NONE, spots = previewSpots.map { it.copy(mine = MineState.NONE, licence = LicenceState.NONE) },
            counts = mapOf(SpotFilter.ALL to "100", SpotFilter.MINE to "0", SpotFilter.PUBLIC to "1"),
            publicWorkshop = IslandPoint(500f, 200f), publicSelected = true, error = true),
            IslandSceneActions(), camera = { IslandCamera(0.5f, 0f, 120f) })
    }
}
