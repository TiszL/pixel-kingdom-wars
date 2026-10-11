package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import androidx.compose.runtime.Composable
import androidx.compose.runtime.produceState
import androidx.compose.ui.platform.LocalContext
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.attack.CampaignArtwork
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/*
 * The authored campaign presentation (chapter names, epithets, lore, region names and stage names) for the Raid
 * chooser's CAMPAIGN tab (design/final/army/SPEC.md §6, campaign.png). It is the same bundled `pkw_campaign_presentation`
 * the full campaign map reads (FantasyCampaignScreen), parsed by the same `CampaignArtwork.read`. Presentation only: no
 * progress, costs or rewards come from here, and a missing or unreadable file leaves the server's own names in place.
 */

/** The bundled campaign presentation, read once off the main thread; null while reading and on any failure (the
 *  chooser then shows the server's names and a blank chapter line, never invented ones). Never throws into composition. */
@Composable internal fun rememberCampaignPresentation(): CampaignArtwork? {
    val context = LocalContext.current
    return produceState<CampaignArtwork?>(null, context) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                val text = context.resources.openRawResource(R.raw.pkw_campaign_presentation).bufferedReader().use { it.readText() }
                CampaignArtwork.read(text)
            }.getOrNull()
        }
    }.value
}

/** Stages per act, from the catalogue's `CAMPAIGN.stagesPerAct`: the exact source FantasyCampaignScreen uses to pick a
 *  stage's presentation name. Null when the pack does not state it (stage names then stay the server's). */
internal fun campaignPerAct(constants: JsonObject?): Int? =
    (constants?.get("CAMPAIGN") as? JsonObject)?.string("stagesPerAct")?.toIntOrNull()
