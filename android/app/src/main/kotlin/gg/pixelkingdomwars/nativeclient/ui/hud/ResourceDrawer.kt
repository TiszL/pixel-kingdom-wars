package gg.pixelkingdomwars.nativeclient.ui.hud

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ItemTile
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileState
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceDrawerUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceGroupLayout
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceGroupUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceRowUi
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftIcon
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

/**
 * Design component: the Resource drawer (DESIGN-SYSTEM §6 "Resource drawer", `design/final/drawer.png`; owner addenda
 * 1, 2, 3 and 6: every resource, SKR included, one tap from the top bar, grouped by where it comes from, and every
 * resource is a signpost).
 *
 * A wood frame drops from the top (y 8, 396 wide) over a 40 % scrim, height 0 → full in 200 ms `out`, its sections
 * fading in with a 20 ms stagger; it closes back up in 140 ms `in`. Top to bottom:
 * 1. the info card of the focused resource ([drawerFocus]): 64 dp art, name + count, what it is for and where it is
 *    earned, and a blue GO (with the destination's icon) that calls [HomeHudActions.openFeature]; it cross-fades in
 *    120 ms when another row is tapped;
 * 2. the groups: EVERY DAY as 2 × 2 wide rows (value + source; a row-level action such as SKR's BID draws only when the
 *    mapper supplies one, and Home supplies none while auctions have no system), then HARVESTERS / WORKSHOP / LODGE
 *    as a header (source icon, name, note, GO) over a sideways strip of 48 × 56 tiles. A zero tile is drawn at 40 % with
 *    a red count and still opens its info card; Divine Isle tiles are lavender;
 * 3. the footnote (the tint legend).
 * SOL is never here (UX-ARCHITECTURE §2.2). Every count arrives formatted; a blank count is "…", never "0".
 *
 * It closes with its X, a tap on the scrim, or Back ([HomeHudActions.closeDrawer]); a GO does not close it by itself
 * (the caller closes it while it navigates).
 *
 * Pointer rule: the drawer is the HUD's one modal sheet. Its root is a plain layout; the scrim under it is a
 * [ModalScrim] (a full-screen hit region) only while the drawer is shown, and while it animates out the scrim is paint
 * only, so touches already reach the kingdom again. Nothing is composed at all while the drawer is closed.
 */
@Composable fun ResourceDrawer(ui: ResourceDrawerUi?, on: HomeHudActions, modifier: Modifier = Modifier) {
    Presence(ui, PkwTokens.Motion.DRAWER_IN, PkwTokens.Motion.DRAWER_OUT) { drawer, progress, active, reduced ->
        // Previews have no Back registry or dispatcher owner.
        if (!LocalInspectionMode.current) BackHandlerAt(BackPriority.SHEET, enabled = active) { on.closeDrawer() }
        Box(modifier.fillMaxSize()) {
            if (active) ModalScrim(PkwTokens.Scrim.SHEET_TALL * progress(), on.closeDrawer)
            else Box(Modifier.fillMaxSize().drawBehind { drawRect(PkwTokens.Colors.scrim.copy(alpha = PkwTokens.Scrim.SHEET_TALL * progress())) })
            DrawerPanel(drawer, on, progress, reduced,
                Modifier.windowInsetsPadding(WindowInsets.safeDrawing).padding(PkwTokens.Space.screenGutter))
        }
    }
}

/** The wood frame. Without reduced motion it reveals its height with [progress] (it "drops from the stack"). */
@Composable private fun DrawerPanel(drawer: ResourceDrawerUi, on: HomeHudActions, progress: () -> Float, reduced: Boolean, modifier: Modifier) {
    val focus = drawerFocus(drawer)
    Plate(PlateKind.WOOD, modifier.fillMaxWidth()
        .clipToBounds()
        .layout { measurable, constraints ->
            val placeable = measurable.measure(constraints)
            val shown = if (reduced) placeable.height else (placeable.height * progress()).roundToInt()
            layout(placeable.width, shown) { placeable.place(0, 0) }
        }
        .graphicsLayer { alpha = if (reduced) progress() else 1f },
        contentPadding = PaddingValues(6.dp)) {
        Column(Modifier.fillMaxWidth()) {
            Row(Modifier.fillMaxWidth().padding(start = 2.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText(drawer.title, PkwTokens.Type.title, Modifier.weight(1f), color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                PkwText(drawer.hint, PkwTokens.Type.small, color = PkwTokens.Colors.parchment)
                CloseSquare(on.closeDrawer, contentDescription = "Close resources")
            }
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth().weight(1f, fill = false), contentPadding = PaddingValues(start = 8.dp, top = 8.dp, bottom = 6.dp)) {
                Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                    Staggered(0, reduced) { InfoCard(focus, on, Modifier.padding(end = 8.dp)) }
                    drawer.groups.forEachIndexed { index, group ->
                        Staggered(index + 1, reduced) { Group(group, focus?.id, on) }
                    }
                    drawer.footnote?.let {
                        PkwText(it, PkwTokens.Type.small, Modifier.padding(top = 4.dp, end = 8.dp), color = PkwTokens.Colors.textOnParch2, maxLines = 3)
                    }
                }
            }
        }
    }
}

/** Fades one drawer section in [index] × 20 ms after the drawer opens (DESIGN-SYSTEM §7 "rows fade with a 20 ms
 *  stagger"); still in previews and with reduced motion. */
@Composable private fun Staggered(index: Int, reduced: Boolean, content: @Composable () -> Unit) {
    val still = reduced || LocalInspectionMode.current
    val alpha = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (alpha.value < 1f) {
            delay(index.toLong() * PkwTokens.Motion.DRAWER_ROW_STAGGER)
            alpha.animateTo(1f, tween(PkwTokens.Motion.DRAWER_IN, easing = PkwTokens.Motion.Out))
        }
    }
    Box(Modifier.graphicsLayer { this.alpha = alpha.value }) { content() }
}

/** A count as shown: blank is unknown. */
private fun count(value: String): String = value.ifBlank { UNKNOWN }

/** The 2 dp ink-rimmed body every drawer row and card uses. */
private fun Modifier.drawerCard(body: Color): Modifier = this.background(body).border(2.dp, PkwTokens.Colors.ink)

/** The body colour of a row: lavender for the Divine Isle, the pale SKR green on the wallet SKR row (drawer.png
 *  #F0F8DC), cream otherwise. */
private fun rowBody(row: ResourceRowUi): Color = when {
    row.divine -> PkwTokens.Colors.divine
    row.id == "skr" -> SKR_ROW
    else -> PkwTokens.Colors.cream
}

/** drawer.png: the wallet SKR row's tint and the info card's dark art well. */
private val SKR_ROW = Color(0xFFF0F8DC)
private val INFO_WELL = Color(0xFF2A2430)

/**
 * The info card of the focused resource: the 64 dp art on a dark well, PS name + count, the VT "what it is for. Where
 * it is earned.", and a blue 64 × 60 GO carrying the destination's 32 dp icon. With nowhere to go yet, the row's own
 * action (BID) is offered instead, or no button.
 */
@Composable private fun InfoCard(row: ResourceRowUi?, on: HomeHudActions, modifier: Modifier) {
    if (row == null) {
        PkwText("No resources to show yet.", PkwTokens.Type.small, modifier, color = PkwTokens.Colors.textOnParch2)
        return
    }
    Crossfade(row, modifier, animationSpec = tween(PkwTokens.Motion.TAB_SWITCH), label = "drawerInfo") { shown ->
        Row(Modifier.fillMaxWidth().drawerCard(PkwTokens.Colors.selectedTint).sceneInputRegion().padding(6.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(68.dp).background(INFO_WELL).border(2.dp, PkwTokens.Colors.ink), contentAlignment = Alignment.Center) {
                // Phase E materials are `craft:` art; CraftIcon hands every other name to the kit's PkwIcon.
                CraftIcon(shown.icon, 64.dp, alpha = if (shown.empty) 0.4f else 1f)
            }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwText(shown.name, PkwTokens.Type.label, Modifier.weight(1f, fill = false), color = PkwTokens.Colors.textOnParch)
                    PkwText(count(shown.value), PkwTokens.Type.caption,
                        color = if (shown.empty) PkwTokens.Colors.shortText else PkwTokens.Colors.textOnParch2)
                }
                PkwText("${shown.purpose} ${shown.earnedAt}".trim(), PkwTokens.Type.small, Modifier.padding(top = 3.dp),
                    color = PkwTokens.Colors.textOnParch2, maxLines = 4)
            }
            val place = shown.earnedAtFeature
            val action = shown.action
            when {
                place != null -> GoButton({ on.openFeature(place) }, contentDescription = "Go to where ${shown.name} is earned. ${shown.earnedAt}",
                    Modifier.size(64.dp, 60.dp), icon = shown.goIcon)
                action != null -> GoButton({ on.openFeature(action) }, contentDescription = "${shown.actionLabel ?: "Go"}: ${shown.name}",
                    Modifier.size(64.dp, 60.dp), label = shown.actionLabel ?: "GO")
            }
        }
    }
}

/** One drawer group: EVERY DAY as wide rows, any other as a header over a tile strip. */
@Composable private fun Group(group: ResourceGroupUi, focusId: String?, on: HomeHudActions) {
    Column(Modifier.fillMaxWidth()) {
        GroupHeader(group, on)
        when (group.layout) {
            ResourceGroupLayout.WIDE_ROWS -> Column(Modifier.padding(end = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                group.rows.chunked(2).forEach { pair ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        pair.forEach { row -> WideRow(row, on, Modifier.weight(1f)) }
                        if (pair.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
            ResourceGroupLayout.TILE_STRIP -> if (group.rows.isEmpty()) {
                PkwText("None yet.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            } else {
                // Runs to the parchment's right edge so the cut-off tile shows there is more (the peek).
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                    group.rows.forEach { row -> ItemTile(tileOf(row, focusId), { on.focusResource(it) }, compact = true) }
                }
            }
        }
    }
}

/** A group header: 32 dp source icon, PS name, VT note, and the blue GO to the source building or island. */
@Composable private fun GroupHeader(group: ResourceGroupUi, on: HomeHudActions) {
    Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (group.icon.isNotBlank()) PkwIcon(group.icon, 32.dp)
        PkwText(group.title, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
        PkwText(group.note, PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch2)
        group.go?.let { go -> GoButton({ on.openFeature(go) }, contentDescription = "Go to ${group.title.lowercase()}") }
    }
}

/**
 * One EVERY DAY row (≥ 50 dp, cream, 2 dp ink rim): 24 dp icon, value (PS 12), source line (VT 18), and the row's own
 * action (SKR's BID → Seeker Island) as a blue button. A tap on the row shows it in the info card.
 */
@Composable private fun WideRow(row: ResourceRowUi, on: HomeHudActions, modifier: Modifier) {
    Row(modifier.heightIn(min = 50.dp).drawerCard(rowBody(row)).sceneInputRegion()
        .clickable(role = Role.Button, onClickLabel = "Show ${row.name}") { on.focusResource(row.id) }
        .padding(start = 4.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        PkwIcon(row.icon, 24.dp, alpha = if (row.empty) 0.4f else 1f, contentDescription = row.name)
        Column(Modifier.weight(1f)) {
            PkwText(count(row.value), PkwTokens.Type.label, color = if (row.empty) PkwTokens.Colors.shortText else PkwTokens.Colors.textOnParch)
            PkwText(row.earnedAt, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
        }
        val action = row.action
        if (action != null) GoButton({ on.openFeature(action) }, contentDescription = "${row.actionLabel ?: "Go"}: ${row.name}",
            label = row.actionLabel ?: "GO")
    }
}

/** A drawer tile for [row]: selected while it is the info card's row, 40 % + red count when none is owned. */
private fun tileOf(row: ResourceRowUi, focusId: String?): ItemTileUi = ItemTileUi(
    id = row.id,
    icon = row.icon,
    count = count(row.value),
    description = "${row.name}, ${count(row.value)}. ${row.earnedAt}",
    state = if (row.id == focusId) ItemTileState.SELECTED else ItemTileState.OWNED,
    divine = row.divine,
    empty = row.empty,
)

// ---- Preview data (also used by HomeHud's drawer preview) ----

private fun previewRow(id: String, icon: String, name: String, value: String, purpose: String, earnedAt: String, go: String?,
    goIcon: String? = null, empty: Boolean = false, divine: Boolean = false) =
    ResourceRowUi(id, icon, name, value, purpose, earnedAt, go?.let(::FeatureId), goIcon, empty, divine)

/** A realistic drawer: the four everyday currencies, then raw, refined and Lodge resources. Placeholder numbers. */
internal val previewDrawer = ResourceDrawerUi(
    groups = listOf(
        ResourceGroupUi("everyday", "", "EVERY DAY", "always on your top bar", null, listOf(
            previewRow("shards", "shards", "SHARDS", "40,943", "Builds and upgrades everything.", "Mine, Vault", "building.mine"),
            previewRow("gems", "gem", "GEMS", "1,250", "Finishes timers and buys supplies.", "Gold Forge", "goldforge.gems", "ui:ready-status"),
            previewRow("keep", "keep", "KEEP", "312.5", "The game's token, used at the Gold Forge.", "wallet KEEP", "goldforge.claim"),
            ResourceRowUi("skr", "skr", "SKR", "240", "Bids for spots on Seeker Island.", "wallet SKR", FeatureId("island.seeker"),
                "ui:seeker-navigation", actionLabel = "BID", action = FeatureId("island.seeker.bid")),
        ), ResourceGroupLayout.WIDE_ROWS),
        ResourceGroupUi("harvesters", "ui:harvester-menu", "HARVESTERS", "raw, one per realm", FeatureId("building.harvester"), listOf(
            previewRow("crystal", "ui:climate-kit", "FROST CRYSTAL", "14", "Refined into Frost Glass.", "Harvested in the Frost realm.", "building.harvester"),
            previewRow("timber", "ui:expedition-kit", "TIMBER", "8", "Refined into Planks.", "Harvested in the Wild realm.", "building.harvester"),
            previewRow("marble", "ui:navigation-kit", "MARBLE", "", "Refined into Cut Stone.", "Harvested in the Stone realm.", "building.harvester"),
            previewRow("sand", "ui:queue-status", "SAND", "0", "Refined into Glass.", "Harvested in the Dune realm.", "building.harvester", empty = true),
        )),
        ResourceGroupUi("workshop", "ui:workshop-menu", "WORKSHOP", "refined from raw", FeatureId("building.workshop"), listOf(
            previewRow("embercore", "ui:workshop-menu", "EMBERCORE", "1", "Builds Ember Engines and Gold Forge Lv 4.", "Refined at the Workshop.",
                "building.workshop", "ui:workshop-menu"),
            previewRow("glass", "ui:exhausted-status", "FROST GLASS", "3", "Builds the Berth's hull.", "Refined at the Workshop.", "building.workshop", "ui:workshop-menu"),
        )),
        ResourceGroupUi("lodge", "ui:lodge-menu", "LODGE", "kits, gear, renown", FeatureId("building.lodge"), listOf(
            previewRow("renown", "ui:renown", "RENOWN", "120", "Raises your Lodge rank.", "Earned on expeditions.", "building.lodge", "ui:lodge-menu"),
            previewRow("exp", "ui:exp", "EXP", "2K", "Levels your heroes.", "Earned on expeditions.", "building.lodge", "ui:lodge-menu"),
            previewRow("fragments", "ui:crystal-fragments", "CRYSTAL FRAGMENTS", "5", "Opens Divine Trials.", "Found on the Divine Isle.",
                "island.divine", "ui:divine-navigation", divine = true),
        )),
    ),
    focusRowId = "embercore",
    footnote = "Purple = Divine Isle (Crystal Fragments). Grey = none yet; tap still shows where to earn it.",
)

@Preview(name = "Resource drawer", widthDp = 412, heightDp = 915)
@Composable private fun ResourceDrawerPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) { ResourceDrawer(previewDrawer, HomeHudActions.None) }
}

@Preview(name = "Resource drawer, focused on SKR", widthDp = 412, heightDp = 915)
@Composable private fun ResourceDrawerSkrPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) { ResourceDrawer(previewDrawer.copy(focusRowId = "skr"), HomeHudActions.None) }
}
