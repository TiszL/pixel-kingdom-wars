package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.SealUi

/**
 * Design component: the Seal / ConfirmDialog (DESIGN-SYSTEM §6), the one consent for every Gems, SOL, KEEP and SKR spend.
 * A centred wood frame on parchment over a 55 % scrim: PS title, pay → get with 48 dp tokens, VT lines, stone BACK and the
 * gold primary. The primary arms over 450 ms (an ink bar fills inside its lip) and ignores taps until [sealAccepts].
 * Enter: scale 0.96 → 1 + fade 160 ms; exit 120 ms.
 *
 * Pass the seal to show, or null to dismiss it (it animates out). Keep composing this SAME Seal with null through its
 * exit (do not remove it from composition when the state clears): [onExitFinished] then runs once, after the 120 ms exit,
 * when the seal is no longer painted. The OverlayHost keeps Back priority until then (design ruling 092decf3 item 5; no
 * guessed delay). Back is the OverlayHost's job (Seal is the highest Back priority; Back cancels, never confirms).
 *
 * Pointer rule: the root fills the screen only while a seal is shown or animating out; the scrim under it is a hit
 * region only while the seal is shown, and its tap cancels. With nothing shown nothing is composed, so touches reach the
 * kingdom. The host may lift the resource stack above this scrim (`PkwTokens.Z.RESOURCE_STACK`, `ResourceStack(enabled =
 * false)`): readable during consent, never tappable.
 */
@Composable fun Seal(ui: SealUi?, onConfirm: () -> Unit, onCancel: () -> Unit, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }, onExitFinished: () -> Unit = {}) {
    Presence(ui, PkwTokens.Motion.SEAL_IN, PkwTokens.Motion.SEAL_OUT, onGone = onExitFinished) { seal, progress, active, reduced ->
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            ModalScrim(PkwTokens.Scrim.SEAL * progress(), onTap = { if (active) onCancel() })
            Plate(PlateKind.WOOD, Modifier.padding(horizontal = 28.dp).widthIn(max = 380.dp).fillMaxWidth()
                .semantics { paneTitle = seal.title; liveRegion = LiveRegionMode.Assertive }
                .graphicsLayer {
                    val p = progress()
                    alpha = p
                    val s = if (reduced) 1f else 0.96f + 0.04f * p
                    scaleX = s; scaleY = s
                }) {
                Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                    // kit-2.png SEAL: PS 13 title; pay → get 8 dp below it; the VT lines; BACK + primary 10 dp below.
                    Column(Modifier.fillMaxWidth().padding(start = 6.dp, top = 5.dp, end = 6.dp, bottom = 6.dp),
                        horizontalAlignment = Alignment.CenterHorizontally) {
                        PkwText(seal.title, PkwTokens.Type.title, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
                        Row(Modifier.padding(top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            SealToken(seal.price)
                            seal.gets?.let { gets ->
                                PkwIcon("shape:go", 24.dp, tint = PkwTokens.Colors.textOnParch)
                                SealToken(gets)
                            }
                        }
                        seal.lines.forEach { line ->
                            PkwText(line, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center, maxLines = 3)
                        }
                        Row(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            SecondaryButton(seal.backLabel, { if (active) onCancel() }, Modifier.width(PkwTokens.Dims.sealBackW).height(SEAL_BUTTON_H))
                            ArmingPrimary(seal, active, onConfirm, clock, Modifier.weight(1f))
                        }
                    }
                }
            }
        }
    }
}

/** One 48 dp token and its amount (the pay or get side). */
@Composable private fun SealToken(price: PriceUi) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        PkwIcon(currencyIcon(price.currency, price.icon), 48.dp, contentDescription = priceDescription(price))
        PkwText(priceText(price), PkwTokens.Type.primary, color = if (price.status == PriceStatus.SHORT) PkwTokens.Colors.shortText else PkwTokens.Colors.textOnParch)
    }
}

/** The seal's two buttons are 56 tall (kit-2.png), a little taller than the 52 dp secondary. */
private val SEAL_BUTTON_H = 56.dp

/** The gold primary (PS 13) with its 450 ms arming bar: an ink fill over a 35 % ink track, 8 dp in from each side and
 *  9 dp above the bottom, inside the lip (kit-2.png). Taps before [sealAccepts] are ignored (never queued). */
@Composable private fun ArmingPrimary(seal: SealUi, active: Boolean, onConfirm: () -> Unit, clock: () -> Long, modifier: Modifier) {
    val arm = remember(seal.armedAtMs) { Animatable(sealArmFraction(clock(), seal.armedAtMs)) }
    LaunchedEffect(seal.armedAtMs) {
        val remaining = ((1f - arm.value) * PkwTokens.Motion.SEAL_ARM).toInt()
        if (remaining > 0) arm.animateTo(1f, tween(remaining, easing = PkwTokens.Motion.Linear))
    }
    ChunkyBox(PkwTokens.Colors.gold, { if (active && sealAccepts(clock(), seal.armedAtMs)) onConfirm() }, seal.confirmLabel,
        modifier.height(SEAL_BUTTON_H).drawWithContent {
            drawContent()
            val a = arm.value
            if (a < 1f) {
                val inset = 8.dp.toPx(); val h = 4.dp.toPx(); val y = size.height - 9.dp.toPx() - h
                drawRect(PkwTokens.Colors.ink.copy(alpha = 0.35f), Offset(inset, y), Size(size.width - 2 * inset, h))
                drawRect(PkwTokens.Colors.ink, Offset(inset, y), Size((size.width - 2 * inset) * a, h))
            }
        }, enabled = active) {
        PkwText(seal.confirmLabel, PkwTokens.Type.title, color = PkwTokens.Colors.label, outline = 2.dp)
    }
}

@Preview(name = "Seal", widthDp = 412, heightDp = 480)
@Composable private fun SealPreview() {
    Seal(SealUi("BUY 500 GEMS", listOf("Paid from your wallet. You sign once."), PriceUi(Currency.KEEP, "500", PriceStatus.OK), "BUY",
        armedAtMs = 0L, gets = PriceUi(Currency.GEMS, "500", PriceStatus.OK)), onConfirm = {}, onCancel = {})
}

