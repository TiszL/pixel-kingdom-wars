package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.CelebrationUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftAtlasLoop
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftAtlases
import kotlinx.coroutines.delay
import kotlin.math.cos
import kotlin.math.sin

/**
 * Design component: the Gold Forge celebration (design/final/goldforge SPEC §2 `Celebration`, §4d, §5c; `gems-sent.png`,
 * `claim-sent.png`): a wood frame with the dark `#1A120E` panel and turning sunrays, the authored reward-claim FX (64 art
 * at 128 dp, 8 frames at 12 fps, once) behind the token (`gem_64` at 64 dp, or the KEEP token at 72 dp), the 40 dp ribbon
 * (gem green for Gems, gold for KEEP) with its PS line, the VT 22 line and VT 18 "tap to continue". It plays only for a
 * receipt ([CelebrationUi.receiptId]), closes on a tap or after the system celebration time, and with reduced motion the
 * rays stand still, the ribbon does not drop and the FX is skipped.
 *
 * Drawing: the 18 ray wedges are one cached path per size; a frame only rotates it (no per-frame allocation).
 *
 * Pointer rule: the panel alone takes touches (a tap = continue); the caller draws the scrim under it.
 */
enum class ForgeCelebrationKind { GEMS, KEEP }

@Composable fun GoldForgeCelebration(ui: CelebrationUi?, kind: ForgeCelebrationKind, onDone: () -> Unit, modifier: Modifier = Modifier) {
    val done by rememberUpdatedState(onDone)
    Presence(ui, PkwTokens.Motion.RIBBON_DROP, PkwTokens.Motion.SEAL_OUT) { party, progress, active, reduced ->
        LaunchedEffect(party.receiptId) { delay(PkwTokens.Motion.CELEBRATE.toLong()); done() }
        val still = reduced || LocalInspectionMode.current
        val spin: State<Float>? = if (still) null else rememberInfiniteTransition(label = "forge-rays").animateFloat(0f, 360f,
            infiniteRepeatable(tween((360f / PkwTokens.Motion.RAYS_DEG_PER_S * 1000).toInt(), easing = LinearEasing), RepeatMode.Restart),
            label = "forge-spin")
        val drop = remember(party.receiptId) { Animatable(if (still) 1f else 0f) }
        LaunchedEffect(party.receiptId) { drop.animateTo(1f, tween(PkwTokens.Motion.RIBBON_DROP, easing = PkwTokens.Motion.Pop)) }
        Plate(PlateKind.WOOD, modifier.padding(horizontal = 28.dp).widthIn(max = 400.dp).fillMaxWidth()
            .graphicsLayer { alpha = progress() }
            .clearAndSetSemantics {
                contentDescription = "${party.ribbon}. ${party.line}"; liveRegion = LiveRegionMode.Polite; role = Role.Button
                onClick(label = "Continue") { if (active) done(); true }
            }
            .clickable(role = Role.Button) { if (active) done() }) {
            Box(Modifier.fillMaxWidth().heightIn(min = CELEBRATION_H).clipToBounds().forgeRays(spin)) {
                Column(Modifier.align(Alignment.Center).fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.size(128.dp), contentAlignment = Alignment.Center) {
                        if (!still) CraftAtlasLoop(CraftAtlases.rewardClaim, 12, 128.dp, Modifier.fillMaxSize(), once = true)
                        if (kind == ForgeCelebrationKind.GEMS) GfIcon("gf:gem_64", 64.dp) else GfIcon("gf:keep_48", 72.dp)
                    }
                    Box(Modifier.fillMaxWidth().heightIn(min = 40.dp)
                        .graphicsLayer { translationY = -12.dp.toPx() * (1f - drop.value) }
                        .drawBehind { drawForgeRibbon(kind) }
                        .padding(PaddingValues(horizontal = 10.dp, vertical = 6.dp)), contentAlignment = Alignment.Center) {
                        PkwText(party.ribbon, PkwTokens.Type.title, color = PkwTokens.Colors.label, outline = 2.dp,
                            textAlign = TextAlign.Center, maxLines = 1)
                    }
                    PkwText(party.line, PkwTokens.Type.lead, color = PkwTokens.Colors.text, textAlign = TextAlign.Center, maxLines = 2)
                    PkwText("tap to continue", PkwTokens.Type.small, color = PkwTokens.Colors.muted, textAlign = TextAlign.Center)
                }
            }
        }
    }
}

/** The panel's design height (SPEC §2: h 300 with the wood frame). */
private val CELEBRATION_H = 280.dp

/** Gem green ribbon (SPEC §2 Celebration: `#2FB879` / `#A9F0C8` / `#1B7A4D`). */
private val GEM_FACE = Color(0xFF2FB879)
private val GEM_HI = Color(0xFFA9F0C8)
private val GEM_LO = Color(0xFF1B7A4D)

/** Ray wedges: `#F4D77B` at 18 % (the system celebration's ray). */
private val CELEBRATION_RAY = Color(0xFFF4D77B).copy(alpha = 0.18f)

/** The dark panel and its 18 ten-degree wedges from a centre 42 % down: one path per size, rotated by [spin] when set. */
private fun Modifier.forgeRays(spin: State<Float>?): Modifier = drawWithCache {
    val center = Offset(size.width / 2f, size.height * 0.42f)
    val r = size.width + size.height
    val wedges = Path()
    for (k in 0 until 18) {
        val a0 = Math.toRadians(k * 20.0); val a1 = Math.toRadians(k * 20.0 + 10.0)
        wedges.moveTo(center.x, center.y)
        wedges.lineTo(center.x + (r * cos(a0)).toFloat(), center.y + (r * sin(a0)).toFloat())
        wedges.lineTo(center.x + (r * cos(a1)).toFloat(), center.y + (r * sin(a1)).toFloat())
        wedges.close()
    }
    onDrawBehind {
        drawRect(GoldForgeColors.wellFace)
        rotate(spin?.value ?: 0f, center) { drawPath(wedges, CELEBRATION_RAY) }
    }
}

/** The ribbon: an ink S shell 2 dp, the face, a 3 dp light top band and a 3 dp dark bottom band. */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawForgeRibbon(kind: ForgeCelebrationKind) {
    val face = if (kind == ForgeCelebrationKind.GEMS) GEM_FACE else PkwTokens.Colors.gold.face
    val hi = if (kind == ForgeCelebrationKind.GEMS) GEM_HI else PkwTokens.Colors.gold.hi
    val lo = if (kind == ForgeCelebrationKind.GEMS) GEM_LO else PkwTokens.Colors.gold.lo
    val w = size.width; val h = size.height; val i = 2.dp.toPx(); val b = 3.dp.toPx()
    fillStepped(0f, 0f, w, h, CornerProfiles.S, PkwTokens.Colors.ink)
    insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
        drawRect(face)
        band(i, w - i, i, b, hi)
        band(i, w - i, h - i - b, b, lo)
    }
}

@Preview(name = "Gold Forge celebration: Gems (gems-sent.png)", widthDp = 412, heightDp = 420)
@Composable private fun GoldForgeGemsCelebrationPreview() {
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.bg), contentAlignment = Alignment.Center) {
        GoldForgeCelebration(CelebrationUi("r1", "gf:gem_64", "+500 GEMS", "Added to your Gems"), ForgeCelebrationKind.GEMS, onDone = {})
    }
}

@Preview(name = "Gold Forge celebration: KEEP (claim-sent.png)", widthDp = 412, heightDp = 420)
@Composable private fun GoldForgeKeepCelebrationPreview() {
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.bg).height(420.dp), contentAlignment = Alignment.Center) {
        GoldForgeCelebration(CelebrationUi("r2", "gf:keep_48", "+1,240 KEEP", "In your wallet now"), ForgeCelebrationKind.KEEP, onDone = {})
    }
}
