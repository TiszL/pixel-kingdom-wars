package gg.pixelkingdomwars.nativeclient.ui.goldforge

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.HeroStatusKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.HeroStatusUi

/*
 * The Home-mounted Gold Forge chrome around the sheet (design/final/goldforge/SPEC.md §1, §2 ErrorToast, §4 states,
 * E1.1): the error toast in the free top-left zone while the tall sheet is open (`error.png`), the LEGACY tab's bare hero
 * chip (`legacy.png`) and the one line the ready CLAIM says while collecting is not open here.
 */

/** SPEC E1.1 error wording. The frame's "Lost the server. Retrying…" is not used: the client does not retry by itself. */
internal const val GOLD_FORGE_OFFLINE = "The forge can't reach the server. Try again."

/** The ready CLAIM's reason (and its tap) while no claim owner can act from the Home sheet. */
internal const val GOLD_FORGE_CLAIM_CLOSED = "Collecting coins to your wallet is not open yet."

/** The error toast's message: a finished read pass with any failed read lost the server. A pass still in flight, or a
 *  clean one, shows no toast (the retained values stay on screen either way). */
internal fun goldForgeHomeAlert(data: GoldForgeHomeData): String? =
    if (!data.loading && data.failures.isNotEmpty()) GOLD_FORGE_OFFLINE else null

/** The LEGACY tab's hero (`legacy.png`): a lit furnace says "Furnace lit" only; every other status is unchanged. */
internal fun goldForgeLegacyHero(hero: HeroStatusUi): HeroStatusUi =
    if (hero.kind == HeroStatusKind.FORGING) hero.copy(bare = true) else hero

/** The free top-left zone a tall sheet leaves (SPEC §1, §7.8): x 8, y 10, w 272. */
private val GOLD_FORGE_TOAST_MAX_W = 272.dp

/**
 * The error toast (SPEC §2 ErrorToast, `error.png`): the system toast's blood body (the kit CHARCOAL plate tinted
 * blood, as the kit's error [gg.pixelkingdomwars.nativeclient.ui.kit.Toast]), 272 dp wide at most and 58 dp tall, a
 * 24 dp close icon, the message in up to two VT lines and a 48 dp stone REPORT. It stays until the host clears the alert
 * or [onClose] runs; it slides 12 dp and fades in over 160 ms (reduced motion: no slide).
 *
 * The close target is the icon together with the message (at least 48 × 48): the E1.1 sentence needs two 18 sp lines of
 * ~160 dp, which leaves no room for a separate 48 dp square beside REPORT inside 272 dp.
 *
 * Pointer rule: only the painted plate takes touches (the kit [Plate] and [ChunkyBox] mark their own scene-input
 * regions); nothing here is full-screen. The caller places it (TopStart, padding start 8, top 10).
 */
@Composable internal fun GoldForgeAlertToast(message: String, onReport: () -> Unit, onClose: () -> Unit,
    modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val still = reduced || LocalInspectionMode.current
    val shown = remember(message) { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(message) { shown.animateTo(1f, tween(PkwTokens.Motion.TOAST_IN, easing = PkwTokens.Motion.Out)) }
    Plate(PlateKind.CHARCOAL, modifier.widthIn(max = GOLD_FORGE_TOAST_MAX_W).heightIn(min = PkwTokens.Dims.toastH)
        .graphicsLayer {
            alpha = shown.value
            translationY = if (reduced) 0f else -PkwTokens.Motion.TOAST_SLIDE_DP * density * (1f - shown.value)
        }, contentPadding = PaddingValues(start = 9.dp, top = 5.dp, end = 6.dp, bottom = 5.dp), tint = PkwTokens.Colors.blood) {
        Row(Modifier.align(Alignment.CenterStart).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.weight(1f).heightIn(min = PkwTokens.Dims.minTap)
                .clearAndSetSemantics {
                    contentDescription = message; role = Role.Button; liveRegion = LiveRegionMode.Assertive
                    onClick(label = "Close") { onClose(); true }
                }
                .clickable(role = Role.Button, onClick = onClose), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwIcon("shape:close", 24.dp, tint = PkwTokens.Colors.text)
                PkwText(message, PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.text, maxLines = 2)
            }
            ChunkyBox(PkwTokens.Colors.stone, onReport, "Report", Modifier.height(PkwTokens.Dims.minTap).widthIn(min = 60.dp)) {
                PkwText("REPORT", PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
            }
        }
    }
}

@Preview(name = "Gold Forge error toast (error.png)", widthDp = 412, heightDp = 90)
@Composable private fun GoldForgeAlertToastPreview() {
    Box(Modifier.background(PkwTokens.Colors.bg).padding(start = 8.dp, top = 10.dp)) {
        GoldForgeAlertToast(GOLD_FORGE_OFFLINE, onReport = {}, onClose = {})
    }
}
