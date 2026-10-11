package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.ChipTone
import gg.pixelkingdomwars.nativeclient.ui.model.HeraldUi
import gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi

/*
 * The first Home of a landless player (design/final/account/onboard-first-home.png, account SPEC §1.2): the free camp in
 * the status chip and the one line about land as the herald. Pure display rules only; the mount step feeds them the
 * signed-in account's `landOwned` (null while the account is not signed in, so nothing is assumed).
 *
 * Not here: the designed tutorial coach (dashed rect + pointer on the Keep). It needs the Keep's screen bounds, which only
 * the renderer knows, and the server's tutorial is quest based, not the designed four steps; KingdomGuidance stays.
 */

/** The land herald's door: the Profile registry row that opens the designed land gate (the row Leagues' GET LAND uses). */
internal val LAND_HERALD_TARGET: FeatureId = FeatureId("profile.land")

/** The one line about land (SPEC §1.2). */
internal const val LAND_HERALD_TEXT = "Buy land to join the world map"

/** The status chip segment a free camp shows where a landed kingdom's shield time is (drawn lower case, SPEC §1.2). */
internal const val FREE_CAMP_VALUE = "free camp"

/**
 * The Home herald: a defence notice outranks everything (it asks the player to open the raid log), then the land line
 * for a player the server says has no land. Landed or unknown (signed out, account still loading) raises no land
 * herald: a paying player is never told to buy land.
 */
internal fun homeLandHeraldUi(landOwned: Boolean?, defenceNotice: String?): HeraldUi? {
    homeHeraldUi(defenceNotice)?.let { return it }
    return if (landOwned == false) HeraldUi(key = "land", icon = "itm_deed_earth", text = LAND_HERALD_TEXT, target = LAND_HERALD_TARGET)
    else null
}

/**
 * The free camp segment: only for a player the server says has no land, the shield segment reads "free camp" (its id
 * stays, so a tap still opens the defence log). A raided free camp keeps "RAIDED ×n": free camps fight free camps, and
 * the raid news must never be hidden behind the label. Landed and unknown players keep their shield unchanged.
 */
internal fun homeFreeCampHud(ui: HomeHudUi, landOwned: Boolean?): HomeHudUi {
    if (landOwned != false || ui.shield.tone == ChipTone.DANGER) return ui
    // onboard-first-home.png: the label stands alone in muted VT 20, no shield icon (a free camp has no shield), which is
    // also what lets "free camp" fit the 238 dp chip whole (with the icon it read "free c…" on the owner's phone).
    return ui.copy(shield = ui.shield.copy(icon = "", value = FREE_CAMP_VALUE,
        description = "Free camp: free camps only fight free camps. Opens the defence log", tone = ChipTone.QUIET))
}
