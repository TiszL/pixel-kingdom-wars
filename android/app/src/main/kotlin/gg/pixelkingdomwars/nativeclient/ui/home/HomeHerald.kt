package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.model.HeraldUi

/** The herald's icon for a defence notice: the shield the HUD's own shield segment draws. */
internal const val HERALD_DEFENCE_ICON = "shield"

/**
 * The defence notice ([DefenceNotices.announce]) as the designed herald banner (hub SPEC §3.1, toasts.png top) in place
 * of the old header Notice bar. A tap opens the raid log (`hud.shield`, registry row 4, the Battle log), which is what
 * the notice asks the player to do. The key is the notice itself, so a new notice (another raid) restarts the banner's
 * 4 s and the same notice does not. No notice, no banner.
 */
internal fun homeHeraldUi(defenceNotice: String?): HeraldUi? = defenceNotice?.takeIf { it.isNotBlank() }?.let {
    HeraldUi(key = "defence:$it", icon = HERALD_DEFENCE_ICON, text = it, target = HudIds.SHIELD)
}
