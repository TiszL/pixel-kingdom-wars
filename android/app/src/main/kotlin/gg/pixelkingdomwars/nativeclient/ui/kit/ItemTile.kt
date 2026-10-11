package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileState
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftIcon

/**
 * Design component: ItemTile (DESIGN-SYSTEM §6, kit-2.png "ITEM TILE"): a 72 × 80 cream card with a 32 dp icon and the
 * PS 11 count. Selected: the ink shell turns gold-lo and the body #FFF3C8 with a 3 dp gold inner rim. Missing: a blood
 * shell, a #F3E6DC body, the icon at 45 % and a red count. Empty (none owned): the icon at 40 % and a red count, still
 * tappable so it can say where to earn it. NEW: a gold badge 4 dp past the right edge, 6 dp above the top. Divine Isle
 * items are lavender. The tile is its own ≥ 48 dp target.
 *
 * [compact] is the drawer variant (drawer.png `.dt`): 48 × 56, a square 2 dp ink frame (tiles in a strip touch edge to
 * edge), a 3 dp bottom band, and a #3A2F45 frame on a Divine Isle tile. `craft:` art (Phase E materials) draws through
 * the craft cluster's [CraftIcon], which hands every other name to [PkwIcon].
 */
@Composable fun ItemTile(ui: ItemTileUi, onClick: (String) -> Unit, modifier: Modifier = Modifier, compact: Boolean = false) {
    ItemTileBody(ui, onClick, modifier, compact, 32.dp)
}

/** The same 72 × 80 tile with its art at [iconSize] (Keep STORES draws HERO GEAR at 48 dp, buildings/SPEC.md E1.1). */
@Composable internal fun ItemTileSized(ui: ItemTileUi, onClick: (String) -> Unit, iconSize: Dp, modifier: Modifier = Modifier) {
    ItemTileBody(ui, onClick, modifier, false, iconSize)
}

@Composable private fun ItemTileBody(ui: ItemTileUi, onClick: (String) -> Unit, modifier: Modifier, compact: Boolean, iconSize: Dp) {
    val c = PkwTokens.Colors
    val selected = ui.state == ItemTileState.SELECTED
    val missing = ui.state == ItemTileState.MISSING
    val body = when {
        selected -> c.selectedTint
        ui.divine -> c.divine
        missing -> MISSING_BODY
        else -> c.cream
    }
    val shell = when {
        missing -> c.blood
        compact && ui.divine -> DIVINE_SHELL
        selected && !compact -> c.gold.lo
        else -> c.ink
    }
    val red = missing || ui.empty
    Box(modifier) {
        Box(Modifier.size(if (compact) PkwTokens.Dims.drawerTileW else PkwTokens.Dims.itemTileW, if (compact) PkwTokens.Dims.drawerTileH else PkwTokens.Dims.itemTileH)
            .sceneInputRegion()
            .clearAndSetSemantics {
                contentDescription = ui.description; role = Role.Button; this.selected = selected
                this.onClick(label = null, action = { onClick(ui.id); true })
            }
            .clickable(role = Role.Button) { onClick(ui.id) }
            .drawBehind {
                val w = size.width; val h = size.height; val i = 2.dp.toPx()
                if (compact) {
                    // drawer.png `.dt`: square frame, cream body, 3 dp parch-2 band.
                    drawRect(shell)
                    drawRect(body, Offset(i, i), Size(w - 2 * i, h - 2 * i))
                    band(i, w - i, h - i - 3.dp.toPx(), 3.dp.toPx(), c.creamLo)
                    if (selected) goldRim(i, w, h)
                } else {
                    fillStepped(0f, 0f, w, h, CornerProfiles.M, shell)
                    insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                        drawRect(body)
                        band(i, w - i, h - i - 4.dp.toPx(), 4.dp.toPx(), c.creamLo)
                        if (selected) goldRim(i, w, h)
                    }
                }
            }, contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(if (compact) 1.dp else 4.dp)) {
                CraftIcon(ui.icon, iconSize, alpha = when { ui.empty -> 0.4f; missing -> 0.45f; else -> 1f })
                PkwText(ui.count, PkwTokens.Type.caption, color = if (red) c.shortText else c.textOnParch)
            }
        }
        if (ui.isNew) Badge(BadgeUi("NEW", BadgeTone.REWARD, "New"), Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-6).dp))
    }
}

/** The 3 dp gold inner rim of a selected tile, just inside the [i] frame. */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.goldRim(i: Float, w: Float, h: Float) {
    val r = 3.dp.toPx()
    val gold = PkwTokens.Colors.gold.face
    drawRect(gold, Offset(i, i), Size(w - 2 * i, r))
    drawRect(gold, Offset(i, h - i - r), Size(w - 2 * i, r))
    drawRect(gold, Offset(i, i), Size(r, h - 2 * i))
    drawRect(gold, Offset(w - i - r, i), Size(r, h - 2 * i))
}

/** kit-2.png `.it.miss > .in`: the missing tile's pale blood-tinted body. */
private val MISSING_BODY = Color(0xFFF3E6DC)
/** drawer.png: the Divine Isle tile's frame. */
private val DIVINE_SHELL = Color(0xFF3A2F45)

@Preview(name = "Item tiles", widthDp = 380, heightDp = 200)
@Composable private fun ItemTilePreview() {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ItemTile(ItemTileUi("ore", "ui:climate-kit", "x14", "Climate kit, 14"), {})
            ItemTile(ItemTileUi("ingot", "ui:expedition-kit", "x3", "Expedition kit, 3, selected", ItemTileState.SELECTED), {})
            ItemTile(ItemTileUi("crate", "ui:navigation-kit", "0", "Navigation kit, none", ItemTileState.MISSING), {})
            ItemTile(ItemTileUi("rope", "ui:renown", "x1", "Renown, 1, new", isNew = true), {})
        }
        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            ItemTile(ItemTileUi("exp", "ui:exp", "2K", "EXP 2,000"), {}, compact = true)
            ItemTile(ItemTileUi("frag", "ui:crystal-fragments", "5", "Crystal Fragments 5", divine = true), {}, compact = true)
            ItemTile(ItemTileUi("none", "ui:navigation-kit", "0", "None yet", empty = true), {}, compact = true)
        }
    }
}
