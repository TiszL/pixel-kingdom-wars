package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.clearAndSetSemantics

/**
 * A piece of Home's top-left header that steps aside with the top-left cluster while a building is selected or placed
 * (buildings/SPEC.md §1.2 item 5, §4.1; owner screenshots 3 and 4, 2026-10-06, where the "TEST KINGDOM" tag stood beside
 * the name plate and under the placement hint). It keeps its layout space, so the header height, the scene padding and
 * the camera fit never move on a selection; it is only not drawn and not spoken. Paint only: it never took touches.
 */
internal fun Modifier.homeChromeHidden(hidden: Boolean): Modifier = if (hidden) this.alpha(0f).clearAndSetSemantics {} else this
