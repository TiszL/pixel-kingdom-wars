package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.ItemTileSized
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetTitlePlate
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.VeilChip
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.kit.livingSheetWoodPadding
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileState
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.StackedTabs
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftIcon

/*
 * Design component: Keep STORES (design/final/buildings/SPEC.md E1.1, keep-stores.png; registry row 33,
 * `Destination.KeepStores(tab)`, default BAG): one place for everything the kingdom holds that is not a top-bar
 * currency, what each thing is for, and one door per thing (USE here, or GO to the building that uses it). Tabs BAG ·
 * MATERIALS · KITS · COLLECTION; groups of item tiles; the detail card of the selected tile; GO + USE footer.
 */

/** One item in the stores (SPEC E1.1 `StoreItemUi`). */
@Immutable data class StoreItemUi(
    /** Stable item id. */
    val id: String,
    /** Its art (item art at 32 dp; HERO GEAR at 48; 24 px HUD icons stand in for consumables). */
    val icon: String,
    /** Name ("FINISHER'S SEAL"). */
    val name: String,
    /** The count as a number string ("3"); "…" while unknown (busy USE included), never "0" for unknown. */
    val count: String,
    /** "2 reserved by a job"; null draws none. */
    val reserved: String?,
    /** The gold NEW badge. */
    val isNew: Boolean,
    /** What it does, one VT line ("Finishes a build with under 2h left."). */
    val whatItDoes: String,
    /** What it would do right now ("Your Workshop has 1h 12m to go."); null draws none. */
    val rightNow: String?,
    /** The building id the server says it applies to (USE target); null = not usable from the Keep. */
    val useTarget: String?,
    /** A USE whose answer was lost: "Being checked" on the tile (CHECK stays); never "Nothing was spent". */
    val checking: Boolean = false,
)

/** One group of the active tab (SPEC E1.1 `StoreGroupUi`). */
@Immutable data class StoreGroupUi(
    /** Stable group id (handed back by `onGroupGo`). */
    val id: String,
    /** 32 dp group icon. */
    val icon: String,
    /** PS 12 name ("HERO GEAR"). */
    val title: String,
    /** VT 18 note ("wear on heroes"); ellipsised so the GO stays inside the parchment gutter. */
    val note: String,
    /** Where its blue destination button goes (spec type `Destination`; the registry row here); null = no button. */
    val go: FeatureId?,
    /** Its tiles (a strip scrolls sideways past 4, with a peek of the 5th). */
    val items: List<StoreItemUi>,
    /** The destination button's label, naming where it goes ("ALTAR", "BARRACKS"); never a bare "GO". */
    val goLabel: String? = null,
    /** The building is not built: tiles dimmed, the GO replaced by this line ("Build the Lodge at Keep Lv 8"). */
    val locked: String? = null,
)

/** Everything Keep STORES draws (SPEC E1.1 `KeepStoresUi`). */
@Immutable data class KeepStoresUi(
    /** The Keep level (header tag and the realm-kit Keep art); 0 while unknown (the tag reads "LV …", never "LV 0"). */
    val keepLevel: Int,
    /** The active tab. */
    val tab: StoresTab,
    /** A gold NEW badge on a tab with an unseen item (null = none). */
    val tabBadges: Map<StoresTab, BadgeUi?>,
    /** The active tab's groups, top to bottom. Loading keeps the last good groups; counts never blank. */
    val groups: List<StoreGroupUi>,
    /** The selected tile (the detail card); null draws none. */
    val selected: StoreItemUi?,
    /** The selected item's own job ("USE" + VT "finish the Workshop now"); null when it cannot be used from the Keep. */
    val primary: CommandUi?,
    /** The blue GO to the target building ("GO" + VT "Workshop"); null = none. */
    val go: CommandUi?,
    /** True while refreshing: the 2 dp stone line under the tabs. */
    val loading: Boolean,
    /** "2 min ago" while a refresh failed: the "Updated n min ago" row with a stone CHECK. */
    val staleSince: String?,
    /** A read-only base: every USE is off with this reason; GO still works. */
    val readOnly: String?,
    /** The active tab's empty state ("Nothing here yet", where it comes from, blue GO); used when [groups] is empty. */
    val empty: EmptyStateUi? = null,
    /** Draws the stone History square; false when the host has no history to open (a door never does nothing). */
    val history: Boolean = true,
)

/** The HERO GEAR group id: its tiles draw their art at 48 dp (SPEC E1.1); every other group at the kit's 32. */
internal const val STORES_HERO_GEAR = "hero-gear"

/** Keep STORES callbacks (SPEC E1.1). */
class KeepStoresActions(
    /** A tab. */
    val onTab: (StoresTab) -> Unit,
    /** A tile: selects it (gold rim + 1.04 for 90 ms). */
    val onItem: (String) -> Unit,
    /** USE (item id, target building id): the live host calls the Inventory screen's own one-tap item-use owner (no new
     *  consent; never a Seal: nothing here costs money). */
    val onUse: (String, String?) -> Unit,
    /** GO / an EmptyState GO: sheet handoff, the camera flies. */
    val onGo: (FeatureId) -> Unit,
    /** A group's destination button. */
    val onGroupGo: (String) -> Unit,
    /** Stone History. */
    val onHistory: () -> Unit,
    /** Red close / Back / the scrim. */
    val onClose: () -> Unit,
    /** CHECK on the "Updated n min ago" row or on an uncertain USE: re-reads the stores. */
    val onCheck: () -> Unit = {},
    /** A refused primary (DISABLED / LOCKED): the host shows its reason. */
    val onRefused: (CommandUi) -> Unit = {},
)

/** The tab strip's icons (stacked tabs: icon 24 above a PS 11 label). */
private fun storesTabs(badges: Map<StoresTab, BadgeUi?>): List<TabUi> = listOf(
    TabUi(StoresTab.BAG.name, "backpack", "BAG", badges[StoresTab.BAG], false),
    TabUi(StoresTab.MATERIALS.name, "ui:crystal-fragments", "MATERIALS", badges[StoresTab.MATERIALS], false),
    TabUi(StoresTab.KITS.name, "ui:expedition-kit", "KITS", badges[StoresTab.KITS], false),
    TabUi(StoresTab.COLLECTION.name, "star", "COLLECTION", badges[StoresTab.COLLECTION], false),
)

/**
 * The Keep STORES tall sheet (keep-stores.png). [modifier] must give it a bounded height (the SheetHost: y 104 to the
 * bottom). Living header 136 (building-sheet grass + the realm-kit Keep, frame 0 at a whole scale; title "KEEP LV 12";
 * stone History + red close; live chip "14 in your bag"); stacked tabs; the parchment body with the groups and the
 * detail card; the pinned GO + USE footer. Tab changes cross-fade 120 ms; [scrollState] is hoisted for the SheetHost.
 *
 * Pointer rule: a painted panel inside the SheetHost; no full-screen clickable, pointerInput, scrim or draggable here. The
 * 40 % scrim over the world strip is the SheetHost's (`SheetScrim(SheetSize.TALL)`), composed only while it is shown.
 */
@Composable fun KeepStoresSheet(ui: KeepStoresUi, on: KeepStoresActions, modifier: Modifier = Modifier,
    scrollState: ScrollState = rememberScrollState()) {
    val reduced = LocalReducedMotion.current
    // Tab cross-fade 120 ms (reduced motion: the same 120 ms fade, no slide).
    val fade = remember { Animatable(1f) }
    var lastTab by remember { mutableStateOf(ui.tab) }
    LaunchedEffect(ui.tab) {
        if (lastTab == ui.tab) return@LaunchedEffect
        lastTab = ui.tab
        fade.snapTo(0f)
        fade.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.TAB_SWITCH))
    }
    // keep-stores.png: the living header runs full-bleed inside the 3 dp ink rim (its own 3 dp ink rule underneath);
    // the tabs and the parchment sit 8 dp inside the wood below it.
    Plate(PlateKind.WOOD, modifier, contentPadding = livingSheetWoodPadding()) {
        Column(Modifier.fillMaxSize()) {
            KeepHeader(ui, on)
            Column(Modifier.fillMaxWidth().weight(1f).padding(start = 8.dp, top = 8.dp, end = 8.dp)) {
                StackedTabs(storesTabs(ui.tabBadges), ui.tab.name, { id -> StoresTab.entries.firstOrNull { it.name == id }?.let(on.onTab) })
                if (ui.loading) LoadingLine()
                // The parchment's right gutter belongs to each row (end = 8) so a strip can run to the edge (the peek).
                Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(start = 8.dp, top = 2.dp),
                    blocksScene = false) {
                    Column(Modifier.fillMaxSize()) {
                        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(scrollState).graphicsLayer { alpha = fade.value },
                            verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            ui.staleSince?.let { StaleRow(it, on) }
                            val empty = ui.empty
                            if (ui.groups.isEmpty() && empty != null) EmptyState(empty, on.onGo, Modifier.padding(top = 8.dp, end = 8.dp))
                            ui.groups.forEach { GroupBlock(it, ui.selected?.id, on) }
                            ui.selected?.let { DetailCard(it) }
                        }
                        StoresFooterRow(ui, on)
                    }
                }
            }
        }
    }
}

/** The living header: grass, the Keep (frame 0 of its idle strip), title plate, History + close, the bag chip. */
@Composable private fun KeepHeader(ui: KeepStoresUi, on: KeepStoresActions) {
    Box(Modifier.fillMaxWidth().height(PkwTokens.Dims.sheetHeaderH).clipToBounds().drawBehind { drawHeaderGrass() }) {
        R2Art("ui:keep-l${ui.keepLevel.coerceIn(1, 20)}-idle", 160.dp, 132.dp, Modifier.align(Alignment.BottomCenter).padding(start = 48.dp))
        SheetTitlePlate("KEEP", Modifier.align(Alignment.TopStart).padding(6.dp), if (ui.keepLevel > 0) "LV ${ui.keepLevel}" else "LV $UNKNOWN")
        Row(Modifier.align(Alignment.TopEnd).padding(top = 4.dp, end = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (ui.history) IconSquare("replay", Verb.STONE, on.onHistory, "History")
            CloseSquare(on.onClose)
        }
        VeilChip(storesChipLine(ui.tab, ui.groups), Modifier.align(Alignment.BottomStart).padding(start = 6.dp, bottom = 9.dp), icon = "backpack")
    }
}

/** "Updated 2 min ago" + stone CHECK (the error state keeps the last good view). */
@Composable private fun StaleRow(since: String, on: KeepStoresActions) {
    Row(Modifier.fillMaxWidth().padding(top = 6.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PkwText("Updated $since", PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch2)
        SecondaryButton("CHECK", on.onCheck, contentDescription = "Check the stores again")
    }
}

/**
 * A group: header 44 (icon 32, PS 12 name, VT 18 note ellipsised, then the named blue destination button 44 tall inside
 * the 8 dp gutter, or the locked line; SPEC E1.3: the note gives way, never the button) + its strip of 72 × 80 tiles
 * that runs to the parchment edge so a fifth tile peeks.
 */
@Composable private fun GroupBlock(group: StoreGroupUi, selectedId: String?, on: KeepStoresActions) {
    val c = PkwTokens.Colors
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp, end = 8.dp).heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwIcon(group.icon, 32.dp)
            PkwText(group.title, PkwTokens.Type.label, color = c.textOnParch)
            PkwText(group.note, PkwTokens.Type.small, Modifier.weight(1f), color = c.textOnParch2)
            val go = group.go
            val label = group.goLabel
            if (group.locked == null && go != null && label != null) GroupGo(label) { on.onGroupGo(group.id) }
        }
        group.locked?.let { PkwText(it, PkwTokens.Type.small, Modifier.padding(end = 8.dp), color = c.textOnParch2, maxLines = 2) }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 6.dp, start = 2.dp, end = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            val art = if (group.id == STORES_HERO_GEAR) 48.dp else 32.dp
            group.items.forEach { item -> StoreTile(item, item.id == selectedId, dimmed = group.locked != null, art, on) }
        }
    }
}

/** The group's blue destination button (keep-stores.png: 44 tall, PS 11 outlined, as wide as its name; "ALTAR" 88,
 *  "BARRACKS" 104). It names where it goes; never a bare "GO". */
@Composable private fun GroupGo(label: String, onClick: () -> Unit) {
    ChunkyBox(PkwTokens.Colors.blue, onClick, "Go to the ${label.lowercase()}", Modifier.height(44.dp).widthIn(min = 88.dp)) {
        PkwText(label, PkwTokens.Type.caption, Modifier.padding(horizontal = 8.dp), color = PkwTokens.Colors.label, outline = 1.dp)
    }
}

/** One 72 × 80 tile ("×3"); selected = gold rim and a 1.04 pop for 90 ms; an uncertain USE reads "Being checked". */
@Composable private fun StoreTile(item: StoreItemUi, selected: Boolean, dimmed: Boolean, art: Dp, on: KeepStoresActions) {
    val reduced = LocalReducedMotion.current
    // Select = gold rim + a 1.04 pop for 90 ms (SPEC E1.1 motion), then back to 1.
    val pop = remember { Animatable(1f) }
    LaunchedEffect(selected) {
        if (!selected || reduced) { pop.snapTo(1f); return@LaunchedEffect }
        pop.animateTo(1.04f, tween(PkwTokens.Motion.RELEASE / 2)); pop.animateTo(1f, tween(PkwTokens.Motion.RELEASE / 2))
    }
    val count = if (item.checking) UNKNOWN else storesCount(item.count)
    val spoken = listOfNotNull(item.name, count, item.reserved, if (item.checking) BEING_CHECKED else null, if (item.isNew) "new" else null)
        .joinToString(", ")
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        ItemTileSized(ItemTileUi(item.id, item.icon, count, spoken, if (selected) ItemTileState.SELECTED else ItemTileState.OWNED, isNew = item.isNew),
            on.onItem, art, Modifier.graphicsLayer { scaleX = pop.value; scaleY = pop.value; alpha = if (dimmed) 0.5f else 1f })
        if (item.checking) PkwText(BEING_CHECKED, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    }
}

/** The detail card (CreamCard 76): a 64 dp dark glowing well with the 48 dp art, PS 12 "NAME ×n" on one line, then the
 *  VT 18 lines: what it does, what it would do right now, what is reserved. Paint only (the tiles are the targets). */
@Composable private fun DetailCard(item: StoreItemUi) {
    val c = PkwTokens.Colors
    TapCard(Modifier.fillMaxWidth().padding(top = 2.dp, end = 8.dp).heightIn(min = 76.dp),
        padding = PaddingValues(start = 6.dp, top = 4.dp, end = 8.dp, bottom = 8.dp),
        description = listOfNotNull(item.name, storesCount(item.count), item.whatItDoes, item.rightNow, item.reserved).joinToString(". ")) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(64.dp).drawBehind { drawDetailWell() }, contentAlignment = Alignment.Center) { CraftIcon(item.icon, 48.dp) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                PkwText("${item.name} ${storesCount(item.count)}", PkwTokens.Type.label, color = c.textOnParch)
                PkwText(item.whatItDoes, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
                item.rightNow?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2) }
                item.reserved?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2) }
            }
        }
    }
}

/** keep-stores.png `.well.glow`: a 2 dp ink frame round a dark well that glows warm at its centre. */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawDetailWell() {
    val i = 2.dp.toPx()
    drawRect(PkwTokens.Colors.ink)
    drawRect(Brush.radialGradient(0f to WELL_GLOW, 0.3f to WELL_GLOW, 0.7f to WELL_DARK, 1f to WELL_DARK,
        center = Offset(size.width / 2f, size.height * 0.6f), radius = size.width / 2f),
        Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
}

private val WELL_GLOW = Color(0xFF5A3A22)
private val WELL_DARK = Color(0xFF2A2026)

/** The footer (SPEC E1.1): blue GO 96 × 60 (PS 11 "GO" + the VT place) + the gold USE primary with its VT sub, or a
 *  full-width blue GO alone. A read-only base turns USE off with the reason; GO still works. */
@Composable private fun StoresFooterRow(ui: KeepStoresUi, on: KeepStoresActions) {
    val primary = ui.primary
    val go = ui.go
    val selected = ui.selected
    val layout = storesFooter(primary, go)
    if (layout == StoresFooter.NONE) return
    Row(Modifier.fillMaxWidth().padding(top = 8.dp, end = 8.dp, bottom = 14.dp), verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (go != null) {
            val goMod = if (layout == StoresFooter.GO_ONLY) Modifier.weight(1f) else Modifier.width(96.dp)
            ChunkyBox(PkwTokens.Colors.blue, { on.onGo(go.id) }, listOfNotNull(go.caption, go.sub).joinToString(" "),
                goMod.height(PkwTokens.Dims.sheetPrimaryH)) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    PkwText(go.caption, PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
                    go.sub?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.label) }
                }
            }
        }
        if (primary != null) {
            val drawn = commandDrawState(primary)
            val state = if (drawn != CommandState.BUSY && ui.readOnly != null) CommandState.DISABLED else drawn
            val tap = {
                when (state) {
                    CommandState.ENABLED -> if (selected != null) on.onUse(selected.id, selected.useTarget) else Unit
                    CommandState.BUSY -> Unit
                    else -> on.onRefused(primary)
                }
            }
            PrimaryButton(primary.caption, tap, Modifier.weight(1f), sub = primary.sub, state = state,
                reason = ui.readOnly ?: primary.reason)
        }
    }
}

// ---- Previews ----

private fun item(id: String, icon: String, name: String, count: String, what: String, isNew: Boolean = false, now: String? = null, target: String? = null) =
    StoreItemUi(id, icon, name, count, null, isNew, what, now, target)

private val bagGroups = listOf(
    StoreGroupUi("use-now", "timer", "USE NOW", "speed-ups and shields", null, listOf(
        item("keg-haste", "pkw_web_icon_swiftboots", "KEG OF HASTE", "3", "Speeds up training for 1h."),
        item("finishers-seal", "timer", "FINISHER'S SEAL", "1", "Finishes a build with under 2h left.", now = "Your Workshop has 1h 12m to go.", target = "workshop-1"),
        item("powder", "pkw_web_icon_powdercharge", "POWDER CHARGE", "2", "Blasts one wall in a raid."),
        item("aegis", "shield", "WARZONE AEGIS", "1", "A 4h shield."))),
    StoreGroupUi("hero-gear", "itm_helm", "HERO GEAR", "wear on heroes", FeatureId("heroaltar.gear"), listOf(
        item("helm", "itm_helm", "IRON HELM", "1", "Hero HP +4%.", isNew = true), item("ring", "itm_ring", "OPAL RING", "1", "Skill damage +3%."),
        item("cloak", "itm_cloak", "DUSK CLOAK", "2", "Dodge +2%."), item("chest", "itm_chest", "OAK CHEST", "1", "Armour +5.")), goLabel = "ALTAR"),
    StoreGroupUi("writs", "ui_portrait_mage_t1", "WRITS", "unlock troops", FeatureId("barracks.train"), listOf(
        item("writ-mage", "ui_portrait_mage_t1", "MAGE WRIT", "1", "Unlocks the Mage at the Barracks."),
        item("contract-theo", "hero_theo_portrait", "THEODOR CONTRACT", "1", "Recruits Theodor.")), goLabel = "BARRACKS"),
)

private val sampleStores = KeepStoresUi(
    keepLevel = 12, tab = StoresTab.BAG, tabBadges = mapOf(StoresTab.MATERIALS to null), groups = bagGroups,
    selected = bagGroups[0].items[1],
    primary = CommandUi(FeatureId("keep.stores.use"), "", "USE", null, true, CommandState.ENABLED, null, null, sub = "finish the Workshop now"),
    go = CommandUi(FeatureId("focus.workshop-1"), "", "GO", null, false, CommandState.ENABLED, null, null, verb = Verb.BLUE, sub = "Workshop"),
    loading = false, staleSince = null, readOnly = null,
)
private val previewActions = KeepStoresActions(onTab = {}, onItem = {}, onUse = { _, _ -> }, onGo = {}, onGroupGo = {}, onHistory = {}, onClose = {})

@Composable private fun StoresPreviewFrame(ui: KeepStoresUi) {
    Box(Modifier.size(412.dp, 915.dp).background(PkwTokens.Colors.scrim)) {
        KeepStoresSheet(ui, previewActions, Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp, top = PkwTokens.Dims.tallSheetTop))
    }
}

@Preview(name = "Keep STORES: BAG (keep-stores.png)", widthDp = 412, heightDp = 915)
@Composable private fun StoresBagPreview() = StoresPreviewFrame(sampleStores)

@Preview(name = "Keep STORES: empty KITS tab", widthDp = 412, heightDp = 915)
@Composable private fun StoresEmptyPreview() = StoresPreviewFrame(sampleStores.copy(tab = StoresTab.KITS, groups = emptyList(), selected = null, primary = null, go = null,
    empty = EmptyStateUi("ui:expedition-kit", "Nothing here yet", "Kits are crafted at the Workshop and found on voyages.", "GO TO WORKSHOP", FeatureId("workshop.tools"))))

@Preview(name = "Keep STORES: loading + error (updated 2 min ago) + locked group", widthDp = 412, heightDp = 915)
@Composable private fun StoresStalePreview() = StoresPreviewFrame(sampleStores.copy(loading = true, staleSince = "2 min ago",
    groups = bagGroups.dropLast(1) + bagGroups.last().copy(locked = "Build the Barracks at Keep Lv 2")))

@Preview(name = "Keep STORES: USE busy, uncertain tile, read-only base, GO only", widthDp = 1236, heightDp = 915)
@Composable private fun StoresStatesPreview() {
    Row {
        Box(Modifier.width(412.dp)) { StoresPreviewFrame(sampleStores.copy(primary = sampleStores.primary?.copy(caption = "Using", state = CommandState.BUSY),
            selected = sampleStores.selected?.copy(count = UNKNOWN))) }
        Box(Modifier.width(412.dp)) { StoresPreviewFrame(sampleStores.copy(groups = listOf(bagGroups[0].copy(items = bagGroups[0].items.mapIndexed { i, it ->
            if (i == 1) it.copy(checking = true) else it })), readOnly = "Viewing another kingdom")) }
        Box(Modifier.width(412.dp)) { StoresPreviewFrame(sampleStores.copy(selected = bagGroups[1].items[0], primary = null,
            go = CommandUi(FeatureId("heroaltar.gear"), "", "GO TO ALTAR", null, false, CommandState.ENABLED, null, null, verb = Verb.BLUE, sub = "wear it on Vex"))) }
    }
}

@Preview(name = "Keep STORES: NEW badge on a tab", widthDp = 412, heightDp = 120)
@Composable private fun StoresTabsPreview() {
    Box(Modifier.background(PkwTokens.Colors.wood).padding(8.dp)) {
        StackedTabs(storesTabs(mapOf(StoresTab.KITS to BadgeUi("NEW", BadgeTone.REWARD, "New kit"))), StoresTab.BAG.name, {})
    }
}
