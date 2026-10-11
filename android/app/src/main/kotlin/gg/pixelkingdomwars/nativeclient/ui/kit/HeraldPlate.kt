package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion

/**
 * Design component: the herald's plate (DESIGN-SYSTEM §6 Banner, kit-2.png "BANNER", hub SPEC §3.1) around any content,
 * for a herald line that must carry its own actions (the interrupted-request recovery). [HeraldBanner] stays the one
 * tappable sentence; this is the same plate: an ink M shell 3 dp, a 2 dp gold-lo inner rim on the dark gold face with its
 * 3 dp lighter top band, at most [HERALD_PLATE_MAX_W] wide so it stays clear of the QUESTS edge button.
 *
 * Pointer rule: a painted panel, so a scene-input region; never full-screen, never a scrim.
 */
@Composable fun HeraldPlate(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.widthIn(max = HERALD_PLATE_MAX_W).heightIn(min = PkwTokens.Dims.bannerH).sceneInputRegion()
        .drawBehind {
            val w = size.width; val h = size.height
            fillStepped(0f, 0f, w, h, CornerProfiles.M, PkwTokens.Colors.ink)
            val i = 3.dp.toPx()
            insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                drawRect(PkwTokens.Colors.gold.lo)
                val j = i + 2.dp.toPx()
                drawRect(HERALD_PLATE_FACE, Offset(j, j), Size(w - 2 * j, h - 2 * j))
                drawRect(HERALD_PLATE_BAND, Offset(j, j), Size(w - 2 * j, 3.dp.toPx()))
            }
        }.padding(horizontal = 13.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp), content = content)
}

/** Hub SPEC §3.1 geometry: the herald is 336 dp wide (x 8..344), clear of the QUESTS edge button. */
internal val HERALD_PLATE_MAX_W = 336.dp

/** The herald's dark gold face and its top band (kit-2.png #2A2016 / #3A2B18), as [HeraldBanner] draws them. */
private val HERALD_PLATE_FACE = Color(0xFF2A2016)
private val HERALD_PLATE_BAND = Color(0xFF3A2B18)
