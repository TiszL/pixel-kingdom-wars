package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import gg.pixelkingdomwars.nativeclient.data.WorldEntry
import gg.pixelkingdomwars.nativeclient.scene.world.WorldEngineAdmission
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests

/**
 * LandGate's "choose your land on the map" (F5, GLOBE-NATIVE-PLAN §1.1 N4): queues the choose-land entry for the World tab
 * and [returnHome]s, where the scaffold switches to WORLD and the World screen consumes it. Only where the GL30 world is
 * admitted ([WorldEngineAdmission], the same rule the World tab uses); elsewhere null, and LandGate keeps its list picker
 * alone, as release builds have it today.
 */
@Composable fun rememberChooseOnMap(requests: HomeRequests, returnHome: () -> Unit): (() -> Unit)? {
    val context = LocalContext.current
    val admitted = remember { WorldEngineAdmission.refusal(context) == null }
    return if (!admitted) null else ({ requests.request(HomeRequest.World(WorldEntry.ChooseLand)); returnHome() })
}
