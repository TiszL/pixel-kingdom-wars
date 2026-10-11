package gg.pixelkingdomwars.nativeclient.ui.hud

import gg.pixelkingdomwars.nativeclient.ui.model.HeraldUi
import gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi

/**
 * The herald Home draws now: the HUD's herald at rest, none while a selection, a placement draft or a tray hides the deck
 * ([HomeHudUi.deckVisible] false). buildings/SPEC.md §1.2 item 5: "While selected: top-left cluster, edge buttons and world
 * markers hide; the resource stack stays"; §4.1 hides the top-left cluster in placement, where the band's hint pill takes
 * the herald's row. The herald's own queue is untouched, so a held line (the land herald) comes back with the deck.
 */
internal fun homeHeraldShown(ui: HomeHudUi): HeraldUi? = ui.herald.takeIf { ui.deckVisible }
