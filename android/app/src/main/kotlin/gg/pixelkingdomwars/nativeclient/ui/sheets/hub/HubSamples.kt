package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi

/**
 * Preview-only sample data and backdrop shared by the hub cluster's @Preview functions (the numbers of the design/final/hub PNGs).
 * Every number here is a placeholder, exactly as in the mockups; nothing reads these outside previews.
 */

/** A sample door for previews. */
internal fun sampleLink(feature: String): HubLink = HubLink(FeatureId(feature))

/** The SHARDS + GEMS RewardReadouts of quests.png / mail.png. */
internal val sampleReadouts = listOf(
    ResourceChipUi(FeatureId("hud.shards"), "shards", "40,943", 0.62f, false, null, name = "Shards", accent = ResourceAccent.SHARDS),
    ResourceChipUi(FeatureId("hud.gems"), "gem", "1,250", null, false, null, name = "Gems", accent = ResourceAccent.GEMS),
)

/** The SHARDS-only readout of leagues.png. */
internal val sampleShardsReadout = sampleReadouts.take(1)

/** A 412 × 915 preview stage: a flat stand-in for the parked world, the card placed where the SheetHost puts it. */
@Composable internal fun HubPreviewStage(content: @Composable BoxScope.() -> Unit) {
    Box(Modifier.fillMaxSize().background(Color(0xFF2F4A2A))) {
        Box(Modifier.fillMaxSize().background(PkwTokens.Colors.scrim.copy(alpha = PkwTokens.Scrim.FULL_CARD))
            .padding(start = 8.dp, end = 8.dp, top = 14.dp, bottom = 14.dp), content = content)
    }
}
