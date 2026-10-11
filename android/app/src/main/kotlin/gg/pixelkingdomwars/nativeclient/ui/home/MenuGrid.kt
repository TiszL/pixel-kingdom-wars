package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate

/**
 * The player menu grid (web hudOverflow.tsx `HudOverflowPanel`): every entry is a forged stone
 * cell — icon, a gold VALUE and a muted LABEL — instead of a uniform text row. The same cells
 * fill the MORE tab, so the two surfaces read as one menu.
 *
 * Three kinds of cell, told apart on purpose (web Row): one with [MenuCellSpec.onClick] is a
 * control and answers a press; one without is a READOUT (energy) and deliberately answers nothing;
 * `enabled = false` is a control that exists but is currently refused, drawn dimmed rather than
 * byte-identical to a readout so the player learns why the tap did nothing.
 */
data class MenuCellSpec(
    val art: String,
    val label: String,
    val value: String? = null,
    /** WAITING FOR THE PLAYER (a claimable cache, escrowed mail rewards, a deed still to choose): gold rim. */
    val hot: Boolean = false,
    val enabled: Boolean = true,
    /** Full sentence for TalkBack; the visible value/label split stays terse. */
    val description: String? = null,
    val onClick: (() -> Unit)? = null,
)

/** Web `repeat(auto-fill, minmax(132px, 1fr))`: two columns on a phone, three once the panel is
 * wide enough (landscape popover, tablet). Width decides, never orientation, so a near-square
 * window cannot flip the grid mid-rotation. Presentation only. */
internal fun menuColumns(panelWidthDp: Int): Int = if (panelWidthDp >= 560) 3 else 2

/** Rows of equal-width cells; a partial last row keeps the same cell width by padding with spacers. */
@Composable fun MenuGrid(cells: List<MenuCellSpec>, columns: Int, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        cells.chunked(columns.coerceAtLeast(1)).forEach { row ->
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { MenuCell(it, Modifier.weight(1f).fillMaxHeight()) }
                repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable fun MenuCell(spec: MenuCellSpec, modifier: Modifier = Modifier) {
    val pressable = spec.onClick != null
    PixelPlate("shard", modifier.heightIn(min = 56.dp)
        .then(if (spec.hot) Modifier.border(2.dp, Palette.goldDp) else Modifier)
        .alpha(if (spec.enabled) 1f else .55f)
        .then(spec.description?.let { Modifier.semantics(mergeDescendants = true) { contentDescription = it } } ?: Modifier)
        .then(if (pressable) Modifier.clickable(enabled = spec.enabled, role = Role.Button, onClick = spec.onClick!!) else Modifier),
        PaddingValues(horizontal = 8.dp, vertical = 6.dp)) {
        Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (spec.art == "chat") ChatGlyph(Modifier.size(22.dp)) else GameArt(spec.art, Modifier.size(22.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.Center) {
                spec.value?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        color = if (!spec.enabled) Palette.muted else if (spec.hot) Palette.goldHi else Palette.gold)
                }
                Text(spec.label, style = if (spec.value == null) MaterialTheme.typography.labelMedium else MaterialTheme.typography.labelSmall,
                    maxLines = 2, overflow = TextOverflow.Ellipsis, color = if (spec.value == null && spec.enabled) Palette.text else Palette.muted)
            }
        }
    }
}

/** Web ChatLauncher is a drawn pixel speech bubble, not an unrelated info sprite. */
@Composable internal fun ChatGlyph(modifier: Modifier) {
    Canvas(modifier) {
        val pixel = size.width / 24f
        val ink = Color(0xFF1A171E)
        val gold = Color(0xFFF4D77B)
        drawRect(ink, topLeft = androidx.compose.ui.geometry.Offset(3 * pixel, 5 * pixel), size = androidx.compose.ui.geometry.Size(21 * pixel, 17 * pixel))
        drawRect(gold, topLeft = androidx.compose.ui.geometry.Offset(0f, 2 * pixel), size = androidx.compose.ui.geometry.Size(23 * pixel, 17 * pixel))
        drawRect(ink, topLeft = androidx.compose.ui.geometry.Offset(2 * pixel, 4 * pixel), size = androidx.compose.ui.geometry.Size(19 * pixel, 13 * pixel))
        listOf(5, 10, 15).forEach { x -> drawRect(gold, topLeft = androidx.compose.ui.geometry.Offset(x * pixel, 9 * pixel), size = androidx.compose.ui.geometry.Size(3 * pixel, 3 * pixel)) }
        drawRect(gold, topLeft = androidx.compose.ui.geometry.Offset(4 * pixel, 18 * pixel), size = androidx.compose.ui.geometry.Size(3 * pixel, 3 * pixel))
    }
}
