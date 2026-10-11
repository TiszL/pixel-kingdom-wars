package gg.pixelkingdomwars.nativeclient.ui.kingdom

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.pixelkingdomwars.nativeclient.renderer.BaseCameraView
import gg.pixelkingdomwars.nativeclient.renderer.BaseScene
import gg.pixelkingdomwars.nativeclient.scene.BuildingRooflines
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/** Camera coordinates have a physical left edge, independent of the device's text direction. */
internal val ArmyChipAlignment = AbsoluteAlignment.TopLeft

/** Where each chip was last placed, in surface pixels. A tap the scene reports inside one opens that building, the
 * same sheet its footprint opens; the chip itself takes no pointer input, so a pan may start on it. */
internal class ArmyChipHits {
    private val placed = HashMap<String, IntArray>()
    fun place(id: String, left: Int, top: Int, width: Int, height: Int) { placed[id] = intArrayOf(left, top, left + width, top + height) }
    fun retain(ids: Set<String>) { placed.keys.retainAll(ids) }
    fun remove(id: String) { placed.remove(id) }
    fun atScreen(view: BaseCameraView?, x: Float, y: Float): String? {
        if (view == null || !view.overlayVisible) return null
        return placed.entries.firstOrNull { (_, r) -> x >= r[0] && x < r[2] && y >= r[1] && y < r[3] }?.key
    }
    fun buildingAt(view: BaseCameraView?, tileX: Float, tileY: Float, tilePixels: Float): String? {
        if (view == null || !view.overlayVisible) return null
        val x = view.screenX(tileX * tilePixels); val y = view.screenY(tileY * tilePixels)
        return atScreen(view, x, y)
    }
}

/** World-anchored army chips over the Home scene. The camera is read only where a chip is placed, so a pan re-places
 * the chips without recomposing or re-measuring them; wording and size change with the zoom alone. */
@Composable internal fun ArmyChipLayer(chips: List<ArmyChip>, scene: BaseScene, assets: File, render: JsonObject,
    camera: State<BaseCameraView?>, hits: ArmyChipHits, modifier: Modifier = Modifier) {
    val carried = chips.mapNotNull { chip -> scene.buildings.firstOrNull { it.id == chip.buildingId } }
    var anchors by remember(assets) { mutableStateOf(emptyMap<String, ArmyChipAnchor>()) }
    LaunchedEffect(assets, render, scene.tilePixels, carried) {
        anchors = withContext(Dispatchers.IO) {
            carried.mapNotNull { building ->
                val roof = BuildingRooflines.measuredRoof(assets, render, building, scene.tilePixels) ?: return@mapNotNull null
                building.id to ArmyChipAnchor((building.tileX + building.footprintWidth / 2) * scene.tilePixels, roof, building.footprintWidth * scene.tilePixels)
            }.toMap()
        }
    }
    hits.retain(chips.mapNotNullTo(HashSet()) { chip -> chip.buildingId.takeIf { it in anchors } })
    Box(modifier.clipToBounds(), contentAlignment = ArmyChipAlignment) {
        for (chip in chips) key(chip.buildingId) { anchors[chip.buildingId]?.let { anchor -> AnchoredArmyChip(chip, anchor, scene, camera, hits) } }
    }
}

@Composable private fun AnchoredArmyChip(chip: ArmyChip, anchor: ArmyChipAnchor, scene: BaseScene, camera: State<BaseCameraView?>, hits: ArmyChipHits) {
    val density = LocalDensity.current
    // Zoom alone decides wording and size; a pan leaves this value, and so the composition, untouched.
    val layout by remember(chip, anchor, density, scene.baseId) { derivedStateOf {
        camera.value?.takeIf { it.baseId == scene.baseId && it.overlayVisible }?.let { view ->
            val zoom = view.scale / density.density
            armyChipLayout(chip, anchor.footprintWidth * zoom, zoom, density.fontScale)
        }
    } }
    val shown = layout
    if (shown == null) hits.remove(chip.buildingId) else {
        val minGap = with(density) { ArmyChipMetrics.MIN_GAP_DP.dp.toPx() }
        val band = with(density) { (if (chip.aboveJob) gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Dims.timerPlateH + 8.dp else 0.dp).toPx() }
        Box(Modifier.layout { measurable, _ ->
            val placeable = measurable.measure(Constraints())
            layout(0, 0) {
                val at = armyChipOffset(camera.value?.takeIf { it.baseId == scene.baseId }, anchor, placeable.width, placeable.height, scene.tilePixels, minGap, band)
                if (at == null) hits.remove(chip.buildingId)
                else { hits.place(chip.buildingId, at.first, at.second, placeable.width, placeable.height); placeable.place(at.first, at.second) }
            }
        }) { ArmyChipPlate(chip, shown) }
    }
}

/** The HUD's own currency-well plate, the pixel font and the bundled icon set, at the chip's scale. */
@Composable private fun ArmyChipPlate(chip: ArmyChip, layout: ArmyChipLayout) {
    val k = layout.scale
    val colour = when (chip.tone) { ArmyChipTone.OVER -> Palette.danger; ArmyChipTone.FULL -> Palette.gold; ArmyChipTone.TRAINING -> Palette.goldHi; ArmyChipTone.NORMAL -> Palette.text }
    val style = MaterialTheme.typography.labelSmall.copy(fontSize = (ArmyChipMetrics.FONT_SP * k).sp, lineHeight = (ArmyChipMetrics.FONT_SP * k).sp, letterSpacing = 0.sp)
    PixelPlate("shard", Modifier.clearAndSetSemantics { contentDescription = chip.description },
        PaddingValues((ArmyChipMetrics.PAD_H_DP * k).dp, (ArmyChipMetrics.PAD_V_DP * k).dp), blocksScene = false) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy((ArmyChipMetrics.ICON_GAP_DP * k).dp)) {
                GameArt(if (chip.kind == ArmyChipKind.CAMP) "itm_helm" else "timer", Modifier.size((ArmyChipMetrics.ICON_DP * k).dp), trimmed = true)
                Text(layout.label.first(), color = colour, style = style, maxLines = 1, softWrap = false)
            }
            layout.label.drop(1).forEach { Text(it, color = colour, style = style, maxLines = 1, softWrap = false) }
        }
    }
}
